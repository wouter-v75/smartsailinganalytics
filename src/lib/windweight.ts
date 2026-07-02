// windweight.ts — "wind weight" index (observed), the TS mirror of the box's
// scripts/common/windweight.py. Given what we measure ON BOARD — masthead TWS,
// air temperature, RH and sea temperature — reconstruct the rig wind profile with
// Monin–Obukhov Similarity Theory (bulk route from ΔT = T_air − SST), integrate
// ½ρV² over the rig, and return WW% (100 = standard day) + the sub-factors + the
// profile. Used to (a) show an observed windweight alongside the forecast and
// (b) build the MOS join against the boat's heel residual. Keep constants in
// sync with windweight.py. See research 2026-07-02.

const KAPPA = 0.40
const G = 9.80665
const R_D = 287.05
const R_V = 461.5
const NU = 1.5e-5
const ALPHA_CH = 0.018
const RHO_REF = 1.20
const Z0_REF = 2e-4
const KN = 0.514444 // knots → m/s

export interface WWResult {
  ww: number // WW% (100 = standard)
  vEff: number // effective TWS, same units as input V_H
  vH: number
  cls: 'Light' | 'Standard' | 'Heavy'
  factors: { rho: number; profile: number; gust: number; funnel: number }
  inputs: { ustar: number; L: number; z0: number; rho: number; TI: number; dT: number | null }
  profile: Array<{ z: number; V: number }> // m/s over the rig
}

// ── thermodynamics ───────────────────────────────────────────────────────────
export function satVapourPressureHpa(tC: number): number {
  return 6.112 * Math.exp((17.67 * tC) / (tC + 243.5))
}
export function moistAirDensity(tC: number, rhFrac: number, pHpa: number): number {
  const tK = tC + 273.15
  const e = Math.max(0, Math.min(1, rhFrac)) * satVapourPressureHpa(tC)
  return ((pHpa - e) * 100) / (R_D * tK) + (e * 100) / (R_V * tK)
}

// ── MOST surface layer ───────────────────────────────────────────────────────
export function psiM(zeta: number): number {
  if (zeta < 0) {
    const x = Math.pow(1 - 16 * zeta, 0.25)
    return (
      2 * Math.log((1 + x) / 2) +
      Math.log((1 + x * x) / 2) -
      2 * Math.atan(x) +
      Math.PI / 2
    )
  }
  const a = 1, b = 2 / 3, c = 5, d = 0.35
  const z = Math.min(zeta, 7)
  return -(a * z + b * (z - c / d) * Math.exp(-d * z) + (b * c) / d)
}
export function charnockZ0(ustar: number): number {
  return (ALPHA_CH * ustar * ustar) / G + (0.11 * NU) / Math.max(ustar, 0.03)
}
export function mostWind(z: number, ustar: number, z0: number, L: number): number {
  const zz = Math.max(z, z0 * 1.01)
  const zeta = Math.abs(L) > 1e-6 ? zz / L : 0
  const zeta0 = Math.abs(L) > 1e-6 ? z0 / L : 0
  return Math.max(0, (ustar / KAPPA) * (Math.log(zz / z0) - psiM(zeta) + psiM(zeta0)))
}

// ── rig area weighting + integrals ───────────────────────────────────────────
export function rigWeight(z: number, H: number, centroidFrac = 0.38): number {
  if (z <= 0 || z >= H) return 0
  const top = Math.min(1, Math.max(0.5, 3 * centroidFrac))
  return Math.max(0, 1 - z / H / top)
}
function integrate(fn: (z: number) => number, H: number, n = 34): number {
  const dz = H / n
  let s = 0
  for (let i = 1; i <= n; i++) {
    const z0 = Math.max((i - 1) * dz, 1e-3)
    const z1 = i * dz
    s += 0.5 * (fn(z0) + fn(z1)) * dz
  }
  return s
}
function shearIntegral(vOfZ: (z: number) => number, H: number, vH: number, cf: number): number {
  if (vH <= 0) return 1
  const A = integrate((z) => rigWeight(z, H, cf), H)
  if (A <= 0) return 1
  const num = integrate((z) => rigWeight(z, H, cf) * Math.pow(vOfZ(z) / vH, 2), H)
  return num / A
}

// ── gust ─────────────────────────────────────────────────────────────────────
export function turbulenceIntensity(L: number): number {
  let zeta10 = Math.abs(L) > 1e-6 ? 10 / L : 0
  zeta10 = Math.max(-1, Math.min(1, zeta10))
  return Math.max(0.04, Math.min(0.25, 0.1 - 0.35 * zeta10))
}

function classify(ww: number): WWResult['cls'] {
  if (ww < 92) return 'Light'
  if (ww > 108) return 'Heavy'
  return 'Standard'
}

// ── observed windweight from on-board measurements ───────────────────────────
// vHKt = measured masthead TWS (kt); airTC, sstC °C; rhFrac 0..1; pHpa hPa.
// Uses the bulk route (ΔT = T_air − SST → stability), anchored at the MEASURED
// masthead speed, so the % reflects the same wind the crew reads.
export function windweightObserved(args: {
  vHKt: number
  airTC: number
  sstC: number
  rhFrac: number
  pHpa?: number
  H?: number
  centroidFrac?: number
  beta?: number
}): WWResult | null {
  const { vHKt, airTC, sstC, rhFrac } = args
  if (!(vHKt > 0) || !isFinite(airTC) || !isFinite(sstC)) return null
  const pHpa = args.pHpa ?? 1015
  const H = args.H ?? 34
  const cf = args.centroidFrac ?? 0.38
  const beta = args.beta ?? 0.15
  const vH = vHKt * KN // m/s
  const rho = moistAirDensity(airTC, rhFrac, pHpa)
  const dT = airTC - sstC

  // bulk Richardson at 10 m → ζ → L, then u* consistent with the masthead speed.
  const theta = airTC + 273.15
  const zRef = 10
  const RiB = (G * zRef * dT) / (theta * Math.max(vH, 0.5) ** 2)
  let zeta =
    RiB < 0 ? (10 * RiB) / (1 + RiB / -4.5) : (10 * RiB) / (1 - 5 * Math.min(RiB, 0.19))
  zeta = Math.max(-5, Math.min(5, zeta))
  const L = Math.abs(zeta) > 1e-3 ? zRef / zeta : 1e6
  // solve u* so MOST reproduces the measured masthead speed at H
  let z0 = 1.5e-4
  let ustar = (KAPPA * Math.max(vH, 0.5)) / Math.log(H / z0)
  for (let i = 0; i < 4; i++) {
    z0 = charnockZ0(ustar)
    const denom = Math.log(H / z0) - psiM(H / L) + psiM(z0 / L)
    ustar = (KAPPA * Math.max(vH, 0.5)) / Math.max(denom, 0.3)
  }
  const vOfZ = (z: number) => mostWind(z, ustar, z0, L)

  const fRho = rho / RHO_REF
  const Sact = shearIntegral(vOfZ, H, vH, cf)
  const vLog = (z: number) => {
    const zz = Math.max(z, Z0_REF * 1.01)
    return vH * (Math.log(zz / Z0_REF) / Math.log(H / Z0_REF))
  }
  const Sref = shearIntegral(vLog, H, vH, cf)
  const fProfile = Sref > 0 ? Sact / Sref : 1
  const TI = turbulenceIntensity(L)
  const Gf = 1 + 2.5 * TI
  const fGust = 1 + beta * (Gf * Gf - 1)
  const fFunnel = 1 // observed: no funnel term (that's a model/grid diagnostic)

  const ww = 100 * fRho * fProfile * fGust * fFunnel
  const vEff = vHKt * Math.sqrt(Math.max(ww, 1) / 100) // back to knots
  const heights = [5, 10, 15, 25, 34]
  return {
    ww: Math.round(ww * 10) / 10,
    vEff: Math.round(vEff * 100) / 100,
    vH: Math.round(vHKt * 100) / 100,
    cls: classify(ww),
    factors: {
      rho: round4(fRho),
      profile: round4(fProfile),
      gust: round4(fGust),
      funnel: round4(fFunnel),
    },
    inputs: { ustar: round4(ustar), L: Math.round(L * 10) / 10, z0: round6(z0), rho: round4(rho), TI: round4(TI), dT: Math.round(dT * 100) / 100 },
    profile: heights.map((z) => ({ z, V: Math.round(vOfZ(z) * 100) / 100 })),
  }
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4
const round6 = (x: number) => Math.round(x * 1e6) / 1e6

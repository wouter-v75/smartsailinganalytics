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
  cls: 'Light' | 'Standard' | 'Heavy' | 'Calm'
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

const CALM_MS = 2.0 // ~4 kt: rig unloaded, WW ratio (÷ V_H) ill-conditioned → "Calm"
function classify(ww: number, vHms?: number): WWResult['cls'] {
  if (vHms != null && vHms < CALM_MS) return 'Calm'
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
  let fProfile = Sref > 0 ? Sact / Sref : 1
  fProfile = Math.max(0.5, Math.min(1.5, fProfile)) // bound: near-calm can spike (V/V_H)²
  const TI = turbulenceIntensity(L)
  const Gf = 1 + 2.5 * TI
  const fGust = 1 + beta * (Gf * Gf - 1)
  const fFunnel = 1 // observed: no funnel term (that's a model/grid diagnostic)

  let ww = 100 * fRho * fProfile * fGust * fFunnel
  ww = Math.max(45, Math.min(155, ww)) // keep the index in a physically sane band
  const vEff = vHKt * Math.sqrt(Math.max(ww, 1) / 100) // back to knots
  const heights = [5, 10, 15, 25, 34]
  return {
    ww: Math.round(ww * 10) / 10,
    vEff: Math.round(vEff * 100) / 100,
    vH: Math.round(vHKt * 100) / 100,
    cls: classify(ww, vH),
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

// ── windweight from a MODELLED profile (the TS counterpart of the box's
//    windweight.py::windweight_from_profile) ──────────────────────────────────
//
// Why this exists: the box publishes windweight.json from a BOX-AVERAGED profile,
// which (a) is not where the crew is racing and (b) averages u/v as vectors, so
// horizontal directional spread cancels and V_H reads several knots low by midday.
// The venue grid the app already holds carries wind SPEED per height at every
// cell, so we can redo the profile term at POINT 1 and anchor it to the MOS
// masthead speed — the same wind the tables and the map show.
//
// Only the shape term is recomputed here. Density and gust are near-uniform across
// a 30 km race box and need T/RH/p and turbulence the app does not carry at point
// 1, so those factors are passed straight through from the published product.
//
// Speeds are m/s at `heightsM` (ascending). Directional shear is deliberately NOT
// an input: load at each height is set by the local wind SPEED, and the sail is
// twisted to the local direction — veer is a tack asymmetry, reported separately.
export interface ProfileWW {
  ww: number                       // WW% (100 = standard day)
  vHKt: number                     // masthead speed the index is anchored to
  vEffKt: number                   // vH * sqrt(ww/100)
  fProfile: number
  cls: WWResult['cls']
  profile: Array<{ z: number; V: number }>
}

// V(z) through the rig from published levels. Between levels: linear in
// log-height (the surface layer is logarithmic, so this beats linear-in-z).
// BELOW the lowest level: a neutral log law with an EFFECTIVE roughness fitted to
// the two lowest levels, so the near-surface fill reproduces the shear the model
// actually has instead of assuming open-sea z0. A power law extrapolated to the
// deck starves the bottom of the rig and biases f_profile low.
export function profileReader(heightsM: number[], speedsMs: number[]): ((z: number) => number) | null {
  const pts = heightsM
    .map((h, i) => ({ h, v: speedsMs[i] }))
    .filter((p) => p.h > 0 && p.v != null && isFinite(p.v) && p.v >= 0)
    .sort((a, b) => a.h - b.h)
  if (!pts.length) return null
  if (pts.length === 1) return () => pts[0].v

  const lo = pts[0]
  const nx = pts[1]
  // u*/kappa and z0 from the two lowest levels; clamped to a sane band so a
  // near-uniform or inverted pair cannot produce a nonsense roughness.
  let slope = (nx.v - lo.v) / (Math.log(nx.h) - Math.log(lo.h))
  let z0eff = Number.NaN
  if (slope > 1e-6) z0eff = Math.exp(Math.log(lo.h) - lo.v / slope)
  if (!isFinite(z0eff) || z0eff <= 0) { z0eff = Z0_REF; slope = lo.v / Math.log(lo.h / Z0_REF) }
  z0eff = Math.min(Math.max(z0eff, 1e-5), 5)

  return (z: number) => {
    const zz = Math.max(z, 1e-3)
    if (zz <= lo.h) {
      if (zz <= z0eff) return 0
      return Math.max(0, slope * Math.log(zz / z0eff))
    }
    for (let i = 0; i < pts.length - 1; i++) {
      if (zz <= pts[i + 1].h) {
        const a = pts[i]; const b = pts[i + 1]
        const f = (Math.log(zz) - Math.log(a.h)) / (Math.log(b.h) - Math.log(a.h))
        return a.v + f * (b.v - a.v)
      }
    }
    return pts[pts.length - 1].v          // above the top level: clamp, never extrapolate
  }
}

export function windweightFromProfile(args: {
  heightsM: number[]
  speedsMs: number[]
  H?: number
  centroidFrac?: number
  fRho?: number
  fGust?: number
  fFunnel?: number
  // MOS-corrected masthead speed in KNOTS. MOS is a single-height scalar fit, so it
  // must anchor the column, never be applied level by level (its additive term would
  // distort the shape). A uniform rescale leaves V(z)/V_H untouched, so f_profile —
  // and therefore WW% — is unchanged by MOS; only V_eff moves with it.
  vHKtOverride?: number
}): ProfileWW | null {
  const H = args.H ?? 34
  const cf = args.centroidFrac ?? 0.38
  const vOfZ = profileReader(args.heightsM, args.speedsMs)
  if (!vOfZ) return null
  const vHms = vOfZ(H)
  if (!(vHms > 0)) return null

  const sAct = shearIntegral(vOfZ, H, vHms, cf)
  const vLog = (z: number) => {
    const zz = Math.max(z, Z0_REF * 1.01)
    return vHms * (Math.log(zz / Z0_REF) / Math.log(H / Z0_REF))
  }
  const sRef = shearIntegral(vLog, H, vHms, cf)
  if (!(sRef > 0)) return null
  const fProfile = sAct / sRef

  const ww = 100 * (args.fRho ?? 1) * fProfile * (args.fGust ?? 1) * (args.fFunnel ?? 1)
  const vHKt = args.vHKtOverride != null && args.vHKtOverride > 0 ? args.vHKtOverride : vHms * 1.94384
  const vEffKt = vHKt * Math.sqrt(Math.max(ww, 1) / 100)

  const zs = [1, 5, 10, 15, 20, 25, H].filter((z, i, a) => z <= H && a.indexOf(z) === i)
  return {
    ww: round4(ww),
    vHKt: round4(vHKt),
    vEffKt: round4(vEffKt),
    fProfile: round4(fProfile),
    cls: classify(ww, vHms),
    profile: zs.map((z) => ({ z, V: round6(vOfZ(z)) })),
  }
}

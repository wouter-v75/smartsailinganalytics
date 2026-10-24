// The wind profile between two heights, with stability.
//
// WHY THIS EXISTS. SSA needs the wind at a masthead (20-35 m) from a model or a
// station that reports at 10 m, and the neutral log law — which is what the
// code used everywhere until now — is wrong in the one regime that matters
// most to a sailor. Derived and then independently reproduced here:
//
//   U10 = 10 kn, air 2 K warmer than the sea — an ordinary offshore-breeze
//   morning — gives a 10→30 m increase of +29.7 % where the neutral log law
//   says +8.4 %. The neutral answer is 10.84 kn at the masthead when the truth
//   is 12.97: a 2.1 kn, 16 % UNDERESTIMATE.
//
// THE ERROR SHRINKS WITH WIND SPEED, because mechanical mixing wins: the same
// +2 K at 20 kn costs only 0.97 kn (4.4 %). So this matters most in light air,
// which is exactly where a sailing forecast's percentage errors are already
// worst.
//
// THE UNSTABLE BRANCH IS NEARLY HARMLESS: cold air over warm water moves the
// ratio by −2.7 % to −5 % across every realistic ΔT, i.e. 0.3-0.7 kn. If one
// branch had to be ignored it is that one. The stable branch is open-ended.
//
// ROUGHNESS BARELY MATTERS AT 30 m, which is worth knowing before anyone
// spends effort on it: the full 5→30 kn range of marine roughness moves the
// 10→30 m ratio only from 1.084 to about 1.10, and COARE 3.0 against COARE 3.5
// disagree on z0 by a factor of two and on the ratio by 0.4 %. Stability is
// the term to get right; Charnock is a detail.
//
// VALIDATION. This module's ratios were checked against an independently
// derived table (COARE 3.5 roughness, same ψ functions) and agree to within
// 0.004 on every row — 1.295 against 1.297 at 10 kn/+2 K, 1.344 against 1.343
// at 6 kn/+1 K, 1.052 against 1.048 at 10 kn/−2 K. The residual is the
// roughness scheme: this uses plain Charnock with α = 0.011 rather than COARE
// 3.5's wind-dependent α, which is the 0.4 % mentioned above. The test file
// pins those numbers.
//
// WHAT IT IS NOT. Monin-Obukhov similarity describes the SURFACE LAYER, and in
// stable conditions over water that layer can be only 5-15 m deep — so a 30 m
// target may sit outside the theory being applied to it. That is the largest
// correction, applied where it is least entitled to be, and it is the reason
// `quality` exists on the result rather than a bare number. Past z/L ≈ 1 the
// honest statement is a BOUND — the masthead wind can be 25-40 % above the
// 10 m wind and no surface-layer theory will pin it down better.

/** von Kármán. */
const KAPPA = 0.4
const G = 9.81
/** Kinematic viscosity of air, m²/s. */
const NU = 1.5e-5
/** Reference potential temperature, K. Only the ratio matters, so 288 is fine. */
const THETA_REF = 288
/** Charnock's constant. COARE 3.0's default; see the roughness note above. */
export const CHARNOCK = 0.011

// ── the psi functions ──────────────────────────────────────────────────────
//
// Unstable: Paulson (1970), the integral of the Businger-Dyer
// phi_m = (1 - 16 zeta)^(-1/4).
//
// Stable: Holtslag & De Bruin (1988) / Beljaars & Holtslag (1991), with
// a = 1, b = 0.667, c = 5, d = 0.35 — the form operational codes implement.
// THE STABLE SIDE HAS NO CONSENSUS, which is itself worth knowing: at
// z/L = 0.5 this form gives a 10→30 m ratio of 1.305 where the simple linear
// psi_m = -5 zeta gives 1.386, a 6 % disagreement from the choice of formula
// alone, rising to 16 % at z/L = 1. Beljaars-Holtslag is the defensible
// default because the linear form is only claimed valid for 0 < zeta < 1.

const BH_A = 1, BH_B = 0.667, BH_C = 5, BH_D = 0.35

export function psiM(zeta: number): number {
  if (!Number.isFinite(zeta) || zeta === 0) return 0
  if (zeta < 0) {
    const x = Math.pow(1 - 16 * zeta, 0.25)
    return 2 * Math.log((1 + x) / 2) + Math.log((1 + x * x) / 2) - 2 * Math.atan(x) + Math.PI / 2
  }
  return -(BH_A * zeta + BH_B * (zeta - BH_C / BH_D) * Math.exp(-BH_D * zeta) + (BH_B * BH_C) / BH_D)
}

export function psiH(zeta: number): number {
  if (!Number.isFinite(zeta) || zeta === 0) return 0
  if (zeta < 0) return 2 * Math.log((1 + Math.sqrt(1 - 16 * zeta)) / 2)
  return -(Math.pow(1 + (2 * BH_A * zeta) / 3, 1.5)
    + BH_B * (zeta - BH_C / BH_D) * Math.exp(-BH_D * zeta) + (BH_B * BH_C) / BH_D - 1)
}

/** Marine roughness from friction velocity: Charnock plus the smooth-flow term. */
export function charnockZ0(uStarMs: number): number {
  const u = Math.max(uStarMs, 1e-4)
  return (CHARNOCK * u * u) / G + (0.11 * NU) / u
}

/** COARE's scalar roughness, for the heat flux that sets the Obukhov length. */
function scalarZ0(uStarMs: number, z0: number): number {
  const reR = Math.max((uStarMs * z0) / NU, 1e-6)
  return Math.min(1.6e-4, 5.8e-5 / Math.pow(reR, 0.72))
}

export type Regime = 'stable' | 'unstable' | 'neutral'

export interface SurfaceLayer {
  /** Friction velocity, m/s. */
  uStarMs: number
  /** Obukhov length, m. Positive = stable, negative = unstable, Infinity = neutral. */
  lengthM: number
  /** z/L at 10 m — the number that says whether the theory still applies. */
  zOverL10: number
  z0: number
  regime: Regime
}

export interface SolveOptions {
  /** Height the wind is given at, metres. */
  refZ?: number
  /** Fixed roughness, metres. Omit over water and Charnock is iterated instead. */
  z0?: number
  iterations?: number
}

/**
 * Close the bulk problem: given a wind speed and an air-minus-surface
 * temperature difference, find u*, the Obukhov length and the roughness.
 *
 * `deltaK` is air MINUS water (or ground). **POSITIVE IS STABLE** — warm air
 * over a cooler surface, the offshore-breeze case. Getting that sign backwards
 * turns the largest correction in the model into the smallest one, in the
 * direction that looks plausible, which is why it is spelled out here.
 */
export function solveSurfaceLayer(
  speedMs: number,
  deltaK: number,
  opts: SolveOptions = {},
): SurfaceLayer {
  const refZ = opts.refZ ?? 10
  const iterations = opts.iterations ?? 60
  const fixedZ0 = opts.z0

  if (!(speedMs > 0) || !Number.isFinite(refZ) || refZ <= 0) {
    return { uStarMs: 0, lengthM: Infinity, zOverL10: 0, z0: fixedZ0 ?? 1e-4, regime: 'neutral' }
  }

  let z0 = fixedZ0 ?? 1e-4
  let L = Infinity
  let uStar = (KAPPA * speedMs) / Math.log(refZ / z0)

  for (let i = 0; i < iterations; i++) {
    const zL = Number.isFinite(L) ? refZ / L : 0
    const z0L = Number.isFinite(L) ? z0 / L : 0
    const denom = Math.log(refZ / z0) - psiM(zL) + psiM(z0L)
    // A collapsed or inverted denominator means the profile has gone past what
    // MOST describes; stop rather than produce a confident absurdity.
    if (!(denom > 0.1)) break
    uStar = (KAPPA * speedMs) / denom
    if (fixedZ0 == null) z0 = charnockZ0(uStar)

    const z0t = scalarZ0(uStar, z0)
    const dh = Math.log(refZ / z0t) - psiH(zL) + psiH(Number.isFinite(L) ? z0t / L : 0)
    if (!(dh > 0.1)) break
    const tStar = (KAPPA * deltaK) / dh
    L = Math.abs(tStar) < 1e-9
      ? Infinity
      : (uStar * uStar * THETA_REF) / (KAPPA * G * tStar)
  }

  const zOverL10 = Number.isFinite(L) ? 10 / L : 0
  return {
    uStarMs: uStar,
    lengthM: L,
    zOverL10,
    z0,
    regime: !Number.isFinite(L) || Math.abs(zOverL10) < 1e-3 ? 'neutral' : zOverL10 > 0 ? 'stable' : 'unstable',
  }
}

/** The dimensionless profile function at one height. */
function phi(z: number, z0: number, L: number): number {
  const zL = Number.isFinite(L) ? z / L : 0
  const z0L = Number.isFinite(L) ? z0 / L : 0
  return Math.log(z / z0) - psiM(zL) + psiM(z0L)
}

/** Ratio of wind speed at `toZ` to that at `fromZ`. */
export function profileRatio(toZ: number, fromZ: number, z0: number, L: number): number {
  if (!(toZ > 0) || !(fromZ > 0) || !(z0 > 0)) return 1
  const a = phi(fromZ, z0, L)
  if (!(a > 0.1)) return 1
  return phi(toZ, z0, L) / a
}

/** The neutral log-law ratio — what the code did before this module. */
export function neutralRatio(toZ: number, fromZ: number, z0: number): number {
  return profileRatio(toZ, fromZ, z0, Infinity)
}

export type ProfileQuality =
  /** Inside the surface layer and inside MOST's stated range. */
  | 'ok'
  /** Strongly stable, or a target high in a shallow stable layer: a bound, not a number. */
  | 'marginal'
  /** Past where surface-layer theory says anything useful. */
  | 'beyond-theory'

export interface Transfer {
  kn: number
  /** The neutral answer, for comparison and for reporting what stability bought. */
  neutralKn: number
  ratio: number
  regime: Regime
  zOverL: number
  quality: ProfileQuality
  /** Fractional 1-sigma uncertainty on `kn`, as a proportion. */
  uncertainty: number
  /** Plain-language reason when quality is not 'ok'. */
  note: string | null
}

/**
 * Stable surface layers over water are SHALLOW — 5-15 m where the boundary
 * layer is 50-150 m — so a masthead target can sit outside the layer the
 * theory describes. Past this the result is reported as a bound.
 */
export const STABLE_SURFACE_LAYER_M = 15

/**
 * Carry a wind speed from one height to another through the stability-corrected
 * profile, and say how much to trust it.
 *
 * The uncertainty is deliberately coarse: ~5 % when the correction is small and
 * well inside the theory, widening to 20 % once z/L passes 1, because at that
 * point the literature's own answer is a range and pretending otherwise would
 * be the error this module exists to remove.
 */
export function transferWind(
  speedKn: number,
  fromZ: number,
  toZ: number,
  layer: SurfaceLayer,
): Transfer {
  const { z0, lengthM: L, regime } = layer
  const ratio = profileRatio(toZ, fromZ, z0, L)
  const nRatio = neutralRatio(toZ, fromZ, z0)
  const zOverL = Number.isFinite(L) ? toZ / L : 0

  let quality: ProfileQuality = 'ok'
  let uncertainty = 0.05
  let note: string | null = null

  if (Math.abs(zOverL) > 2) {
    quality = 'beyond-theory'
    uncertainty = 0.2
    note = `z/L = ${zOverL.toFixed(2)} at ${toZ} m: past where surface-layer similarity says anything useful. `
      + 'Read the result as a bound — the masthead wind can be 25-40 % above the 10 m wind and no '
      + 'surface-layer theory will pin it down better.'
  } else if (regime === 'stable' && toZ > STABLE_SURFACE_LAYER_M) {
    quality = 'marginal'
    uncertainty = 0.12
    note = `stable, and ${toZ} m is above the ${STABLE_SURFACE_LAYER_M} m a stable marine surface layer `
      + 'typically reaches, so the largest correction here is being applied where the theory is least '
      + 'entitled to be.'
  } else if (Math.abs(zOverL) > 0.5) {
    quality = 'marginal'
    uncertainty = 0.1
    note = `z/L = ${zOverL.toFixed(2)}: the stable psi functions disagree by 6-16 % in this range, so the `
      + 'choice of formula is itself a source of error.'
  }

  return {
    kn: speedKn * ratio,
    neutralKn: speedKn * nRatio,
    ratio,
    regime,
    zOverL,
    quality,
    uncertainty,
    note,
  }
}

/**
 * The whole job in one call: a 10 m wind and an air-sea temperature difference
 * to a masthead wind.
 *
 * `deltaK` POSITIVE means the air is warmer than the water — stable, the big
 * correction. Pass null when nothing knows the temperatures, and the neutral
 * answer comes back with the uncertainty widened to say so: ignoring stability
 * is not a neutral choice, it is a LOW-BIASED one, by about 9 % on average and
 * 16 % on a light offshore morning.
 */
export function mastheadWind(
  speedKn: number,
  fromZ: number,
  toZ: number,
  deltaK: number | null,
  opts: SolveOptions = {},
): Transfer {
  const speedMs = speedKn * 0.514444
  if (deltaK == null || !Number.isFinite(deltaK)) {
    const layer = solveSurfaceLayer(speedMs, 0, { ...opts, refZ: fromZ })
    const t = transferWind(speedKn, fromZ, toZ, layer)
    return {
      ...t,
      quality: 'marginal',
      uncertainty: 0.09,
      note: 'no air-sea temperature difference available, so this is the NEUTRAL profile. That is not a '
        + 'neutral assumption: ignoring stability biases the masthead wind LOW, by around 9 % typically '
        + 'and 16 % on a light offshore-breeze morning.',
    }
  }
  const layer = solveSurfaceLayer(speedMs, deltaK, { ...opts, refZ: fromZ })
  return transferWind(speedKn, fromZ, toZ, layer)
}

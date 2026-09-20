// src/lib/wind/compassCalibration.ts
// ─────────────────────────────────────────────────────────────────────────────
// Per-device compass offset and leeway, from the track alone.
//
// `crab = COG − HDG` decomposes on opposite upwind tacks:
//
//   • the part that FLIPS SIGN between tacks is LEEWAY
//   • the TACK-INDEPENDENT part is a COMPASS OFFSET
//
//     δ      = −(crab_a + crab_b) / 2
//     leeway =  (crab_a − crab_b) / 2
//
// Measured on two real Atlas units sailing together (Palma, 8 Feb 2026): offsets
// of −5.1° and −14.5°, leeway 1.8° and 5.3°. It cross-validates — those offsets
// predict a 9.4° disagreement in heading-derived TWD between the boats, and the
// independent symmetry fits measured 10.2°. (TWD doc §17.)
//
// ── THE DEGENERACY, which decides when this may be used ───────────────────────
// A CROSS-WIND CURRENT PRODUCES EXACTLY THE SAME TACK-INDEPENDENT SIGNATURE AS A
// COMPASS OFFSET. They are algebraically indistinguishable here. In Palma in
// February the tide is negligible, so the common mode is attributable to the
// compass; in the Solent the same −14.5° could be half a knot of cross-tide.
//
// So: CALIBRATE ON NON-TIDAL DAYS, then carry the offsets to tidal venues —
// where a calibrated compass becomes valuable again, because COG − HDG then
// measures the current, which is the L4 input. `requireNonTidal` is on by
// default and a caller must pass evidence to proceed.
// ─────────────────────────────────────────────────────────────────────────────

import { angleDiff } from './circular'
import type { Segment } from './segment'

export interface CalibrationInput {
  segments: Segment[]
  /** Ground TWD for the session, from estimateTwd. */
  twdDeg: number
  /**
   * Cross-wind current in knots, if known — from oceanCurrent. Calibration is
   * only valid when this is small, because current and compass error are
   * indistinguishable in this decomposition.
   */
  crossCurrentKn?: number | null
  /** Refuse to calibrate when the venue may be tidal. Default true. */
  requireNonTidal?: boolean
  /** |TWA| window counted as upwind. */
  upwindDeg?: number
  /** Minimum steady seconds required on each tack. */
  minSecondsPerTack?: number
}

export interface Calibration {
  /**
   * The device reads this much HIGH. Subtract it to get true heading:
   * `hdgTrue = hdgLogged − offsetDeg`, which is what `correctHeading` does.
   * Real values: −5.1° and −14.4° for the two Atlas units, i.e. both read low.
   */
  offsetDeg: number
  /** Leeway magnitude, degrees. */
  leewayDeg: number
  /** Steady seconds behind each tack's mean. */
  secondsPerTack: [number, number]
  /** Segments used. */
  segments: number
  /**
   * Rough uncertainty. With ~20 segments per tack the offsets were good to
   * about ±2–3°, so this is deliberately not reported to the decimal.
   */
  uncertaintyDeg: number
}

export type CalibrationResult =
  | { ok: true; calibration: Calibration }
  | { ok: false; reason: string }

/**
 * Cross-wind current above which the decomposition cannot separate current from
 * compass error at the precision the offset is wanted to. 0.15 kn is the figure
 * from the current doc §1: it is also what a ~1° TWD target demands.
 */
export const NON_TIDAL_LIMIT_KN = 0.15

export function solveCompassOffset(input: CalibrationInput): CalibrationResult {
  const upwindDeg = input.upwindDeg ?? 70
  const minPerTack = input.minSecondsPerTack ?? 120
  const requireNonTidal = input.requireNonTidal ?? true

  if (requireNonTidal) {
    const c = input.crossCurrentKn
    if (c == null) {
      return { ok: false, reason: 'cross-wind current unknown — cannot separate it from compass error' }
    }
    if (Math.abs(c) > NON_TIDAL_LIMIT_KN) {
      return {
        ok: false,
        reason: `cross-wind current ${Math.abs(c).toFixed(2)} kn is indistinguishable from a compass ` +
          `offset — calibrate on a non-tidal day instead`,
      }
    }
  }

  // Upwind segments that carry BOTH bearings.
  const up = input.segments.filter(
    (s) => s.hdg != null && Math.abs(angleDiff(s.bearing, input.twdDeg)) < upwindDeg)
  const a = up.filter((s) => angleDiff(s.bearing, input.twdDeg) > 0)
  const b = up.filter((s) => angleDiff(s.bearing, input.twdDeg) < 0)

  const secs = (list: Segment[]) => list.reduce((x, s) => x + s.dur, 0)
  const secA = secs(a), secB = secs(b)
  if (secA < minPerTack || secB < minPerTack) {
    return {
      ok: false,
      reason: `needs ${minPerTack} s upwind on each tack, has ${Math.round(secA)} s and ${Math.round(secB)} s`,
    }
  }

  const meanCrab = (list: Segment[]) =>
    list.reduce((x, s) => x + angleDiff(s.bearing, s.hdg as number) * s.dur, 0) / secs(list)

  const crabA = meanCrab(a), crabB = meanCrab(b)
  const offsetDeg = -(crabA + crabB) / 2
  const leewayDeg = Math.abs((crabA - crabB) / 2)

  // Spread of per-segment crab about its tack mean, as a rough standard error.
  const resid = [...a, ...b].map((s) =>
    angleDiff(s.bearing, s.hdg as number) - (angleDiff(s.bearing, input.twdDeg) > 0 ? crabA : crabB))
  const sd = Math.sqrt(resid.reduce((x, v) => x + v * v, 0) / Math.max(1, resid.length))
  const uncertaintyDeg = Math.max(1, sd / Math.sqrt(Math.max(1, up.length)))

  return {
    ok: true,
    calibration: {
      offsetDeg, leewayDeg,
      secondsPerTack: [secA, secB],
      segments: up.length,
      uncertaintyDeg,
    },
  }
}

/** Apply a stored offset to a logged heading, giving true heading. */
export const correctHeading = (hdgDeg: number, offsetDeg: number): number =>
  ((hdgDeg - offsetDeg) % 360 + 360) % 360

/**
 * Predicted disagreement in heading-derived TWD between two calibrated devices.
 * This is the cross-check that validated the whole decomposition: it predicted
 * 9.4° where the independent symmetry fits measured 10.2°.
 */
export const predictedHeadingDisagreement = (a: Calibration, b: Calibration): number =>
  a.offsetDeg - b.offsetDeg

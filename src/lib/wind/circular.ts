// src/lib/wind/circular.ts
// ─────────────────────────────────────────────────────────────────────────────
// Circular statistics for bearings, in degrees.
//
// Everything in the wind work is an angle, and every angle wraps. Averaging
// 350° and 10° arithmetically gives 180° — pointing the opposite way — so the
// mean is taken as a vector. `circularR` doubles as the steadiness measure the
// segmenter and the estimator both key off.
//
// startAnalysis.ts has its own private circularMean for the start line; this is
// the shared one for the wind pipeline. They are deliberately not merged yet —
// that file's fixture tests pin the N76 behaviour and are not worth disturbing
// for a refactor with no user-visible effect.
// ─────────────────────────────────────────────────────────────────────────────

const D = Math.PI / 180

/** Vector mean of bearings, degrees in [0, 360). NaN for an empty list. */
export function circularMean(deg: number[]): number {
  if (!deg.length) return NaN
  let x = 0, y = 0
  for (const v of deg) { x += Math.cos(v * D); y += Math.sin(v * D) }
  return (Math.atan2(y, x) / D + 360) % 360
}

/**
 * Resultant length, 0..1. 1 = every bearing identical, 0 = uniformly spread.
 * Used as "how straight was this" and "how much do these estimates agree".
 */
export function circularR(deg: number[]): number {
  if (!deg.length) return 0
  let x = 0, y = 0
  for (const v of deg) { x += Math.cos(v * D); y += Math.sin(v * D) }
  return Math.hypot(x, y) / deg.length
}

/** Signed difference a − b, in (−180, 180]. */
export function angleDiff(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180
}

/** Normalise to [0, 360). */
export function norm360(a: number): number {
  return ((a % 360) + 360) % 360
}

/**
 * Circular standard deviation in degrees, from the resultant length.
 * Small when the estimates agree; the natural confidence measure here.
 */
export function circularSd(deg: number[]): number {
  const r = circularR(deg)
  if (r <= 0) return Infinity
  if (r >= 1) return 0
  return Math.sqrt(-2 * Math.log(r)) / D
}

/** Weighted vector mean — weights are typically segment durations. */
export function circularMeanWeighted(deg: number[], weight: number[]): number {
  if (!deg.length) return NaN
  let x = 0, y = 0, w = 0
  for (let i = 0; i < deg.length; i++) {
    const k = weight[i] ?? 1
    x += k * Math.cos(deg[i] * D); y += k * Math.sin(deg[i] * D); w += k
  }
  if (!w) return NaN
  return (Math.atan2(y, x) / D + 360) % 360
}

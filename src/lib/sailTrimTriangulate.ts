// src/lib/sailTrimTriangulate.ts
// ─────────────────────────────────────────────────────────────────────────────
// Where a target ACTUALLY sits, fore-and-aft, from several views of it.
//
// One stern shot cannot see depth: the camera looks along the boat, so a point
// 6 m aft and a point 8 m aft land in nearly the same place. Everything is
// therefore corrected using a depth the rig model GUESSES — the main's leech at
// -6000 ± 2500 mm for every height, when the truth is a leech sweeping forward
// as it rises. That single number is the largest error in the whole tool,
// because ψ's correction is multiplied by it: a degree of ψ is worth 17 mm for
// every metre a target sits abaft the mast.
//
// Two views at different ψ fix it, and three leave a residual worth reading.
// For a target at athwartships Y and depth D, each frame's raw image offset is
//
//     raw = Y·cos ψ − D·sin ψ
//
// which is LINEAR in Y and D. Three frames over-determine two unknowns, so a
// mismarked point or a wrong ψ shows up as a residual rather than as a
// confident wrong answer. On the 27 Sep 11:43 set — three frames spanning 8.0°
// — every target solved with a residual under 12 mm, and the BOOM came back at
// -9839 mm against a certificate E of 10330 that the method was never told.
//
// The one thing residuals cannot catch is a ψ error common to every frame, so
// the boom-against-E check is not decoration: it is the only external check
// there is.
// ─────────────────────────────────────────────────────────────────────────────

export interface TriangulateView {
  /** Camera misalignment for this frame, DEGREES, as solvePsi measured it. */
  psiDeg: number
  /** The corrected athwartships figure this frame reported, mm. */
  measuredMm: number
  /** The depth that correction ASSUMED, mm — needed to undo it. */
  assumedDepthMm: number
}

export interface TriangulateResult {
  /** Athwartships position, mm, agreed across the views. */
  athwartshipsMm: number
  /** Fore-and-aft offset from the mast, mm, forward positive. MEASURED. */
  depthMm: number
  /** Root-mean-square disagreement between the views, mm. */
  rmsMm: number
  /** How many views went in, and the angle they spanned. */
  views: number
  baselineDeg: number
}

const D2R = Math.PI / 180

/**
 * Solve one target's position from several views.
 *
 * Needs at least two views and a real angle between them: two frames taken from
 * the same spot say nothing about depth however good they are, and the solve
 * would be singular — better to refuse than to return a number that came out of
 * a rounding error.
 */
export function triangulate(views: TriangulateView[], minBaselineDeg = 1.5): TriangulateResult | null {
  if (!views || views.length < 2) return null
  const psis = views.map((v) => v.psiDeg)
  const baseline = Math.max(...psis) - Math.min(...psis)
  if (!(baseline >= minBaselineDeg)) return null

  // Undo each frame's own depth assumption to recover what it actually saw.
  const obs = views.map((v) => {
    const p = v.psiDeg * D2R
    return { p, raw: v.measuredMm * Math.cos(p) - v.assumedDepthMm * Math.sin(p) }
  })

  // Normal equations for raw = Y·cos ψ + D·(−sin ψ).
  let a = 0, b = 0, d = 0, e = 0, g = 0
  for (const o of obs) {
    const C = Math.cos(o.p), S = -Math.sin(o.p)
    a += C * C; b += C * S; d += S * S; e += C * o.raw; g += S * o.raw
  }
  const det = a * d - b * b
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null
  const Y = (d * e - b * g) / det
  const D = (-b * e + a * g) / det

  let ss = 0
  for (const o of obs) {
    const pred = Y * Math.cos(o.p) - D * Math.sin(o.p)
    ss += (pred - o.raw) ** 2
  }
  return {
    athwartshipsMm: Y,
    depthMm: D,
    rmsMm: Math.sqrt(ss / obs.length),
    views: obs.length,
    baselineDeg: baseline,
  }
}

/**
 * How trustworthy a solved depth is, in the order somebody can act on it.
 *
 * A narrow baseline is the quiet failure: the solve succeeds, the residual is
 * small because three nearly-identical views agree with each other, and the
 * depth is nonsense. So the baseline is judged separately from the fit.
 */
export function triangulateNote(r: TriangulateResult, clickSigmaMm = 15): string {
  const bits: string[] = []
  if (r.baselineDeg < 4) {
    bits.push(`only ${r.baselineDeg.toFixed(1)}° between the views — they agree because they are nearly the same photograph, not because the depth is right; 8° or more is what makes it a measurement`)
  }
  if (r.views < 3) bits.push('two views solve it exactly, so there is no residual to check it by — a third is what turns it into a measurement')
  if (r.rmsMm > 4 * clickSigmaMm) {
    bits.push(`the views disagree by ${r.rmsMm.toFixed(0)} mm, well past marking accuracy — a point is on the wrong feature, or a frame's ψ is wrong`)
  }
  return bits.join('; ')
}

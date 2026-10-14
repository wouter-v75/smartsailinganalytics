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
  /**
   * +1 on port, -1 on starboard: the leeward flip already baked into
   * `measuredMm`, so it can be taken back out.
   *
   * THE BUG. `measuredMm` is LEEWARD-POSITIVE — measureTarget multiplies the
   * image-signed offset by leewardSign(tack) — while `assumedDepthMm` beside it
   * is in the model's own convention and is not flipped. Undoing the correction
   * with one flipped and one not is arithmetic on two different sign
   * conventions, and on port (flip +1) it happened to be identity, so it was
   * right half the time and wrong half the time with nothing to show for it:
   * Baraka's three starboard frames solved her boom to -13155 mm at a 6 mm
   * residual, where the same three solved properly give -5750 at 5.8 mm.
   *
   * Defaults to +1, which is the old behaviour and correct for port.
   */
  leewardSign?: number
  /**
   * Camera→mast range, mm, when the frame knows it (it needs a focal length).
   *
   * With it the solve stops being a LONG-RANGE approximation. A target at depth
   * D images at k·(R+D)/R, so the millimetres a frame reports depend on the
   * depth it assumed — and the linear model below silently keeps the ASSUMED
   * depth's scale on the left while solving for a different depth on the right.
   *
   * At Northstar's 260 m that is a 4 % effect and the boom still came back at
   * 95 % of its certificate E. At Baraka's 22 m, D/R is 45 %: her boom solved
   * to −2900 mm against an E of 5700. Same shape as the ψ inflation — invisible
   * down a long lens, dominant up close.
   */
  rangeMm?: number | null
  /**
   * The heel the frame's geometry used, degrees. Taken as a magnitude.
   *
   * The forward model multiplies the ψ term by cos(heel); the undo never did,
   * which left a small term behind in every frame.
   */
  heelDeg?: number | null
}

export interface TriangulateResult {
  /** Athwartships position, mm, agreed across the views. */
  athwartshipsMm: number
  /** Fore-and-aft offset from the mast, mm, forward positive. MEASURED. */
  depthMm: number
  /** Root-mean-square disagreement between the views, mm. */
  rmsMm: number
  /**
   * How well the DEPTH is actually known, mm — the number to store beside it.
   *
   * D comes out of the difference between views divided by sin(span), so a
   * millimetre of marking error becomes 1/sin(span) millimetres of depth: 7x at
   * 8°, 8x at 7.2°, 14x at 4°. The residual measures the marking; the leverage
   * turns it into a depth.
   *
   * This replaces judging a solve by its SPAN alone, which was the wrong
   * question twice over. The 8° bar was never derived — it was the spread of
   * the first set that worked (N76, 27 Sep), and that spread was itself ~10 %
   * overstated by the ψ inflation, so the set that defined the bar no longer
   * meets it. And a span says nothing about whether the views agree: 9° fitting
   * to 40 mm is worse than 5° fitting to 3 mm, and only this tells them apart.
   *
   * The residual is floored at MIN_MARK_MM because three views over two
   * unknowns leave one degree of freedom, so a small rms is as much luck as
   * accuracy — and claiming a depth known better than the clicking allows is
   * the kind of confidence this file exists to refuse.
   */
  depthSigmaMm: number
  /** How many views went in, and the angle they spanned. */
  views: number
  baselineDeg: number
  /**
   * Each view's own disagreement with the fit, mm, in the order given.
   *
   * An rms is an average, and an average hides the thing worth finding: ONE
   * frame being wrong. Baraka's 08:22 set solved her boom to 79 % of E with an
   * rms of 94 mm; dropping the single frame that had solved ψ against a
   * different baseline took the rms to 12 mm and the depth to 89 %. The set was
   * never bad — one frame in it was, and only the per-view numbers say which.
   */
  residualsMm: number[]
}

const D2R = Math.PI / 180

/**
 * The best marking accuracy a residual is allowed to imply, mm.
 *
 * Three views over two unknowns leave ONE degree of freedom, so an rms of 1 mm
 * is not evidence of 1 mm marking — it is evidence that three points can be fit
 * by a line through two of them. 5 mm on a 6000 px frame is tight but real.
 */
export const MIN_MARK_MM = 5

/** Marking error → depth error, for a given angular span. 1/sin, and it bites. */
export const depthLeverage = (baselineDeg: number): number => {
  const s = Math.sin(Math.abs(baselineDeg) * D2R)
  return s > 1e-6 ? 1 / s : Infinity
}

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

  // Every frame knows its range ⇒ solve the real model, scale and all.
  if (views.every((v) => Number.isFinite(v.rangeMm as number) && (v.rangeMm as number) > 0)) {
    return solveWithScale(views, baseline)
  }

  // Undo each frame's own depth assumption to recover what it actually saw —
  // and the leeward flip first, so the measurement and the depth are in the
  // same convention. See `leewardSign`.
  const flip = sgn(views[0])
  const obs = views.map((v) => {
    const p = v.psiDeg * D2R
    return { p, raw: (v.measuredMm / sgn(v)) * Math.cos(p) - v.assumedDepthMm * Math.sin(p) }
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

  const residualsMm = obs.map((o) => Y * Math.cos(o.p) - D * Math.sin(o.p) - o.raw)
  const ss = residualsMm.reduce((t, v) => t + v * v, 0)
  return {
    // Back into the leeward-positive convention the caller reported in.
    athwartshipsMm: Y * flip,
    depthMm: D,
    rmsMm: Math.sqrt(ss / obs.length),
    depthSigmaMm: Math.max(Math.sqrt(ss / obs.length), MIN_MARK_MM) * depthLeverage(baseline),
    views: obs.length,
    baselineDeg: baseline,
    residualsMm,
  }
}

const cosHeel = (deg: number | null | undefined): number =>
  deg == null || !Number.isFinite(deg) ? 1 : Math.cos(Math.abs(deg) * D2R)

/** The leeward flip a view carries, defaulting to port's +1. */
const sgn = (v: TriangulateView): number =>
  v.leewardSign === -1 ? -1 : 1

/**
 * The same solve, without pretending the image scale is independent of depth.
 *
 * A frame's reported millimetres came from `(Δu + d·sinψ·cos φ)/cos ψ`, where Δu
 * is the clicked pixel offset converted at THAT target's depth — `k·(R+d)/R`.
 * So the first thing to recover is the depth-free quantity, the clicked offset
 * times the mast-plane scale:
 *
 *     pxK = (m·cos ψ − d_a·sin ψ·cos φ) · R / (R + d_a)
 *
 * which is what the frame actually saw. Then for a candidate depth D the frame
 * predicts `pxK·(R+D)/R = Y·cos ψ − D·sin ψ·cos φ`, and Y falls out in closed
 * form once D is fixed. D is one unknown over a bounded range, so it is swept
 * rather than linearised — the relation is not linear in D and the whole point
 * of this is to stop treating it as though it were.
 */
function solveWithScale(views: TriangulateView[], baselineDeg: number): TriangulateResult | null {
  const obs = views.map((v) => {
    const p = v.psiDeg * D2R
    const R = v.rangeMm as number
    const ch = cosHeel(v.heelDeg)
    const pxK = ((v.measuredMm / sgn(v)) * Math.cos(p) - v.assumedDepthMm * Math.sin(p) * ch)
      * (R / (R + v.assumedDepthMm))
    return { p, R, ch, pxK }
  })
  if (obs.some((o) => !Number.isFinite(o.pxK))) return null

  // A depth nearer the camera than the camera itself is not a photograph.
  const limit = Math.min(...obs.map((o) => o.R)) * 0.9
  const fit = (D: number) => {
    let num = 0, den = 0
    for (const o of obs) {
      const lhs = o.pxK * ((o.R + D) / o.R) + D * Math.sin(o.p) * o.ch
      num += lhs * Math.cos(o.p); den += Math.cos(o.p) ** 2
    }
    const Y = den > 0 ? num / den : 0
    let ss = 0
    for (const o of obs) {
      const pred = Y * Math.cos(o.p) - D * Math.sin(o.p) * o.ch
      ss += (pred - o.pxK * ((o.R + D) / o.R)) ** 2
    }
    return { Y, rms: Math.sqrt(ss / obs.length) }
  }

  // Coarse sweep then refine — the residual is smooth and single-minimumed over
  // any depth a boat has, so there is nothing to be gained by anything cleverer.
  let bestD = 0, best = fit(0)
  for (let D = -limit; D <= limit; D += 25) {
    const f = fit(D)
    if (f.rms < best.rms) { best = f; bestD = D }
  }
  for (let D = bestD - 25; D <= bestD + 25; D += 1) {
    const f = fit(D)
    if (f.rms < best.rms) { best = f; bestD = D }
  }
  const residualsMm = obs.map((o) =>
    best.Y * Math.cos(o.p) - bestD * Math.sin(o.p) * o.ch - o.pxK * ((o.R + bestD) / o.R))
  return {
    athwartshipsMm: best.Y * sgn(views[0]),
    depthMm: bestD,
    rmsMm: best.rms,
    depthSigmaMm: Math.max(best.rms, MIN_MARK_MM) * depthLeverage(baselineDeg),
    views: obs.length,
    baselineDeg,
    residualsMm,
  }
}

/**
 * The view that disagrees most, when one of them plainly does.
 *
 * Returns its index and what the fit would become without it — but only when
 * dropping it is a real improvement and enough views remain to still be a
 * measurement. Three views minus one is two, which solves exactly and has no
 * residual left to judge it by, so that is not an improvement, it is a way of
 * making the number look better.
 */
export function worstView(
  views: TriangulateView[], minBaselineDeg = 1.5, minRmsMm = 60,
): { index: number; without: TriangulateResult } | null {
  const all = triangulate(views, minBaselineDeg)
  if (!all || views.length < 4 || !all.residualsMm.length) return null
  // Only when the set is ACTUALLY disagreeing. A 3 mm fit has no outlier worth
  // naming, and dropping a view from one always "improves" it — four views over
  // two unknowns leave two degrees of freedom, three leave one, so the residual
  // falls towards zero by arithmetic rather than by anything being wrong. The
  // first run of this suggested discarding a frame from six targets out of
  // eight, every one of them already fitting to better than 7 mm. A tool that
  // cries outlier at a good fit teaches people to ignore it when it matters.
  // 60 mm is 4x marking accuracy — the same bar triangulateNote uses to call a
  // set disagreed.
  if (!(all.rmsMm > minRmsMm)) return null
  let worst = 0
  all.residualsMm.forEach((v, i) => { if (Math.abs(v) > Math.abs(all.residualsMm[worst])) worst = i })
  const without = triangulate(views.filter((_, i) => i !== worst), minBaselineDeg)
  if (!without) return null
  // Worth naming only if it more than halves the disagreement.
  return without.rmsMm * 2 < all.rmsMm ? { index: worst, without } : null
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
  } else if (r.baselineDeg < 8) {
    // The message below 4° has always said 8° is the bar, and nothing said
    // anything between the two — so a 5.3° set passed in silence while the file
    // called it insufficient. Baraka's port and starboard sets span 5.3° and
    // 4.2°, both solved to 1-6 mm residuals, and their station DEPTHS disagree
    // with each other by 350-1100 mm on points that cannot have moved. The
    // residual was never going to say so: it measures marking consistency, and
    // a narrow span makes depth almost free to slide.
    bits.push(`${r.baselineDeg.toFixed(1)}° between the views, under the 8° that makes a depth a measurement`
      + ` — the ATHWARTSHIPS figure is pinned by every view and survives this, the DEPTH does not`
      + ` (1 mm of marking error becomes ${(1 / Math.sin(r.baselineDeg * D2R)).toFixed(0)} mm of depth)`)
  }
  if (r.views < 3) bits.push('two views solve it exactly, so there is no residual to check it by — a third is what turns it into a measurement')
  // HOW HARD THE DEPTH AMPLIFIES A MISPLACED CLICK. D comes out of the
  // DIFFERENCE between views divided by sin(span), so a millimetre of marking
  // error becomes 1/sin(span) millimetres of depth: 7x at 8°, 8x at 7.2°, 14x
  // at 4°. Saying "no residual to check it by" was not enough — I read a
  // two-view boom at 7.2° as a measurement several times over, and it carried
  // about +-1100 mm from the marking sigmas alone. A number is easier to
  // discount than a caution.
  //
  // The figure rides WITH the span note rather than as a clause of its own. As
  // a separate push it appeared on every row of a set whose span is under 8° —
  // which is every row of every set anyone has shot — and nine identical copies
  // of a caution is how a caution stops being read.
  if (r.rmsMm > 4 * clickSigmaMm) {
    bits.push(`the views disagree by ${r.rmsMm.toFixed(0)} mm, well past marking accuracy — a point is on the wrong feature, or a frame's ψ is wrong`)
  }
  return bits.join('; ')
}

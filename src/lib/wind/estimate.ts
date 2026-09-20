// src/lib/wind/estimate.ts
// ─────────────────────────────────────────────────────────────────────────────
// TWD from a bare GPS track.
//
// The method (TWD doc §6-L2, validated in Part 4): choose the TWD that makes the
// distribution of true wind ANGLES most symmetric about 0, while leaving the
// no-go zone empty. A boat sails equally either side of the wind over a beat and
// never sails at TWA 0, so the correct TWD is the axis that satisfies both.
//
// Four things this module insists on, each of which was measured, not assumed:
//
//   • COG, NOT HEADING. Two real boats 36 m apart disagreed by 10.2° on
//     heading-derived TWD and 0.2° on COG-derived TWD, because leeway is
//     symmetric between tacks and cancels in the fit while per-device compass
//     bias does not. (§16.)
//   • A QUALITY GATE, not a better fit. A naive rolling re-fit gave a 75° median
//     error against the model; gating on "both tacks present upwind" gave 7°,
//     with the failing windows correctly refusing to answer. Those windows were
//     one-tack speed-test runs, which genuinely cannot yield an absolute TWD —
//     there is no opposite tack to bisect against. (§18.)
//   • POOLING RESCUES INDIVIDUAL FAILURES. In one window boat A alone returned
//     140°; pooled with boat B it returned 266°. Estimate across the squad, not
//     per boat. (§5-L5, §18.)
//   • THE 180° MIRROR IS NOT RESOLVABLE FROM GEOMETRY ALONE. A beat seen from
//     the opposite direction is a pair of legal broad reaches and scores
//     identically. A session with runs can be settled by speed (downwind is
//     faster); a beat-only session cannot, and needs the model prior. Passing
//     `priorTwd` also CONSTRAINS the search, which is what stops a thin window
//     fitting an unrelated axis — on real data that turned a 119° outlier into
//     a 10° worst case.
//   • IT RETURNS `null`, LOUDLY. "Honest data — marks unmeasured segments
//     rather than inventing numbers." A refusal is a result.
//
// What is NOT here yet: L3 relative tracking between anchors, and the L4 joint
// current solve. The output is therefore GROUND wind (§11) — referenced to the
// ground, like a forecast, not to the water like a polar. Callers must label it
// so; `reference: 'ground'` is on every result for that reason.
// ─────────────────────────────────────────────────────────────────────────────

import { angleDiff, circularMeanWeighted, circularSd, norm360 } from './circular'
import { type Segment, segmentsIn, steadySeconds } from './segment'

const BIN = 5
const NBINS = 360 / BIN

export interface WindEstimate {
  /** Degrees the wind comes FROM. */
  twd: number
  /** Always 'ground' until the L4 current solve exists. */
  reference: 'ground'
  /** Fit quality, 0..1 — the gated symmetry score. */
  score: number
  /** Minutes of upwind sailing on the thinner of the two tacks. */
  tackBalanceMin: number
  /** Seconds of steady sailing behind the fit. */
  steadySec: number
  /** Number of segments used. */
  segments: number
  /** Mean upwind |TWA| implied by this fit, degrees — a sanity signal. */
  upwindTwa: number | null
  /** Mean downwind |TWA|, degrees. */
  downwindTwa: number | null
  /** True when the 180° mirror scored as well and nothing could separate them. */
  ambiguous: boolean
  /** What resolved the mirror: a prior, boat speed, or nothing. */
  resolvedBy: 'prior' | 'speed' | 'score' | 'none'
}

export interface GateOpts {
  /**
   * A rough TWD to resolve the 180° ambiguity — normally the weather model.
   *
   * THE SYMMETRY SCORE CANNOT TELL A BEAT FROM A RUN. Segments at ±42° from
   * 270° sit at ±138° from 90°, which is a perfectly legal pair of broad
   * reaches, so both candidates score identically. The no-go penalty only
   * rejects candidates that put segments close to head-to-wind; it says nothing
   * about the downwind mirror. On a session with both beats and runs the speed
   * asymmetry settles it (downwind is faster); on a beat-only session nothing
   * in the geometry can, and an external prior is the only honest resolution —
   * which is precisely the job §6-L0 gives the model.
   */
  priorTwd?: number | null
  /**
   * How far from `priorTwd` the search may roam, degrees. The model is good to
   * roughly ±20° inshore, so ±60° is generous — but it stops a thin window
   * fitting a completely different axis, which is how a 45-minute window on
   * real data produced 154° against a model saying 273°.
   *
   * It must also be NARROWER than the spacing between a track's symmetry axes.
   * A day with equal time at ±42° and ±138° is symmetric about four axes 90°
   * apart, so a ±90° window admits a perpendicular one and can land 90° out.
   */
  priorWindowDeg?: number
  /** Accept a result the estimator could not disambiguate. Default false. */
  allowAmbiguous?: boolean
  /** Minutes of upwind time required on EACH tack. */
  minTackBalanceMin?: number
  /** Minimum symmetry score. */
  minScore?: number
  /** Minimum steady seconds in the window. */
  minSteadySec?: number
  /** |TWA| below this is the no-go zone nobody sails in. */
  noGoDeg?: number
  /** |TWA| below this counts as upwind. */
  upwindDeg?: number
  /** |TWA| above this counts as downwind. */
  downwindDeg?: number
}

export const GATE: Required<Omit<GateOpts, 'priorTwd'>> & { priorTwd: number | null } = {
  priorTwd: null,
  priorWindowDeg: 60,
  allowAmbiguous: false,
  minTackBalanceMin: 2,
  minScore: 0.35,
  minSteadySec: 240,
  noGoDeg: 30,
  upwindDeg: 70,
  downwindDeg: 110,
}

/**
 * Score a candidate TWD: how well does the TWA distribution mirror itself,
 * minus any time spent inside the no-go zone?
 *
 * The no-go penalty rejects candidates that would put the boat close to
 * head-to-wind, which no sailboat sails. It does NOT break the 180° ambiguity:
 * a beat seen from the opposite direction looks like a pair of legal broad
 * reaches and scores identically. See `priorTwd` and `speedResolves`.
 */
export function scoreTwd(segs: Segment[], twd: number, opts: GateOpts = {}): number {
  const o = { ...GATE, ...opts }
  const h = new Array(NBINS).fill(0)
  let total = 0, noGo = 0
  for (const s of segs) {
    const twa = angleDiff(s.bearing, twd)
    h[Math.floor((twa + 180) / BIN) % NBINS] += s.dur
    total += s.dur
    if (Math.abs(twa) < o.noGoDeg) noGo += s.dur
  }
  if (!total) return -1
  let overlap = 0
  for (let i = 0; i < NBINS; i++) {
    const twa = -180 + i * BIN + BIN / 2
    overlap += Math.min(h[i], h[Math.floor((-twa + 180) / BIN) % NBINS])
  }
  return overlap / total - 2 * (noGo / total)
}

/** Minutes of upwind time on the thinner tack — the gate that matters most. */
export function tackBalanceMinutes(segs: Segment[], twd: number, opts: GateOpts = {}): number {
  const o = { ...GATE, ...opts }
  let a = 0, b = 0
  for (const s of segs) {
    const twa = angleDiff(s.bearing, twd)
    if (Math.abs(twa) >= o.upwindDeg) continue
    if (twa > 0) a += s.dur; else b += s.dur
  }
  return Math.min(a, b) / 60
}

/**
 * Coarse-to-fine search for the best-scoring TWD, then a refinement from the
 * residual tack-angle asymmetry: if the mean |TWA| differs between tacks, the
 * axis is off by half that difference.
 */
export function bestTwd(
  segs: Segment[], opts: GateOpts = {}
): { twd: number; score: number; ambiguous: boolean; resolvedBy: 'prior' | 'speed' | 'score' | 'none' } | null {
  if (!segs.length) return null
  const o = { ...GATE, ...opts }
  // A prior CONSTRAINS the search rather than only breaking the final tie. The
  // mirror is then excluded by construction, and so is any unrelated axis a
  // thin window might otherwise prefer.
  const inPrior = (twd: number) =>
    o.priorTwd == null || Math.abs(angleDiff(twd, o.priorTwd)) <= o.priorWindowDeg

  let best: { twd: number; score: number } | null = null
  for (let twd = 0; twd < 360; twd += 1) {
    if (!inPrior(twd)) continue
    const score = scoreTwd(segs, twd, opts)
    if (!best || score > best.score) best = { twd, score }
  }
  if (!best) return null

  let twd = best.twd
  let resolvedBy: 'prior' | 'speed' | 'score' | 'none' = o.priorTwd != null ? 'prior' : 'score'
  let ambiguous = false

  if (o.priorTwd == null) {
    // No prior: the mirror scores identically on a beat-only track, so try the
    // one physical asymmetry available before giving up.
    const mirror = norm360(best.twd + 180)
    const mirrorScore = scoreTwd(segs, mirror, opts)
    if (Math.abs(mirrorScore - best.score) < 0.02) {
      const bySpeed = speedResolves(segs, best.twd, mirror, opts)
      if (bySpeed != null) { twd = bySpeed; resolvedBy = 'speed' }
      else { ambiguous = true; resolvedBy = 'none' }
    }
  }

  const adj = asymmetryDeg(segs, twd, opts)
  return { twd: norm360(twd + (adj ?? 0)), score: best.score, ambiguous, resolvedBy }
}

/**
 * Pick between a candidate and its mirror using the one physical asymmetry
 * available: for essentially every sailing boat, DOWNWIND IS FASTER THAN
 * UPWIND. (Real data: 4.7–5.3 kn upwind, 6.6–7.0 kn downwind.) If the group
 * near the axis is faster than the group away from it, the axis is flipped.
 * Returns null when either group is missing or the difference is not decisive.
 */
function speedResolves(
  segs: Segment[], a: number, b: number, opts: GateOpts = {}
): number | null {
  const o = { ...GATE, ...opts }
  const sane = (twd: number): number | null => {
    const up = segs.filter((s) => Math.abs(angleDiff(s.bearing, twd)) < o.upwindDeg)
    const dn = segs.filter((s) => Math.abs(angleDiff(s.bearing, twd)) > o.downwindDeg)
    if (!up.length || !dn.length) return null
    const mean = (l: Segment[]) =>
      l.reduce((x, g) => x + g.sog * g.dur, 0) / l.reduce((x, g) => x + g.dur, 0)
    return mean(dn) - mean(up)          // positive = physically sensible
  }
  const da = sane(a), db = sane(b)
  if (da == null || db == null) return null
  if (Math.abs(da - db) < 0.2) return null   // not decisive
  return da > db ? a : b
}

/**
 * Half the difference in mean |TWA| between the two tacks — the residual error
 * in the candidate axis. Null when one tack is missing.
 */
export function asymmetryDeg(segs: Segment[], twd: number, opts: GateOpts = {}): number | null {
  const o = { ...GATE, ...opts }
  const up = segs.filter((s) => Math.abs(angleDiff(s.bearing, twd)) < o.upwindDeg)
  const pos = up.filter((s) => angleDiff(s.bearing, twd) > 0)
  const neg = up.filter((s) => angleDiff(s.bearing, twd) < 0)
  if (!pos.length || !neg.length) return null
  const mean = (list: Segment[]) =>
    list.reduce((a, s) => a + Math.abs(angleDiff(s.bearing, twd)) * s.dur, 0) /
    list.reduce((a, s) => a + s.dur, 0)
  return (mean(pos) - mean(neg)) / 2
}

/**
 * Estimate TWD from segments, or return null when the geometry does not support
 * one. `null` is a valid, expected, frequent answer.
 */
export function estimateTwd(segs: Segment[], opts: GateOpts = {}): WindEstimate | null {
  const o = { ...GATE, ...opts }
  if (!segs.length) return null
  const steadySec = steadySeconds(segs)
  if (steadySec < o.minSteadySec) return null

  const best = bestTwd(segs, opts)
  if (!best) return null

  const balance = tackBalanceMinutes(segs, best.twd, opts)
  if (balance < o.minTackBalanceMin) return null
  if (best.score < o.minScore) return null
  if (best.ambiguous && !o.allowAmbiguous) return null

  const twas = segs.map((s) => ({ twa: angleDiff(s.bearing, best.twd), dur: s.dur }))
  const meanAbs = (list: typeof twas) =>
    list.length
      ? list.reduce((a, x) => a + Math.abs(x.twa) * x.dur, 0) / list.reduce((a, x) => a + x.dur, 0)
      : null

  return {
    twd: best.twd,
    reference: 'ground',
    score: best.score,
    tackBalanceMin: balance,
    steadySec,
    segments: segs.length,
    upwindTwa: meanAbs(twas.filter((x) => Math.abs(x.twa) < o.upwindDeg)),
    downwindTwa: meanAbs(twas.filter((x) => Math.abs(x.twa) > o.downwindDeg)),
    ambiguous: best.ambiguous,
    resolvedBy: best.resolvedBy,
  }
}

export interface RollingPoint {
  t: number
  estimate: WindEstimate | null
  /** Why it refused, when it did. */
  reason?: string
}

export interface RollingOpts extends GateOpts {
  /** Window half-width, seconds. */
  halfWindowSec?: number
  /** Step between estimates, seconds. */
  stepSec?: number
}

/**
 * TWD through the session. Pass segments from EVERY boat in the squad — pooling
 * is what makes this work (§18), and it is why this takes a flat list rather
 * than one boat's segments.
 */
export function rollingTwd(segs: Segment[], opts: RollingOpts = {}): RollingPoint[] {
  const halfWindowSec = opts.halfWindowSec ?? 1350       // 45-minute window
  const stepSec = opts.stepSec ?? 600
  if (!segs.length) return []
  const t0 = Math.min(...segs.map((s) => s.startUtc))
  const t1 = Math.max(...segs.map((s) => s.endUtc))
  const out: RollingPoint[] = []
  for (let t = t0; t <= t1; t += stepSec * 1000) {
    const w = segmentsIn(segs, t - halfWindowSec * 1000, t + halfWindowSec * 1000)
    const est = estimateTwd(w, opts)
    out.push(est
      ? { t, estimate: est }
      : { t, estimate: null, reason: refusalReason(w, opts) })
  }
  return out
}

function refusalReason(segs: Segment[], opts: GateOpts = {}): string {
  const o = { ...GATE, ...opts }
  if (!segs.length) return 'no steady sailing'
  const steady = steadySeconds(segs)
  if (steady < o.minSteadySec) return `only ${Math.round(steady / 60)} min of steady sailing`
  const best = bestTwd(segs, opts)
  if (!best) return 'no fit'
  const bal = tackBalanceMinutes(segs, best.twd, opts)
  if (bal < o.minTackBalanceMin) {
    return bal === 0
      ? 'sailed on one tack only — no opposite tack to bisect against'
      : `only ${bal.toFixed(1)} min on the thinner tack`
  }
  if (best.score < o.minScore) return `fit too poor (${best.score.toFixed(2)})`
  if (best.ambiguous) return 'wind axis found but direction is 180° ambiguous — needs a model prior'
  return 'gate not met'
}

/**
 * Combine several independent TWD estimates — for example one per boat in the
 * same window — into one figure with a spread. The spread is the honest
 * uncertainty: boats sailing together must agree, so disagreement is error.
 */
export function combineEstimates(
  values: Array<{ twd: number; weight?: number }>
): { twd: number; sdDeg: number; n: number } | null {
  if (!values.length) return null
  const deg = values.map((v) => v.twd)
  const w = values.map((v) => v.weight ?? 1)
  return { twd: circularMeanWeighted(deg, w), sdDeg: circularSd(deg), n: deg.length }
}

// src/lib/tagging/autoPhases.ts
// ─────────────────────────────────────────────────────────────────────────────
// Cut a stretch of the day's track into fixed-length steady-state PHASES.
//
// The crew drags a selection over the track (or takes the whole day), and this
// slices it into 30 s windows — the same length the onboard assistant writes into
// the Expedition event file, so the result drops straight into computePhaseStats
// and the KND-style plots without a second code path.
//
// The interesting half is the FILTER. A raw 30 s slice is only worth averaging if
// the boat was actually doing one thing for those 30 seconds; a slice containing a
// tack, a luff, a gap in the log or a stop is noise that drags every group mean
// with it. So each slice has to survive, in order:
//
//   1. coverage   — enough log rows for its length (no gap in the recording)
//   2. moving     — mean boat speed above a floor (not drifting or stopped)
//   3. no manoeuvre — TWA keeps its sign (a tack or gybe ends the phase)
//   4. one mode   — every sample sits in the same point-of-sail band
//   5. steady     — TWA and heading spread inside their limits
//
// Rejected slices are RETURNED, with the reason, rather than silently dropped:
// the tagger draws them greyed out so a gap in the phase track reads as "the log
// died here", not "the tool missed it".
//
// Pure — no React, no I/O. Thresholds are all overridable per call.
// ─────────────────────────────────────────────────────────────────────────────

export type PhaseMode = 'up' | 'down' | 'reach'
export type PhaseTack = 'port' | 'stbd'

export type PhaseLogRow = { utc: number } & Record<string, number | null | undefined>

export interface AutoPhaseOptions {
  /** Phase length in seconds. 30 s matches the event file's own phases. */
  lengthSec?: number
  /** Fraction of the expected samples a slice needs (0–1). */
  minCoverage?: number
  /** Absolute floor on samples, whatever the log rate. */
  minSamples?: number
  /** Mean BSP (falling back to SOG) below this reads as "not sailing", kn. */
  minBsp?: number
  /** Max standard deviation of TWA inside a phase, degrees. */
  maxTwaSd?: number
  /** Max spread of heading (HDG, else COG) inside a phase, degrees. */
  maxHeadingRange?: number
  /** Drop slices that contain a change of tack. */
  requireSingleTack?: boolean
  /** Drop slices whose samples straddle two points of sail. */
  requireSingleMode?: boolean
  /** Keep rejected slices in the result (the tagger shows them greyed out). */
  keepRejected?: boolean
}

export const DEFAULT_AUTO_PHASE_OPTIONS: Required<AutoPhaseOptions> = {
  lengthSec: 30,
  minCoverage: 0.6,
  minSamples: 5,
  minBsp: 1.5,
  maxTwaSd: 12,
  maxHeadingRange: 30,
  requireSingleTack: true,
  requireSingleMode: true,
  keepRejected: true,
}

export type RejectReason =
  | 'no-data'
  | 'coverage'
  | 'not-sailing'
  | 'manoeuvre'
  | 'mode-change'
  | 'unsteady-twa'
  | 'unsteady-heading'

export const REJECT_LABELS: Record<RejectReason, string> = {
  'no-data': 'No log data',
  coverage: 'Gap in the log',
  'not-sailing': 'Not sailing',
  manoeuvre: 'Tack or gybe inside',
  'mode-change': 'Changed point of sail',
  'unsteady-twa': 'TWA not steady',
  'unsteady-heading': 'Heading not steady',
}

export interface AutoPhase {
  t0: number
  t1: number
  mode: PhaseMode | null
  tack: PhaseTack | null
  nSamples: number
  rejected: boolean
  rejectReason: RejectReason | null
  metrics: {
    tws: number | null
    twa: number | null
    bsp: number | null
    sog: number | null
    heel: number | null
    twaSd: number | null
    hdgRange: number | null
  }
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** Point of sail from |TWA| — the same bands computeAutoTags uses. */
export function modeOfTwa(twa: number): PhaseMode {
  const a = Math.abs(twa)
  return a < 60 ? 'up' : a < 110 ? 'reach' : 'down'
}

/** The event file's <sailingmode> numbering: 1 upwind, 2 reaching, 8 downwind. */
export const sailingModeNumber = (mode: PhaseMode | null): number =>
  mode === 'up' ? 1 : mode === 'down' ? 8 : 2

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null

function sd(xs: number[]): number | null {
  if (xs.length < 2) return null
  const m = xs.reduce((s, x) => s + x, 0) / xs.length
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}

/** Angular spread of a set of headings, in degrees (0–360). Wraps at 360, so a
 *  slice sitting on 359°/1° reads as 2° of wander, not 358°.
 *
 *  Measured as twice the largest deviation from the circular mean — exact for a
 *  symmetric spread, and never UNDER-reports a lopsided one, which is the side to
 *  err on when the answer decides whether a phase is steady enough to keep. */
export function headingRange(degs: number[]): number | null {
  if (!degs.length) return null
  if (degs.length === 1) return 0
  // Mean direction as a unit vector, then the largest deviation from it.
  let sx = 0
  let sy = 0
  for (const d of degs) {
    const r = (d * Math.PI) / 180
    sx += Math.cos(r)
    sy += Math.sin(r)
  }
  // Perfectly opposed samples cancel out and leave no mean direction to measure
  // against — which is as unsteady as it gets.
  if (sx === 0 && sy === 0) return 360
  const mean0 = (Math.atan2(sy, sx) * 180) / Math.PI
  let worst = 0
  for (const d of degs) {
    const diff = Math.abs(((d - mean0 + 540) % 360) - 180)
    if (diff > worst) worst = diff
  }
  return Math.min(worst * 2, 360)
}

/** First index with rows[i].utc >= t (rows must be sorted by utc). */
function lowerBound(rows: PhaseLogRow[], t: number): number {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].utc < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Median gap between consecutive samples, ms. Used to size "enough coverage"
 *  without assuming a log rate — these files run anywhere from 10 Hz to 6 s. */
export function medianSampleMs(rows: PhaseLogRow[]): number {
  if (rows.length < 2) return 1000
  const gaps: number[] = []
  for (let i = 1; i < rows.length; i++) {
    const g = rows[i].utc - rows[i - 1].utc
    if (g > 0 && g < 60_000) gaps.push(g)
  }
  if (!gaps.length) return 1000
  gaps.sort((a, b) => a - b)
  return gaps[gaps.length >> 1] || 1000
}

function judge(
  slice: PhaseLogRow[],
  expected: number,
  o: Required<AutoPhaseOptions>
): { reason: RejectReason | null; mode: PhaseMode | null; tack: PhaseTack | null; m: AutoPhase['metrics'] } {
  const empty: AutoPhase['metrics'] = {
    tws: null, twa: null, bsp: null, sog: null, heel: null, twaSd: null, hdgRange: null,
  }
  if (!slice.length) return { reason: 'no-data', mode: null, tack: null, m: empty }

  const twas = slice.map((r) => num(r.twa)).filter((v): v is number => v != null)
  const twss = slice.map((r) => num(r.tws)).filter((v): v is number => v != null)
  const bsps = slice.map((r) => num(r.bsp)).filter((v): v is number => v != null)
  const sogs = slice.map((r) => num(r.sog)).filter((v): v is number => v != null)
  const heels = slice.map((r) => num(r.heel)).filter((v): v is number => v != null)
  const hdgs = slice
    .map((r) => num(r.hdg) ?? num(r.heading) ?? num(r.cog))
    .filter((v): v is number => v != null)

  const meanTwa = mean(twas)
  const hdgRange = headingRange(hdgs)
  const m: AutoPhase['metrics'] = {
    tws: mean(twss),
    twa: meanTwa,
    bsp: mean(bsps),
    sog: mean(sogs),
    heel: mean(heels.map(Math.abs)),
    twaSd: sd(twas.map(Math.abs)),
    hdgRange,
  }

  const mode = meanTwa == null ? null : modeOfTwa(meanTwa)
  const tack: PhaseTack | null = meanTwa == null ? null : meanTwa >= 0 ? 'stbd' : 'port'

  // 1. coverage — a slice missing a third of its samples has a hole in it.
  if (slice.length < o.minSamples || slice.length < expected * o.minCoverage) {
    return { reason: 'coverage', mode, tack, m }
  }
  // Without TWA there is no point of sail and nothing to steady-check against.
  if (meanTwa == null || !twas.length) return { reason: 'no-data', mode, tack, m }

  // 2. moving — BSP if the log has it, else SOG.
  const speed = m.bsp ?? m.sog
  if (speed == null || speed < o.minBsp) return { reason: 'not-sailing', mode, tack, m }

  // 3. no manoeuvre — a tack or gybe flips the sign of TWA.
  if (o.requireSingleTack) {
    const firstSign = Math.sign(twas[0] || 0)
    for (const t of twas) {
      // Samples sitting on 0° are head-to-wind noise, not a change of tack.
      if (Math.abs(t) < 3) continue
      if (firstSign !== 0 && Math.sign(t) !== firstSign) {
        return { reason: 'manoeuvre', mode, tack, m }
      }
    }
  }
  // 4. one mode — no bearing away from upwind to a reach half way through.
  if (o.requireSingleMode) {
    for (const t of twas) {
      if (modeOfTwa(t) !== mode) return { reason: 'mode-change', mode, tack, m }
    }
  }
  // 5. steady — TWA spread, then heading wander.
  if (m.twaSd != null && m.twaSd > o.maxTwaSd) return { reason: 'unsteady-twa', mode, tack, m }
  if (hdgRange != null && hdgRange > o.maxHeadingRange) {
    return { reason: 'unsteady-heading', mode, tack, m }
  }
  return { reason: null, mode, tack, m }
}

/**
 * Slice [from, to] into fixed-length phases and judge each one.
 *
 * `rows` must be sorted by utc. `from`/`to` are UTC ms; pass the whole day's
 * bounds for "all of the track". Slices are aligned to `from`, so the phases the
 * crew gets are the phases they selected — no silent snapping to a wall clock.
 */
export function buildAutoPhases(
  rows: PhaseLogRow[] | null | undefined,
  from: number,
  to: number,
  options: AutoPhaseOptions = {}
): AutoPhase[] {
  const o = { ...DEFAULT_AUTO_PHASE_OPTIONS, ...options }
  const lenMs = Math.max(1, Math.round(o.lengthSec * 1000))
  if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < lenMs) return []

  const all = rows || []
  const sampleMs = medianSampleMs(all)
  const expected = Math.max(1, Math.floor(lenMs / Math.max(1, sampleMs)))

  const out: AutoPhase[] = []
  for (let t0 = from; t0 + lenMs <= to; t0 += lenMs) {
    const t1 = t0 + lenMs
    const slice = all.slice(lowerBound(all, t0), lowerBound(all, t1))
    const { reason, mode, tack, m } = judge(slice, expected, o)
    const phase: AutoPhase = {
      t0,
      t1,
      mode,
      tack,
      nSamples: slice.length,
      rejected: reason != null,
      rejectReason: reason,
      metrics: m,
    }
    if (!phase.rejected || o.keepRejected) out.push(phase)
  }
  return out
}

/** How the build went, for the "cut 42 phases, dropped 9" line in the UI. */
export interface AutoPhaseSummary {
  total: number
  kept: number
  rejected: number
  byReason: Record<string, number>
  keptSeconds: number
}

export function summarisePhases(phases: AutoPhase[]): AutoPhaseSummary {
  const byReason: Record<string, number> = {}
  let kept = 0
  let kms = 0
  for (const p of phases) {
    if (p.rejected) byReason[p.rejectReason || 'no-data'] = (byReason[p.rejectReason || 'no-data'] || 0) + 1
    else { kept++; kms += p.t1 - p.t0 }
  }
  return {
    total: phases.length,
    kept,
    rejected: phases.length - kept,
    byReason,
    keptSeconds: Math.round(kms / 1000),
  }
}

/** Kept phases in the shape phaseStats.computePhaseStats consumes, so SSA-cut
 *  phases feed the same charts and report tables as the event file's own. */
export function toStatsPhases(
  phases: AutoPhase[]
): { utc: number; endUtc: number; mode: number }[] {
  return phases
    .filter((p) => !p.rejected)
    .map((p) => ({ utc: p.t0, endUtc: p.t1, mode: sailingModeNumber(p.mode) }))
}

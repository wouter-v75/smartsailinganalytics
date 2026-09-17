// Phases SSA builds from the log itself — the second source alongside the 30 s phases
// that come in the KND event file.
//
// The shape follows what the tools doing this work converged on independently:
//   1. EVENT BOUNDARIES FIRST. The day is cut at every tack, gybe, mark rounding and
//      sail change, with a guard either side, so no block ever straddles a manoeuvre.
//   2. FIXED BLOCKS INSIDE. Each remaining stretch is tiled with whole blocks of the
//      chosen length; a part-block at the end is dropped rather than compared with
//      full ones.
//   3. A BLOCK IS JUDGED ON DRIFT, NOT NOISE. It is spoiled when its end no longer
//      looks like its start (mean of the last third vs the first third) — not because
//      the numbers moved about, which is what averaging is for. The spread limits are
//      guard rails against a squall or a rogue reading.
//   4. THE POINT OF SAIL IS AWA, NOT HEADING. A wind shift under a wind-mode autopilot
//      turns the boat without changing the sailing at all.
//   5. MANOEUVRES ARE KEPT as phases of their own (KND makes tacks and gybes their own
//      sailing mode) — they are thrown out of the steady-state data, but they are
//      exactly what calibration is read from, so they must not be lost.
//
// Rejections are RETURNED, not swallowed: a day where nothing is accepted is usually a
// failing sensor or a wrong threshold, and the reason histogram says which.

import type { LogRow, Phase } from './phaseStats'
import type { PhaseSettings } from './phaseSettings'

export type PhaseKind = 'steady' | 'tack' | 'gybe'

// Charting reads these as event-file phases do. `mode: -1` is not a known event-file
// sailing-mode code, so phaseStats falls back to the point of sail from mean TWA —
// the right answer for a block SSA cut itself.
export const SSA_MODE = -1

export interface BuiltPhase extends Phase {
  src: 'ssa'
  kind: PhaseKind
  quality: number          // 0–1, how far inside the spread limits the block sat
  runId?: string           // the named run (line-up / test) this came from
}

export interface RejectedWindow {
  utc: number
  endUtc: number
  reason: string           // one line, for the histogram under the charts
}

export interface BuildResult {
  phases: BuiltPhase[]
  rejected: RejectedWindow[]
  reasons: { reason: string; n: number }[]   // commonest first
}

export interface BuildOpts {
  from?: number | null     // a track selection narrows the build to its time span
  to?: number | null
  runId?: string
  resolutionS?: number     // the log's own row spacing; measured from the log when absent
}

interface Interval { from: number; to: number }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function mergeIntervals(xs: Interval[]): Interval[] {
  if (!xs.length) return []
  const sorted = [...xs].sort((a, b) => a.from - b.from)
  const out: Interval[] = [{ ...sorted[0] }]
  for (const iv of sorted.slice(1)) {
    const last = out[out.length - 1]
    // Touching counts as overlapping: back-to-back manoeuvres leave no usable gap
    // between their guards, and a block squeezed in there is the manoeuvre itself.
    if (iv.from <= last.to) last.to = Math.max(last.to, iv.to)
    else out.push({ ...iv })
  }
  return out
}

// The stretches left once every manoeuvre and its guard are cut out of [from, to].
function clearStretches(span: Interval, blocked: Interval[]): Interval[] {
  const out: Interval[] = []
  let cursor = span.from
  for (const b of mergeIntervals(blocked)) {
    if (b.to <= span.from || b.from >= span.to) continue
    if (b.from > cursor) out.push({ from: cursor, to: Math.min(b.from, span.to) })
    cursor = Math.max(cursor, b.to)
    if (cursor >= span.to) break
  }
  if (cursor < span.to) out.push({ from: cursor, to: span.to })
  return out.filter(s => s.to > s.from)
}

function lowerBound(rows: LogRow[], utc: number): number {
  let lo = 0, hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].utc < utc) lo = mid + 1
    else hi = mid
  }
  return lo
}

// The log's row spacing, from the middle of the day so a slow start does not set it.
// A phase is judged against what the LOG should hold, not against what survived in it:
// deriving it from the block's own rows would make every block look complete.
function medianResolutionS(rows: LogRow[]): number {
  const gaps: number[] = []
  for (let i = 1; i < rows.length; i++) {
    const dt = (rows[i].utc - rows[i - 1].utc) / 1000
    if (dt > 0 && dt < 60) gaps.push(dt)
  }
  if (!gaps.length) return 1
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)] || 1
}

const values = (rows: LogRow[], key: string): number[] =>
  rows.map(r => num(r[key])).filter((v): v is number => v != null)

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

// mean(last third) − mean(first third): has the regime moved?
function drift(xs: number[]): number | null {
  if (xs.length < 6) return null
  const k = Math.floor(xs.length / 3)
  return mean(xs.slice(xs.length - k)) - mean(xs.slice(0, k))
}

const spread = (xs: number[]): number => Math.max(...xs) - Math.min(...xs)

// Degrees, shortest way round: heading 359° → 1° is 2°, not 358°.
const angleDelta = (a: number, b: number): number => {
  let d = (a - b) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

// Mean |rate of turn| across the block. The MEAN, not a peak: one slew off a wave
// invalidates nothing, a sustained turn does.
function meanRotDegS(rows: LogRow[]): number | null {
  const pts = rows
    .map(r => ({ utc: r.utc, h: num(r.hdg) ?? num(r.cog) }))
    .filter((p): p is { utc: number; h: number } => p.h != null)
  if (pts.length < 3) return null
  let sum = 0, n = 0
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].utc - pts[i - 1].utc) / 1000
    if (dt <= 0 || dt > 5) continue          // a gap is not a turn
    sum += Math.abs(angleDelta(pts[i].h, pts[i - 1].h)) / dt
    n++
  }
  return n ? sum / n : null
}

// The tack flipped inside the block. Only judged between 20° and 160°, because the
// sign of TWA flutters either side of head to wind and dead downwind without the boat
// having done anything.
function tackFlipped(rows: LogRow[]): boolean {
  let sign = 0
  for (const r of rows) {
    const t = num(r.twa)
    if (t == null) continue
    const a = Math.abs(t)
    if (a <= 20 || a >= 160) continue
    const s = t >= 0 ? 1 : -1
    if (sign && s !== sign) return true
    sign = s
  }
  return false
}

function biggestGapS(rows: LogRow[]): number {
  let worst = 0
  for (let i = 1; i < rows.length; i++) worst = Math.max(worst, (rows[i].utc - rows[i - 1].utc) / 1000)
  return worst
}

// How far inside the spread limits the block sat, 0–1, averaged over the three
// channels. Kept per phase so the calmest blocks can be picked out later without
// rebuilding — the same idea as autopolar's per-point quality score.
function qualityOf(s: PhaseSettings, awa: number[], tws: number[], bsp: number[]): number {
  const parts: number[] = []
  const add = (xs: number[], ceiling: number) => {
    if (xs.length < 2 || ceiling <= 0) return
    parts.push(Math.max(0, Math.min(1, 1 - spread(xs) / ceiling)))
  }
  add(awa, s.gate.awaSpreadMaxDeg)
  add(tws, s.gate.twsSpreadMaxKn)
  add(bsp, s.gate.bspSpreadMaxKn)
  return parts.length ? Number(mean(parts).toFixed(3)) : 0
}

// Why this block is not usable — the first failure, in the order a person would check.
// Returns null when the block is good.
function rejectReason(s: PhaseSettings, rows: LogRow[], expectedRows: number): string | null {
  if (rows.length < Math.max(3, Math.ceil(expectedRows * s.minCoverage))) {
    return `too few rows (${rows.length} of ~${Math.round(expectedRows)})`
  }
  const gap = biggestGapS(rows)
  if (gap > s.maxGapS) return `gap in the log (${gap.toFixed(0)} s)`

  const bsp = values(rows, 'bsp'), tws = values(rows, 'tws'), awa = values(rows, 'awa')
  const twa = values(rows, 'twa')
  if (!bsp.length || !tws.length || !twa.length) return 'channel missing (bsp / tws / twa)'
  // Before anything that reads mean TWA: across a tack the mean is ~0, which would
  // report a perfectly ordinary tack as "head to wind" and hide what happened.
  if (tackFlipped(rows)) return 'tack changed inside the phase'
  if (mean(bsp) < s.gate.minBspKn) return `too slow (${mean(bsp).toFixed(1)} kn)`
  if (mean(tws) < s.gate.minTwsKn) return `too light (${mean(tws).toFixed(1)} kn)`
  if (Math.abs(mean(twa)) < s.gate.minTwaDeg) return `head to wind (${Math.abs(mean(twa)).toFixed(0)}°)`

  const rot = meanRotDegS(rows)
  if (rot != null && rot > s.gate.rotMaxDegS) return `turning (${rot.toFixed(1)}°/s)`

  // Drift first: it is the real test. Spread is only a guard rail.
  const checks: [string, number[], number, number, string][] = [
    ['AWA', awa, s.gate.awaDriftMaxDeg, s.gate.awaSpreadMaxDeg, '°'],
    ['TWS', tws, s.gate.twsDriftMaxKn, s.gate.twsSpreadMaxKn, ' kn'],
    ['BSP', bsp, s.gate.bspDriftMaxKn, s.gate.bspSpreadMaxKn, ' kn'],
  ]
  for (const [label, xs, driftMax, , unit] of checks) {
    const d = drift(xs)
    if (d != null && Math.abs(d) > driftMax) return `${label} drifted ${d > 0 ? '+' : ''}${d.toFixed(1)}${unit}`
  }
  for (const [label, xs, , spreadMax, unit] of checks) {
    if (xs.length > 1 && spread(xs) > spreadMax) return `${label} swung ${spread(xs).toFixed(1)}${unit}`
  }
  return null
}

// Tacks and gybes as phases of their own. They never pass the steady-state gate — that
// is the point — but they are what the wind-angle and upwash calibrations are read
// from, so they are built separately and kept.
function manoeuvrePhases(xml: any, span: Interval, s: PhaseSettings, runId?: string): BuiltPhase[] {
  if (!s.manoeuvrePhases) return []
  const half = (s.manoeuvreWindowS * 1000) / 2
  return ((xml?.tackJibes || []) as any[])
    .map(m => ({ utc: num(m?.utc), isTack: m?.isTack !== false }))
    .filter((m): m is { utc: number; isTack: boolean } => m.utc != null)
    .filter(m => m.utc >= span.from && m.utc <= span.to)
    .map(m => ({
      utc: m.utc - half, endUtc: m.utc + half, mode: SSA_MODE, src: 'ssa' as const,
      kind: (m.isTack ? 'tack' : 'gybe') as PhaseKind, quality: 1, ...(runId ? { runId } : {}),
    }))
}

export function buildPhases(
  rows: LogRow[] | null | undefined,
  xml: any,
  settings: PhaseSettings,
  opts: BuildOpts = {}
): BuildResult {
  const empty: BuildResult = { phases: [], rejected: [], reasons: [] }
  if (!rows?.length) return empty

  const span: Interval = {
    from: opts.from ?? xml?.dayStartUtc ?? rows[0].utc,
    to: opts.to ?? xml?.dayStopUtc ?? rows[rows.length - 1].utc,
  }
  if (!(span.to > span.from)) return empty

  // Everything that makes the boat stop being a steady sailing boat, with its guard.
  const before = settings.guardBeforeS * 1000, after = settings.guardAfterS * 1000
  const events: number[] = [
    ...((xml?.tackJibes || []) as any[]).map(e => num(e?.utc)),
    ...((xml?.markRoundings || []) as any[]).map(e => num(e?.utc)),
    ...((xml?.sailsUpEvents || []) as any[]).map(e => num(e?.utc)),
  ].filter((u): u is number => u != null)
  const blocked = events.map(utc => ({ from: utc - before, to: utc + after }))

  const resS = Math.max(0.05, opts.resolutionS ?? medianResolutionS(rows))
  const expectedRows = settings.phaseLenS / resS
  const lenMs = settings.phaseLenS * 1000
  const phases: BuiltPhase[] = []
  const rejected: RejectedWindow[] = []

  for (const stretch of clearStretches(span, blocked)) {
    // Whole blocks only: a 12 s remainder is not comparable with a 30 s phase.
    for (let t = stretch.from; t + lenMs <= stretch.to; t += lenMs) {
      const i0 = lowerBound(rows, t), i1 = lowerBound(rows, t + lenMs)
      const inside = rows.slice(i0, i1)
      const why = rejectReason(settings, inside, expectedRows)
      if (why) { rejected.push({ utc: t, endUtc: t + lenMs, reason: why }); continue }
      phases.push({
        utc: t, endUtc: t + lenMs, mode: SSA_MODE, src: 'ssa', kind: 'steady',
        quality: qualityOf(settings, values(inside, 'awa'), values(inside, 'tws'), values(inside, 'bsp')),
        ...(opts.runId ? { runId: opts.runId } : {}),
      })
    }
  }

  const tally = new Map<string, number>()
  for (const r of rejected) {
    // Group by the kind of failure, not its numbers, or every phase is its own reason.
    const key = r.reason.replace(/\s*\(.*\)$/, '').replace(/ [-+]?[\d.]+.*$/, '')
    tally.set(key, (tally.get(key) || 0) + 1)
  }

  return {
    phases: [...phases, ...manoeuvrePhases(xml, span, settings, opts.runId)].sort((a, b) => a.utc - b.utc),
    rejected,
    reasons: Array.from(tally.entries()).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
  }
}

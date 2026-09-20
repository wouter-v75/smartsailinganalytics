// src/lib/wind/segment.ts
// ─────────────────────────────────────────────────────────────────────────────
// Steady-state segmentation of a GPS track.
//
// An instrumented boat gets its phases from the KND event file's <phase>
// elements. A dinghy has no event file, so the steady stretches have to be found
// in the track itself — and they are needed TWICE over:
//
//   • the wind estimator fits to segments, not to raw samples (a 10 Hz log is
//     100,000 correlated points; ~50 steady segments are the actual evidence)
//   • buildPhases needs a phase list for phaseStats to work at all
//
// Segmentation and wind estimation are mutually recursive — you need the wind to
// classify a segment's point of sail, and the segments to estimate the wind. The
// loop is resolved as EM in estimate.ts; this module is the E-step and knows
// nothing about wind.
//
// Parameters were fitted against two real Atlas tracks (Palma, 8 Feb 2026, 2 Hz
// and 10 Hz), where they produced 84 and 48 segments — 95 and 71 minutes of
// steady sailing out of a 3-hour session. See the TWD doc Part 4.
//
// Resampling to 1 Hz first is not an optimisation, it is correctness: the two
// devices in that one session logged at 2 Hz and 10 Hz, so a fixed sample-count
// window would mean different things on each. Everything here is in seconds.
// ─────────────────────────────────────────────────────────────────────────────

import { circularMean, circularR, angleDiff } from './circular'

export interface TrackRow {
  utc: number
  lat?: number | null
  lon?: number | null
  sog?: number | null
  cog?: number | null
  hdg?: number | null
  heel?: number | null
}

export interface Segment {
  /** Epoch ms of the segment's midpoint. */
  t: number
  startUtc: number
  endUtc: number
  /** Duration in seconds = number of 1 Hz samples. */
  dur: number
  /** Circular mean of the chosen bearing channel, degrees. */
  bearing: number
  /** Mean speed over ground, knots. */
  sog: number
  /** Circular mean heading, when the log carries one. Diagnostic only. */
  hdg: number | null
  /** Mean heel, when present. */
  heel: number | null
  /** Steadiness: circular resultant of the bearing, 0..1. Higher is straighter. */
  steadiness: number
}

export interface SegmentOpts {
  /** Which channel defines "straight". COG by default — see the TWD doc §16. */
  channel?: 'cog' | 'hdg'
  /** Minimum segment length, seconds. */
  minSeconds?: number
  /** Below this the boat is not sailing, knots. */
  minSogKn?: number
  /** A sample this far off the running bearing breaks the segment, degrees. */
  maxDeviationDeg?: number
  /** Reject samples whose heel is implausible (badly mounted device). */
  maxHeelDeg?: number
  /** Required circular resultant for a segment to count as straight. */
  minSteadiness?: number
  /** A gap longer than this always breaks a segment, seconds. */
  maxGapSeconds?: number
}

export const DEFAULTS: Required<SegmentOpts> = {
  channel: 'cog',
  minSeconds: 12,
  minSogKn: 2,
  maxDeviationDeg: 10,
  maxHeelDeg: 60,
  minSteadiness: 0.99,
  maxGapSeconds: 2,
}

/**
 * Resample to one sample per second, keeping the first sample in each second.
 *
 * Deliberately not averaging: averaging a bearing needs circular maths, and the
 * first sample of a second is already an honest instantaneous reading. The point
 * is to make 2 Hz and 10 Hz logs comparable, not to smooth them.
 */
export function resampleTo1Hz<T extends TrackRow>(rows: T[]): T[] {
  const seen = new Set<number>()
  const out: T[] = []
  for (const r of rows) {
    if (!Number.isFinite(r.utc)) continue
    const s = Math.floor(r.utc / 1000)   // floor buckets; round would add a bucket at the tail
    if (seen.has(s)) continue
    seen.add(s)
    out.push(r)
  }
  return out.sort((a, b) => a.utc - b.utc)
}

/** Find the straight, moving stretches of a track. */
export function findSegments(rows: TrackRow[], opts: SegmentOpts = {}): Segment[] {
  const o = { ...DEFAULTS, ...opts }
  const g = resampleTo1Hz(rows)
  const segs: Segment[] = []
  let cur: TrackRow[] = []

  const bearingOf = (r: TrackRow): number | null => {
    const v = o.channel === 'hdg' ? r.hdg : r.cog
    return Number.isFinite(v as number) ? (v as number) : null
  }

  const flush = () => {
    if (cur.length >= o.minSeconds) {
      const bs = cur.map(bearingOf).filter((v): v is number => v != null)
      const steadiness = circularR(bs)
      if (steadiness >= o.minSteadiness) {
        const hdgs = cur.map((r) => r.hdg).filter((v): v is number => Number.isFinite(v as number))
        const heels = cur.map((r) => r.heel).filter((v): v is number => Number.isFinite(v as number))
        segs.push({
          t: (cur[0].utc + cur[cur.length - 1].utc) / 2,
          startUtc: cur[0].utc,
          endUtc: cur[cur.length - 1].utc,
          dur: cur.length,
          bearing: circularMean(bs),
          sog: cur.reduce((a, r) => a + (r.sog || 0), 0) / cur.length,
          hdg: hdgs.length ? circularMean(hdgs) : null,
          heel: heels.length ? heels.reduce((a, v) => a + v, 0) / heels.length : null,
          steadiness,
        })
      }
    }
    cur = []
  }

  // Running vector sum of the current segment's bearings, so a sample can be
  // compared against the segment's MEAN rather than against its predecessor.
  // Comparing to the predecessor alone misses a gradual turn: a 20 s tack
  // through 84° moves only ~4° per second, under any sane per-sample threshold,
  // so the turn is swallowed and the whole track collapses into one crooked
  // "segment" that then fails the steadiness test. Found by a synthetic track.
  let sx = 0, sy = 0
  const RAD = Math.PI / 180
  const push = (r: TrackRow, b: number) => {
    cur.push(r); sx += Math.cos(b * RAD); sy += Math.sin(b * RAD)
  }
  const reset = (r?: TrackRow, b?: number) => {
    flush(); sx = 0; sy = 0
    if (r && b != null) push(r, b)
  }

  for (const r of g) {
    const b = bearingOf(r)
    const usable =
      b != null &&
      (r.sog ?? 0) > o.minSogKn &&
      (r.heel == null || Math.abs(r.heel) <= o.maxHeelDeg)

    if (!usable) { reset(); continue }

    if (cur.length) {
      const prev = cur[cur.length - 1]
      const gapS = (r.utc - prev.utc) / 1000
      const mean = Math.atan2(sy, sx) / RAD
      const offMean = Math.abs(angleDiff(b, mean))
      if (gapS > o.maxGapSeconds || offMean > o.maxDeviationDeg) {
        reset(r, b)
        continue
      }
    }
    push(r, b)
  }
  reset()
  return segs
}

/** Total steady time, seconds. */
export const steadySeconds = (segs: Segment[]): number =>
  segs.reduce((a, s) => a + s.dur, 0)

/**
 * Segments overlapping a window, for the rolling estimator. Half-open [from,to).
 */
export const segmentsIn = (segs: Segment[], from: number, to: number): Segment[] =>
  segs.filter((s) => s.endUtc >= from && s.startUtc < to)

/**
 * Coalesce consecutive segments that are really one leg.
 *
 * The segmenter deliberately breaks on any wobble — a speed dip, a heel
 * excursion, a second of bad fix — because for FITTING a wind, more independent
 * pieces of steady evidence is better and each carries its own duration weight.
 * But for finding MANOEUVRES that fragmentation is fatal: on a real 3-hour
 * track the median turn between adjacent segments is 5°, and 114 of 126 pairs
 * turn less than 50°, so almost every "gap" is a wobble inside one leg rather
 * than a tack.
 *
 * So: segments are the unit of evidence, LEGS are the unit of structure. This
 * merges neighbours whose bearings agree and whose gap is short, giving back
 * the same Segment shape with `dur` summed over the real steady time (not wall
 * time, which would count the wobbles as if the boat had been steady through
 * them).
 */
export function mergeLegs(
  segs: Segment[],
  opts: { toleranceDeg?: number; maxGapSec?: number } = {}
): Segment[] {
  const tol = opts.toleranceDeg ?? 15
  const maxGap = opts.maxGapSec ?? 30
  const sorted = [...segs].sort((a, b) => a.startUtc - b.startUtc)
  const out: Segment[] = []
  let group: Segment[] = []

  const flush = () => {
    if (!group.length) return
    const w = group.map((s) => s.dur)
    const total = w.reduce((a, b) => a + b, 0)
    const wmean = (pick: (s: Segment) => number | null): number | null => {
      const vals = group.filter((s) => pick(s) != null)
      if (!vals.length) return null
      return vals.reduce((a, s) => a + (pick(s) as number) * s.dur, 0) /
        vals.reduce((a, s) => a + s.dur, 0)
    }
    const bearings = group.map((s) => s.bearing)
    out.push({
      t: (group[0].startUtc + group[group.length - 1].endUtc) / 2,
      startUtc: group[0].startUtc,
      endUtc: group[group.length - 1].endUtc,
      dur: total,
      bearing: circularMean(bearings),
      sog: group.reduce((a, s) => a + s.sog * s.dur, 0) / total,
      hdg: group.some((s) => s.hdg != null) ? circularMean(
        group.filter((s) => s.hdg != null).map((s) => s.hdg as number)) : null,
      heel: wmean((s) => s.heel),
      steadiness: circularR(bearings),
    })
    group = []
  }

  for (const s of sorted) {
    if (!group.length) { group = [s]; continue }
    const prev = group[group.length - 1]
    const gapSec = (s.startUtc - prev.endUtc) / 1000
    const legBearing = circularMean(group.map((g) => g.bearing))
    if (gapSec <= maxGap && Math.abs(angleDiff(s.bearing, legBearing)) <= tol) group.push(s)
    else { flush(); group = [s] }
  }
  flush()
  return out
}

// src/lib/wind/trackEvents.ts
// ─────────────────────────────────────────────────────────────────────────────
// Manoeuvres found in a bare track, shaped as the event file buildPhases wants.
//
// buildPhases cuts the day at every tack, gybe, mark rounding and sail change so
// that no steady block ever straddles a manoeuvre. On the N76 those boundaries
// come from the KND event file. A dinghy has no event file — but it does have
// the GAPS BETWEEN STEADY SEGMENTS, and those gaps ARE the manoeuvres.
//
// So rather than teach buildPhases a second source, this produces the same shape
// it already consumes (`tackJibes`, `markRoundings`, `sailsUpEvents`,
// `dayStartUtc`, `dayStopUtc`) and buildPhases runs unchanged. Checked against
// its actual requirements: it needs bsp, tws and twa — all of which synthesise()
// supplies — and it already SKIPS any channel with no data, so the absence of
// AWA on a dinghy costs a drift check rather than breaking the build.
//
// Tack or gybe is decided by which side of the wind the boat turned through:
// a sign change in TWA with both legs upwind is a tack, both downwind a gybe.
// A turn that starts upwind and ends downwind is a bear-away, not a manoeuvre
// to judge — it still cuts the day, but it is not reported as a tack.
// ─────────────────────────────────────────────────────────────────────────────

import { angleDiff } from './circular'
import { mergeLegs, type Segment } from './segment'

export type TurnKind = 'tack' | 'gybe' | 'other'

export interface TrackEvent {
  utc: number
  kind: TurnKind
  isTack: boolean
  /** Turn size in degrees, for sanity and for the debrief. */
  turnDeg: number
  /** Seconds between the two steady segments — roughly the manoeuvre duration. */
  gapSec: number
}

/** The event-file shape buildPhases already reads. */
export interface DerivedEventFile {
  tackJibes: Array<{ utc: number; isTack: boolean }>
  /**
   * Big turns that are NOT tacks or gybes — bear-aways, heading up, roundings.
   * They still break a steady run, and buildPhases already treats a mark
   * rounding as a boundary, so this is exactly the right channel for them.
   * Reporting them as gybes, as an earlier version did, was simply wrong.
   */
  markRoundings: Array<{ utc: number }>
  sailsUpEvents: never[]
  dayStartUtc: number | null
  dayStopUtc: number | null
  /** Everything found, including the bear-aways not reported as tackJibes. */
  allTurns: TrackEvent[]
}

export interface TrackEventOpts {
  /** Smallest turn counted as a manoeuvre. */
  minTurnDeg?: number
  /** Largest — beyond this it is a circle or a bad fix, not a tack. */
  maxTurnDeg?: number
  /** Longest gap between segments still counted as one manoeuvre, seconds. */
  maxGapSec?: number
  /** |TWA| below this is upwind, above 180−this is downwind. */
  upwindDeg?: number
}

export const EVENT_DEFAULTS: Required<TrackEventOpts> = {
  minTurnDeg: 50,
  maxTurnDeg: 160,
  maxGapSec: 90,
  upwindDeg: 90,
}

/**
 * Find the manoeuvres between steady segments.
 *
 * `twd` classifies tack vs gybe. Without it every turn is reported as a tack,
 * which is the honest default: the geometry alone cannot tell them apart.
 */
export function eventsFromSegments(
  segments: Segment[],
  twd?: number | null,
  opts: TrackEventOpts = {}
): DerivedEventFile {
  const o = { ...EVENT_DEFAULTS, ...opts }
  // Merge the segmenter's fragments back into legs first — see mergeLegs. On a
  // real track 114 of 126 adjacent SEGMENT pairs turn less than 50°, so looking
  // for manoeuvres between raw segments finds almost nothing.
  const segs = mergeLegs(segments)
  const allTurns: TrackEvent[] = []

  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1], b = segs[i]
    const gapSec = (b.startUtc - a.endUtc) / 1000
    if (gapSec < 0 || gapSec > o.maxGapSec) continue
    const turnDeg = Math.abs(angleDiff(b.bearing, a.bearing))
    if (turnDeg < o.minTurnDeg || turnDeg > o.maxTurnDeg) continue

    // Every turn this big is a BOUNDARY. Only the ones that crossed the wind
    // with both legs on the same point of sail are a tack or a gybe.
    let kind: TurnKind = 'tack'
    if (twd != null) {
      const ta = angleDiff(twd, a.bearing), tb = angleDiff(twd, b.bearing)
      const crossed = Math.sign(ta) !== Math.sign(tb)
      const bothUp = Math.abs(ta) < o.upwindDeg && Math.abs(tb) < o.upwindDeg
      const bothDown = Math.abs(ta) > o.upwindDeg && Math.abs(tb) > o.upwindDeg
      kind = crossed && bothUp ? 'tack'
        : crossed && bothDown ? 'gybe'
          : 'other'          // bear-away, heading up, or a rounding
    }
    allTurns.push({
      utc: (a.endUtc + b.startUtc) / 2, kind, isTack: kind === 'tack', turnDeg, gapSec,
    })
  }

  return {
    tackJibes: allTurns
      .filter((t) => t.kind !== 'other')
      .map((t) => ({ utc: t.utc, isTack: t.kind === 'tack' })),
    markRoundings: allTurns.filter((t) => t.kind === 'other').map((t) => ({ utc: t.utc })),
    sailsUpEvents: [],
    dayStartUtc: segs.length ? segs[0].startUtc : null,
    dayStopUtc: segs.length ? segs[segs.length - 1].endUtc : null,
    allTurns,
  }
}

/** Counts for a session card: "13 tacks, 5 gybes, 4 other turns". */
export function countManoeuvres(
  ev: DerivedEventFile
): { tacks: number; gybes: number; other: number } {
  return {
    tacks: ev.allTurns.filter((t) => t.kind === 'tack').length,
    gybes: ev.allTurns.filter((t) => t.kind === 'gybe').length,
    other: ev.allTurns.filter((t) => t.kind === 'other').length,
  }
}

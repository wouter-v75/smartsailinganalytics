// src/lib/tagging/segments.ts
// ─────────────────────────────────────────────────────────────────────────────
// The day, cut into the parts a crew actually talks in:
//
//   Pre-race · Race 1 · Between races · Race 2 · … · After racing
//
// A race starts at the WARNING SIGNAL — the 5-minute gun — not at the start gun,
// because the five minutes before the line is where a race is won and it is the
// stretch everyone wants to review. It ends at the finish.
//
// Two jobs:
//
//   1. the tagging view is organised by these segments, so the crew scrolls
//      "Race 2" rather than a wall of undifferentiated afternoon;
//   2. they supply the ORDINAL IDENTITY every detection is keyed by —
//      `r2:tack:3` is "the third tack of race 2", which survives the detector
//      re-timing it by a second. See docs/tagger-architecture.md §2.3.
//
// Finishes are the awkward part: Expedition's event file records start guns but
// no finish, so unless the caller supplies them we infer one and say so in
// `endSource`. A guess that admits it is a guess can be corrected; a guess that
// pretends to be a fact cannot.
//
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

export type SegmentKind = 'pre-race' | 'race' | 'between' | 'post-race' | 'session'

/** How a segment's end was decided — surfaced in the UI so an inferred finish
 *  reads as inferred. */
export type EndSource =
  | 'finish'        // the caller gave us a real finish
  | 'last-mark'     // inferred: last mark rounding of the race, plus a grace
  | 'next-warning'  // ran straight into the next race's warning signal
  | 'day-stop'      // the event file's DayStop
  | 'data-end'      // the last sample we have
  | 'warning'       // a pre-race/between segment ending at the next warning

export interface DaySegment {
  /** Ordinal key — stable across re-derivation. 'pre' | 'r1' | 'btw1' | 'post'. */
  key: string
  kind: SegmentKind
  raceNum: number | null
  t0: number
  t1: number
  label: string
  endSource: EndSource
}

export interface SegmentGun {
  utc: number
  raceNum?: number
}

export interface SegmentInput {
  /** Start guns, from the event file's RaceStartGun events. */
  guns?: SegmentGun[] | null
  /** Real finishes, when something knows them. */
  finishes?: SegmentGun[] | null
  /** Used to infer a finish when none is given. */
  markRoundings?: { utc: number }[] | null
  dayStartUtc?: number | null
  dayStopUtc?: number | null
  /** The extent of the day's data — typically the first and last log row. Used
   *  when the event file has no DayStart/DayStop. */
  dataT0?: number | null
  dataT1?: number | null
  /** Seconds from the warning signal to the start gun. 300 = the 5-minute gun;
   *  some classes run 3, some 10. */
  warningLeadSec?: number
  /** Seconds after the last mark rounding to place an inferred finish. */
  finishGraceSec?: number
}

export const DEFAULT_WARNING_LEAD_SEC = 300
export const DEFAULT_FINISH_GRACE_SEC = 180

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** "Between races 1–2" reads better than "Between races 1 and 2" in a chip. */
const betweenLabel = (a: number, b: number) => `Between races ${a}–${b}`

/**
 * Cut a day into pre-race / race / between / post-race segments.
 *
 * With no start guns it is a training day: one 'session' segment spanning
 * whatever bounds we have. Segments never overlap, are returned in time order,
 * and zero-length ones are dropped — a race that starts the instant the previous
 * one finishes produces no 'between' segment rather than an empty one.
 */
export function segmentDay(input: SegmentInput): DaySegment[] {
  const warnLead = (input.warningLeadSec ?? DEFAULT_WARNING_LEAD_SEC) * 1000
  const grace = (input.finishGraceSec ?? DEFAULT_FINISH_GRACE_SEC) * 1000

  const guns = (input.guns || [])
    .filter((g) => isNum(g?.utc))
    .slice()
    .sort((a, b) => a.utc - b.utc)
    .map((g, i) => ({ utc: g.utc, raceNum: isNum(g.raceNum) && g.raceNum > 0 ? g.raceNum : i + 1 }))

  const marks = (input.markRoundings || []).filter((m) => isNum(m?.utc)).map((m) => m.utc).sort((a, b) => a - b)

  // The day's outer bounds. The event file's DayStart/DayStop win; otherwise the
  // extent of the data; otherwise the racing itself.
  const dayT0 = input.dayStartUtc ?? input.dataT0 ?? (guns.length ? guns[0].utc - warnLead : null)
  const dayT1raw = input.dayStopUtc ?? input.dataT1 ?? (guns.length ? guns[guns.length - 1].utc : null)
  const dayEndSource: EndSource =
    input.dayStopUtc != null ? 'day-stop' : input.dataT1 != null ? 'data-end' : 'day-stop'

  // ── Training day: no guns, one segment ────────────────────────────────────
  if (!guns.length) {
    if (!isNum(dayT0) || !isNum(dayT1raw) || dayT1raw <= dayT0) return []
    return [{
      key: 'session', kind: 'session', raceNum: null,
      t0: dayT0, t1: dayT1raw, label: 'Session', endSource: dayEndSource,
    }]
  }

  const explicitFinish = new Map<number, number>()
  for (const f of input.finishes || []) {
    if (!isNum(f?.utc)) continue
    // A finish without a race number belongs to the most recent race started.
    const rn = isNum(f.raceNum) && f.raceNum > 0
      ? f.raceNum
      : guns.filter((g) => g.utc <= f.utc).pop()?.raceNum
    if (rn != null && !explicitFinish.has(rn)) explicitFinish.set(rn, f.utc)
  }

  const warningOf = (i: number) => guns[i].utc - warnLead

  // Work out each race's window first; the gaps between them follow.
  interface Race { raceNum: number; warn: number; gun: number; finish: number; endSource: EndSource }
  const races: Race[] = []

  for (let i = 0; i < guns.length; i++) {
    const { utc: gun, raceNum } = guns[i]
    const warn = warningOf(i)
    // The hard ceiling: the next race's warning signal, else the day's end.
    const nextWarn = i + 1 < guns.length ? warningOf(i + 1) : null
    const ceiling = nextWarn ?? (isNum(dayT1raw) ? dayT1raw : gun)

    let finish: number
    let endSource: EndSource
    const given = explicitFinish.get(raceNum)
    if (isNum(given)) {
      finish = given
      endSource = 'finish'
    } else {
      // Infer: the last mark rounding inside the race window, plus the time it
      // takes to get from there to the line. No roundings — the race simply runs
      // to the ceiling, which is honest about knowing nothing.
      const inWindow = marks.filter((m) => m > gun && m < ceiling)
      if (inWindow.length) {
        finish = Math.min(inWindow[inWindow.length - 1] + grace, ceiling)
        endSource = 'last-mark'
      } else {
        finish = ceiling
        endSource = nextWarn != null ? 'next-warning' : dayEndSource
      }
    }
    // A finish can never precede its own gun, nor outlast the next warning.
    finish = Math.max(finish, gun)
    finish = Math.min(finish, ceiling)
    races.push({ raceNum, warn, gun, finish, endSource })
  }

  const out: DaySegment[] = []

  // ── Pre-race: the day up to the first warning signal ──────────────────────
  const firstWarn = races[0].warn
  if (isNum(dayT0) && firstWarn > dayT0) {
    out.push({
      key: 'pre', kind: 'pre-race', raceNum: null,
      t0: dayT0, t1: firstWarn, label: 'Pre-race', endSource: 'warning',
    })
  }

  for (let i = 0; i < races.length; i++) {
    const r = races[i]
    if (r.finish > r.warn) {
      out.push({
        key: `r${r.raceNum}`, kind: 'race', raceNum: r.raceNum,
        t0: r.warn, t1: r.finish, label: `Race ${r.raceNum}`, endSource: r.endSource,
      })
    }
    const next = races[i + 1]
    if (next && next.warn > r.finish) {
      out.push({
        key: `btw${r.raceNum}`, kind: 'between', raceNum: null,
        t0: r.finish, t1: next.warn,
        label: betweenLabel(r.raceNum, next.raceNum), endSource: 'warning',
      })
    }
  }

  // ── After racing ──────────────────────────────────────────────────────────
  const lastFinish = races[races.length - 1].finish
  if (isNum(dayT1raw) && dayT1raw > lastFinish) {
    out.push({
      key: 'post', kind: 'post-race', raceNum: null,
      t0: lastFinish, t1: dayT1raw, label: 'After racing', endSource: dayEndSource,
    })
  }

  return out
}

/** The segment a moment falls in. Returns null outside every segment — which is
 *  a real answer, not a failure: a clip shot on the tow home is outside the day. */
export function segmentAt(segments: DaySegment[], utc: number): DaySegment | null {
  if (!isNum(utc)) return null
  for (const s of segments) {
    // Half-open [t0, t1) so a moment on a boundary belongs to exactly one
    // segment — except the last, which owns its end.
    if (utc >= s.t0 && (utc < s.t1 || (s === segments[segments.length - 1] && utc === s.t1))) return s
  }
  return null
}

/** The ordinal key prefix a detection in this segment is keyed under. */
export const segmentKeyOf = (s: DaySegment | null): string => s?.key || 'day'

/** Races only, in order — the spine of the tagging view. */
export const racesOf = (segments: DaySegment[]): DaySegment[] =>
  segments.filter((s) => s.kind === 'race')

/** Is this segment's end a guess rather than a recorded fact? Drives the "~"
 *  the UI puts on an inferred finish. */
export const isInferredEnd = (s: DaySegment): boolean =>
  s.kind === 'race' && s.endSource !== 'finish'

/**
 * How long before a start gun a mark rounding stops being believable, on a day
 * whose race ends are guesswork. Half an hour: the last beat of one race and
 * the milling about before the next look identical to a rounding detector, and
 * a wrong "top mark" in the pre-start is worse than a missing one.
 */
export const DEFAULT_PRE_GUN_BLACKOUT_SEC = 1800

/**
 * Is a mark rounding at this instant worth tagging?
 *
 * Roundings are detected from the shape of the track (and from the onboard
 * system, which is no better informed about whether anybody is racing). Sailed
 * round a mark in the warm-up, or tacked twice on the way back to the dock, and
 * the detector produces a "Top mark" that the crew then has to throw away — and
 * a review queue full of things to throw away is a review queue nobody works.
 *
 * TWO RULES, and the second exists because of the first's weak spot:
 *
 *   1. RACING ONLY — after a gun and before that race's finish. Before the
 *      first gun and after the last finish there is no mark to round.
 *
 *   2. When that race's finish was INFERRED rather than recorded, the end of
 *      the race is a guess, so the half hour before any gun is treated as not
 *      racing. That window is where a guessed finish is most likely to be
 *      wrong, and it is the one place a stray rounding does real damage: it
 *      lands in the next race's count and renumbers everything after it.
 *
 * A day with no guns at all is a TRAINING day. Nothing there is "outside a
 * race", so everything is kept — which is the case the log fallback was written
 * for in the first place.
 */
export function racingRoundingFilter(opts: {
  segments: DaySegment[]
  /** Start guns, in any order. */
  gunUtcs: readonly number[]
  preGunBlackoutSec?: number
}): (utc: number) => boolean {
  const guns = (opts.gunUtcs || []).filter(isNum).slice().sort((a, b) => a - b)
  if (!guns.length) return () => true

  const blackout = (opts.preGunBlackoutSec ?? DEFAULT_PRE_GUN_BLACKOUT_SEC) * 1000
  const segments = opts.segments || []

  return (utc: number): boolean => {
    if (!isNum(utc)) return false
    // After a gun: the earliest gun is the earliest anything can be racing.
    if (utc < guns[0]) return false

    const seg = segmentAt(segments, utc)
    if (!seg || seg.kind !== 'race') return false

    // Inside a race segment but still before its gun — the warning period,
    // which the segment includes and the racing does not.
    const gun = guns.filter((g) => g <= utc).pop()
    if (gun == null || gun < seg.t0) return false

    // Rule 2: a guessed finish earns no benefit of the doubt near a gun.
    if (seg.endSource !== 'finish') {
      for (const g of guns) {
        if (utc >= g - blackout && utc < g) return false
      }
    }
    return true
  }
}

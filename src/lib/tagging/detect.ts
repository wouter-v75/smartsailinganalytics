// src/lib/tagging/detect.ts
// ─────────────────────────────────────────────────────────────────────────────
// One entry point for everything the data can work out on its own, so a day
// arrives ALREADY TAGGED and the crew's job is verification rather than typing.
//
// This wraps what SSA already has rather than replacing it:
//
//   manoeuvres.ts      tacks and gybes (event file first, TWA sign flips as the
//                      fallback) with KND-validated metrics
//   xmlEventParse.js   race guns, mark roundings, sail changes
//   segments.ts        the day cut into pre-race / race N / between / post
//
// Two things make a Detection more than a timestamp:
//
//   IDENTITY is ordinal, not temporal. `…:r2:tack:3` is "the third tack of race
//   2". Re-run the detector with a corrected timezone and the key is unchanged,
//   so the row is UPDATED rather than duplicated. Keying on the millisecond —
//   which is what src/lib/timeline/buildNodes.ts does — orphans the old row and
//   the day quietly accumulates duplicate tacks.
//
//   CONFIDENCE drives the review queue. A clean 95° tack off a 6 kn entry with
//   no gap in the log needs nobody to look at it; a 25° wobble at 4 kn next to a
//   mark rounding is exactly what a human should spend their sixty seconds on.
//   Semi-automated scoring beats manual precisely by directing attention.
//
// Pure — no React, no I/O. See docs/tagger-architecture.md §2.2.
// ─────────────────────────────────────────────────────────────────────────────

import { analyseManoeuvres, type Manoeuvre } from '../manoeuvres'
import type { LogRow } from '../phaseStats'
import { detectLegsAndRoundings, type Leg } from './detectLegs'
import { segmentDay, segmentAt, racingRoundingFilter, type DaySegment, type SegmentInput } from './segments'
import type { TagProducer } from './types'

/** The vocabulary slugs a detector can emit. Each one exists in baseTags.ts, so
 *  a detection always has a definition to hang off. */
export type DetectionSlug =
  | 'race-start' | 'topmark' | 'gate' | 'mark'
  | 'tack' | 'gybe' | 'sail-change'
  | 'day-start' | 'day-end'

export interface Detection {
  /** Ordinal identity — "<boat>:<date>:<segment>:<slug>:<n>". Stable under
   *  re-derivation; this is what ssa_tag_events.detection_key holds. */
  key: string
  slug: DetectionSlug
  label: string
  /** The instant the detector identified. */
  t0: number
  /** The end of the useful window — a manoeuvre's recovery, a gun's crossing.
   *  Equals t0 when nothing is known about the span. */
  t1: number
  segmentKey: string
  raceNum: number | null
  /** 0–1, two decimals. Sorted ascending, this IS the review queue. */
  confidence: number
  producer: TagProducer
  metrics?: Record<string, number | null>
  meta?: Record<string, unknown>
}

export interface DetectInput {
  boatId: string
  /** YYYY-MM-DD. */
  date: string
  rows?: LogRow[] | null
  /** Parsed event file — src/lib/xmlEventParse.js output. */
  xml?: any
  /** Pre-computed segments. Omit and they are derived from the same inputs. */
  segments?: DaySegment[] | null
  /** Passed through to segmentDay when segments are not supplied. */
  segmentOptions?: Pick<SegmentInput, 'warningLeadSec' | 'finishGraceSec' | 'finishes'>
  /** Ignore log-detected manoeuvres below this boat speed (kn). */
  minBsp?: number
  /** Skip the log-based mark-rounding fallback (it costs a pass over the log). */
  skipLegDetection?: boolean
  /** How long before a start gun a rounding stops being believable on a day
   *  whose race ends are inferred. Default 30 min — see racingRoundingFilter. */
  preGunBlackoutSec?: number
}

/** What detectDay worked out along the way, for callers that want it. */
export interface DetectResult {
  detections: Detection[]
  segments: DaySegment[]
  legs: Leg[]
}

// Recorded by the onboard system rather than inferred — as close to fact as this
// gets. Not 1.0: an event file can still be mis-timed, and a confidence of 1
// would mean "never show a human", which nothing earns.
const EVENT_CONFIDENCE = 0.98

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp01 = (v: number) => Math.max(0.05, Math.min(1, v))
const round2 = (v: number) => Math.round(v * 100) / 100

/**
 * How much to trust a manoeuvre the LOG found (the event file's own are trusted
 * outright). Starts from a middling 0.7 and is pushed around by the things that
 * actually distinguish a real manoeuvre from an artefact of the data.
 */
export function manoeuvreConfidence(m: Manoeuvre): number {
  if (m.source === 'event') return EVENT_CONFIDENCE
  let c = 0.7

  // A hole in the log around the manoeuvre means the sign flip could be an
  // artefact of the gap rather than the boat turning.
  if (m.logGap) c *= 0.5
  // Another manoeuvre less than a minute earlier — one of the two is probably a
  // wobble that crossed head-to-wind, not a pair of tacks.
  if (m.shortHitch) c *= 0.8
  // Sitting on a mark rounding: real turn, but it is the ROUNDING, and tagging
  // it as a tack as well is usually noise.
  if (m.atMark) c *= 0.7

  // Turn angle against the boat's target for that manoeuvre is the single best
  // discriminator available: a tack that turns 70° on a 70° target is textbook.
  if (isNum(m.turnAngle) && m.target > 0) {
    const ratio = m.turnAngle / m.target
    if (ratio >= 0.75 && ratio <= 1.3) c *= 1.2
    else if (ratio < 0.4) c *= 0.5        // barely turned — a luff, not a tack
    else if (ratio > 1.8) c *= 0.7        // turned far too far — a rounding?
  }

  // Barely moving: whatever happened, it was not a racing manoeuvre.
  if (isNum(m.bspBefore) && m.bspBefore < 3) c *= 0.7

  return round2(clamp01(c))
}

/** Manoeuvre metrics worth carrying on the tag, so it arrives with its evidence
 *  attached rather than sending the crew to another screen. */
function manoeuvreMetrics(m: Manoeuvre): Record<string, number | null> {
  return {
    tws: m.tws, bspBefore: m.bspBefore, bspAfter: m.bspAfter,
    timeTo95: m.timeTo95, turnAngle: m.turnAngle, target: m.target,
    distLost: m.distLost, maxRotation: m.maxRotation,
  }
}

/** Assign 1-based ordinals within each (segment, slug), in time order. Mutates
 *  nothing — returns the keyed detections. */
function withOrdinalKeys(
  found: Omit<Detection, 'key'>[],
  boatId: string,
  date: string
): Detection[] {
  const counters = new Map<string, number>()
  return found
    .slice()
    .sort((a, b) => a.t0 - b.t0 || a.slug.localeCompare(b.slug))
    .map((d) => {
      const bucket = `${d.segmentKey}:${d.slug}`
      const n = (counters.get(bucket) || 0) + 1
      counters.set(bucket, n)
      return { ...d, key: `${boatId}:${date}:${d.segmentKey}:${d.slug}:${n}` }
    })
}

/**
 * Everything the data can infer about a day.
 *
 * Returns detections sorted by time, each with an ordinal key, a confidence and
 * whatever metrics its detector produced. Safe on an empty day: no log, no event
 * file and no segments gives back an empty array rather than throwing.
 */
export function detectDay(input: DetectInput): Detection[] {
  const { boatId, date, xml } = input
  const rows = input.rows || []

  const segments = input.segments ?? segmentDay({
    guns: xml?.raceGuns,
    markRoundings: xml?.markRoundings,
    dayStartUtc: xml?.dayStartUtc ?? null,
    dayStopUtc: xml?.dayStopUtc ?? null,
    dataT0: rows.length ? rows[0].utc : null,
    dataT1: rows.length ? rows[rows.length - 1].utc : null,
    ...(input.segmentOptions || {}),
  })

  const seg = (utc: number) => segmentAt(segments, utc)

  // Roundings only count while the boat is racing — see racingRoundingFilter.
  // Applied to BOTH sources: the onboard system is no better informed than the
  // log about whether anybody has started, and a "Top mark" from the warm-up is
  // something the crew has to go and delete either way.
  const racing = racingRoundingFilter({
    segments,
    gunUtcs: (xml?.raceGuns || []).map((g: { utc?: unknown }) => Number(g?.utc)),
    preGunBlackoutSec: input.preGunBlackoutSec,
  })

  const found: Omit<Detection, 'key'>[] = []

  // ── The day's own two ends ────────────────────────────────────────────────
  // DayStart and DayStop are recorded facts in the event file, and every other
  // screen already measures from them — so a crew should not have to press a
  // button to say what the file has said all along. On a day with no event file
  // there is nothing here and the Racing button carries them instead.
  for (const [slug, label, utc] of [
    ['day-start', 'Day start', xml?.dayStartUtc],
    ['day-end', 'Day end', xml?.dayStopUtc],
  ] as const) {
    if (!isNum(utc)) continue
    const s = seg(utc)
    found.push({
      slug,
      label,
      t0: utc - 30_000,
      t1: utc + 30_000,
      segmentKey: s?.key || 'day',
      raceNum: s?.raceNum ?? null,
      confidence: EVENT_CONFIDENCE,
      producer: 'eventfile',
      meta: { dayEdge: slug === 'day-start' ? 'start' : 'end', utc },
    })
  }

  // ── Race starts ───────────────────────────────────────────────────────────
  // The gun is a recorded fact. The window runs from a minute before to half a
  // minute after, which is the bit of footage anyone ever wants.
  for (const g of xml?.raceGuns || []) {
    if (!isNum(g?.utc)) continue
    const s = seg(g.utc)
    found.push({
      slug: 'race-start',
      label: g.raceNum ? `Race ${g.raceNum} start` : 'Race start',
      t0: g.utc - 60_000,
      t1: g.utc + 30_000,
      segmentKey: s?.key || 'day',
      raceNum: s?.raceNum ?? (isNum(g.raceNum) ? g.raceNum : null),
      confidence: EVENT_CONFIDENCE,
      producer: 'eventfile',
      meta: { gunUtc: g.utc, raceNum: g.raceNum ?? null },
    })
  }

  // ── Mark roundings ────────────────────────────────────────────────────────
  // `gate` and `topmark` are separate vocabulary because the crew talk about
  // them separately; `isValid: false` on the event file is the onboard system
  // doubting its own measurement, so it lands lower in the review queue.
  // `racing` is applied to what gets TAGGED, not to what segmentDay was given:
  // the day's shape is still inferred from every rounding the file recorded,
  // including the ones too early to be worth a tag.
  const eventRoundings = (xml?.markRoundings || []).filter((m: any) => isNum(m?.utc) && racing(m.utc))
  for (const m of eventRoundings) {
    const s = seg(m.utc)
    const top = !!m.isTop
    found.push({
      slug: top ? 'topmark' : 'gate',
      label: top ? 'Top mark' : 'Leeward gate',
      t0: m.utc - 30_000,
      t1: m.utc + 30_000,
      segmentKey: s?.key || 'day',
      raceNum: s?.raceNum ?? null,
      confidence: m.isValid === false ? 0.6 : EVENT_CONFIDENCE,
      producer: 'eventfile',
      meta: { top, valid: m.isValid !== false, roundingUtc: m.utc },
    })
  }

  // ── Mark roundings from the log, when the event file has none ─────────────
  // A training day, or a regatta where the onboard assistant was not running,
  // otherwise has no roundings at all — and roundings are one of the two things
  // always worth pulling footage of. Only a FALLBACK: where the event file has
  // them, it is the better source and mixing the two would double-count.
  let legs: Leg[] = []
  if (!eventRoundings.length && rows.length && !input.skipLegDetection) {
    const found2 = detectLegsAndRoundings(rows)
    legs = found2.legs
    for (const r of found2.roundings) {
      if (!racing(r.utc)) continue
      const s = seg(r.utc)
      found.push({
        slug: r.isTop ? 'topmark' : 'gate',
        label: r.isTop ? 'Top mark' : 'Leeward gate',
        t0: r.utc - 30_000,
        t1: r.utc + 30_000,
        segmentKey: s?.key || 'day',
        raceNum: s?.raceNum ?? null,
        confidence: r.confidence,
        producer: 'log',
        meta: {
          top: r.isTop, roundingUtc: r.utc,
          transitionSec: r.transitionSec,
          beforeMode: r.beforeMode, afterMode: r.afterMode,
          inferred: true,
        },
      })
    }
  }

  // ── Sail changes ──────────────────────────────────────────────────────────
  for (const e of xml?.sailsUpEvents || []) {
    if (!isNum(e?.utc)) continue
    const s = seg(e.utc)
    found.push({
      slug: 'sail-change',
      label: e.label || (e.sails || []).join(' + ') || 'Sails changed',
      t0: e.utc - 20_000,
      t1: e.utc + 20_000,
      segmentKey: s?.key || 'day',
      raceNum: s?.raceNum ?? null,
      confidence: EVENT_CONFIDENCE,
      producer: 'eventfile',
      meta: { sails: e.sails || [] },
    })
  }

  // ── Tacks and gybes ───────────────────────────────────────────────────────
  // analyseManoeuvres already prefers the event file and falls back to TWA sign
  // flips in the log, and measures each one against KND's definitions.
  const manoeuvres: Manoeuvre[] = rows.length || xml
    ? analyseManoeuvres(rows, xml, input.minBsp != null ? { minBsp: input.minBsp } : {})
    : []
  for (const m of manoeuvres) {
    if (!isNum(m?.utc)) continue
    const s = seg(m.utc)
    // The window runs from the turn to the moment speed is back — which is the
    // clip worth watching, and gives the snap a start AND an end to aim at.
    const recovery = isNum(m.timeTo95) ? Math.min(Math.max(m.timeTo95, 5), 120) : 30
    found.push({
      slug: m.kind,
      label: m.kind === 'tack' ? 'Tack' : 'Gybe',
      t0: m.utc,
      t1: m.utc + recovery * 1000,
      segmentKey: s?.key || 'day',
      raceNum: s?.raceNum ?? m.race,
      confidence: manoeuvreConfidence(m),
      producer: m.source === 'event' ? 'eventfile' : 'manoeuvres',
      metrics: manoeuvreMetrics(m),
      meta: {
        source: m.source, context: m.context, atMark: m.atMark,
        shortHitch: m.shortHitch, logGap: m.logGap, sails: m.sails,
        from: m.from, to: m.to,
      },
    })
  }

  return withOrdinalKeys(found, boatId, date)
}

/** detectDay, plus the segments and legs it worked out on the way. */
export function detectDayFull(input: DetectInput): DetectResult {
  const rows = input.rows || []
  const segments = input.segments ?? segmentDay({
    guns: input.xml?.raceGuns,
    markRoundings: input.xml?.markRoundings,
    dayStartUtc: input.xml?.dayStartUtc ?? null,
    dayStopUtc: input.xml?.dayStopUtc ?? null,
    dataT0: rows.length ? rows[0].utc : null,
    dataT1: rows.length ? rows[rows.length - 1].utc : null,
    ...(input.segmentOptions || {}),
  })
  const detections = detectDay({ ...input, segments })
  const legs = (input.xml?.markRoundings || []).length || !rows.length || input.skipLegDetection
    ? []
    : detectLegsAndRoundings(rows).legs
  return { detections, segments, legs }
}

/** The review queue: unverified detections, least trustworthy first. */
export const byReviewPriority = (a: Detection, b: Detection): number =>
  a.confidence - b.confidence || a.t0 - b.t0

/** Group detections by segment, in the segments' own order — the shape the
 *  tagging view renders: Pre-race, Race 1, Between races, Race 2, … */
export function groupBySegment(
  detections: Detection[],
  segments: DaySegment[]
): { segment: DaySegment; detections: Detection[] }[] {
  const byKey = new Map<string, Detection[]>()
  for (const d of detections) {
    const list = byKey.get(d.segmentKey)
    if (list) list.push(d)
    else byKey.set(d.segmentKey, [d])
  }
  return segments.map((segment) => ({
    segment,
    detections: (byKey.get(segment.key) || []).slice().sort((a, b) => a.t0 - b.t0),
  }))
}

/**
 * Which detections are worth pulling media for, WITHOUT uploading everything.
 *
 * The whole point of tagging is a shortlist, not an archive — an AC-generation
 * boat makes hundreds of gigabytes a session and nobody can watch it. So:
 *
 *   • starts and mark roundings ALWAYS make the cut. They are the moments a
 *     debrief is built from, every time, and the crew should never have to ask.
 *   • manoeuvres do NOT, by default. A day has 60 tacks and 58 of them are
 *     unremarkable; the two worth watching get there by being tagged, not by
 *     being detected.
 *
 * Anything else reaches the debrief by a human asking for it — see the media
 * request flow in docs/tagger-architecture.md.
 */
export const ALWAYS_EXTRACT: DetectionSlug[] = ['race-start', 'topmark', 'gate']

export function autoExtractable(detections: Detection[]): Detection[] {
  return detections.filter((d) => ALWAYS_EXTRACT.includes(d.slug))
}

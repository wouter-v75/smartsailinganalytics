import { describe, it, expect } from 'vitest'
import {
  detectDay, manoeuvreConfidence, byReviewPriority, groupBySegment,
  autoExtractable, ALWAYS_EXTRACT,
} from '../detect'
import { segmentDay } from '../segments'
import type { Manoeuvre } from '../../manoeuvres'

const T = (hhmm: string, s = 0) => Date.parse(`2026-09-11T${hhmm}:${String(s).padStart(2, '0')}Z`)
const BOAT = 'n76'
const DATE = '2026-09-11'

/** A day's worth of 1 Hz log holding a steady upwind starboard tack, so
 *  analyseManoeuvres has rows to measure against without inventing manoeuvres. */
function steadyRows(from: number, to: number, twa = 40, bsp = 9): any[] {
  const out: any[] = []
  for (let t = from; t <= to; t += 1000) {
    out.push({ utc: t, twa, tws: 14, bsp, sog: bsp, hdg: 30, heel: 20 })
  }
  return out
}

const xmlTwoRaces = {
  raceGuns: [
    { utc: T('12:00'), raceNum: 1 },
    { utc: T('14:00'), raceNum: 2 },
  ],
  markRoundings: [
    { utc: T('12:20'), isTop: true, isValid: true },
    { utc: T('12:50'), isTop: false, isValid: true },
    { utc: T('14:25'), isTop: true, isValid: true },
    { utc: T('14:55'), isTop: false, isValid: false },
  ],
  sailsUpEvents: [{ utc: T('11:40'), sails: ['J2', 'Main'], label: 'J2 + Main' }],
  tackJibes: [],
  dayStartUtc: T('10:30'),
  dayStopUtc: T('16:00'),
}

describe('detectDay', () => {
  it('finds the event file’s starts, roundings and sail changes', () => {
    const d = detectDay({ boatId: BOAT, date: DATE, xml: xmlTwoRaces })
    const slugs = d.map((x) => x.slug)
    expect(slugs.filter((s) => s === 'race-start')).toHaveLength(2)
    expect(slugs.filter((s) => s === 'topmark')).toHaveLength(2)
    expect(slugs.filter((s) => s === 'gate')).toHaveLength(2)
    expect(slugs.filter((s) => s === 'sail-change')).toHaveLength(1)
  })

  it('keys detections ordinally, scoped to their segment', () => {
    const d = detectDay({ boatId: BOAT, date: DATE, xml: xmlTwoRaces })
    const keys = d.map((x) => x.key)
    expect(keys).toContain('n76:2026-09-11:r1:race-start:1')
    expect(keys).toContain('n76:2026-09-11:r1:topmark:1')
    expect(keys).toContain('n76:2026-09-11:r2:race-start:1')  // race 2's FIRST start
    expect(keys).toContain('n76:2026-09-11:pre:sail-change:1')
  })

  it('survives the detector being re-timed — the whole point of ordinal keys', () => {
    const shifted = {
      ...xmlTwoRaces,
      raceGuns: xmlTwoRaces.raceGuns.map((g) => ({ ...g, utc: g.utc + 1500 })),
      markRoundings: xmlTwoRaces.markRoundings.map((m) => ({ ...m, utc: m.utc + 1500 })),
      sailsUpEvents: xmlTwoRaces.sailsUpEvents.map((e) => ({ ...e, utc: e.utc + 1500 })),
    }
    const before = detectDay({ boatId: BOAT, date: DATE, xml: xmlTwoRaces })
    const after = detectDay({ boatId: BOAT, date: DATE, xml: shifted })
    // Same identities, different times — so a sync UPDATES rather than duplicating.
    expect(after.map((d) => d.key)).toEqual(before.map((d) => d.key))
    expect(after[0].t0).not.toBe(before[0].t0)
  })

  it('numbers repeats within a segment, not across the day', () => {
    const xml = {
      ...xmlTwoRaces,
      markRoundings: [
        { utc: T('12:20'), isTop: true }, { utc: T('12:40'), isTop: true },
        { utc: T('14:25'), isTop: true },
      ],
    }
    const keys = detectDay({ boatId: BOAT, date: DATE, xml }).map((d) => d.key)
    expect(keys).toContain('n76:2026-09-11:r1:topmark:1')
    expect(keys).toContain('n76:2026-09-11:r1:topmark:2')
    expect(keys).toContain('n76:2026-09-11:r2:topmark:1')   // restarts at 1
  })

  it('trusts the event file but not blindly', () => {
    const d = detectDay({ boatId: BOAT, date: DATE, xml: xmlTwoRaces })
    const start = d.find((x) => x.slug === 'race-start')!
    expect(start.confidence).toBeGreaterThan(0.9)
    expect(start.confidence).toBeLessThan(1)   // nothing earns "never show a human"
    // The onboard system doubting its own rounding lands lower in the queue.
    const doubted = d.filter((x) => x.slug === 'gate').sort((a, b) => a.confidence - b.confidence)[0]
    expect(doubted.confidence).toBeLessThan(0.7)
  })

  it('tags each detection with its race, via the segment', () => {
    const d = detectDay({ boatId: BOAT, date: DATE, xml: xmlTwoRaces })
    expect(d.find((x) => x.key.includes(':r1:topmark:1'))!.raceNum).toBe(1)
    expect(d.find((x) => x.key.includes(':r2:topmark:1'))!.raceNum).toBe(2)
    expect(d.find((x) => x.slug === 'sail-change')!.raceNum).toBeNull()  // pre-race
  })

  it('gives a manoeuvre a window running to its recovery', () => {
    const rows = steadyRows(T('12:00'), T('12:10'))
    const xml = {
      raceGuns: [{ utc: T('12:00'), raceNum: 1 }],
      tackJibes: [{ utc: T('12:05'), isTack: true, isValid: true }],
      markRoundings: [], sailsUpEvents: [],
      dayStartUtc: T('11:00'), dayStopUtc: T('13:00'),
    }
    const tack = detectDay({ boatId: BOAT, date: DATE, rows, xml }).find((d) => d.slug === 'tack')
    expect(tack).toBeTruthy()
    expect(tack!.t1).toBeGreaterThan(tack!.t0)
    expect(tack!.metrics).toHaveProperty('turnAngle')
  })

  it('returns an empty day rather than throwing', () => {
    expect(detectDay({ boatId: BOAT, date: DATE })).toEqual([])
    expect(detectDay({ boatId: BOAT, date: DATE, xml: {}, rows: [] })).toEqual([])
    expect(detectDay({ boatId: BOAT, date: DATE, xml: { raceGuns: [{ utc: NaN }] } })).toEqual([])
  })

  it('is sorted by time', () => {
    const d = detectDay({ boatId: BOAT, date: DATE, xml: xmlTwoRaces })
    for (let i = 1; i < d.length; i++) expect(d[i].t0).toBeGreaterThanOrEqual(d[i - 1].t0)
  })
})

describe('manoeuvreConfidence', () => {
  const base = (over: Partial<Manoeuvre> = {}): Manoeuvre => ({
    utc: T('12:05'), kind: 'tack', source: 'log', context: 'race', race: 1,
    atMark: false, intoMark: false, shortHitch: false, logGap: false,
    from: 'stbd', to: 'port', sails: 'J2', tws: 14,
    bspBefore: 9, bspAfter: 8.5, timeTo95: 22, distLost: 40,
    maxRotation: 8, turnAngle: 70, target: 70,
    ...over,
  }) as Manoeuvre

  it('trusts the event file outright', () => {
    expect(manoeuvreConfidence(base({ source: 'event' }))).toBeGreaterThan(0.95)
    // …even when every log-side signal is bad — the event file recorded it.
    expect(manoeuvreConfidence(base({ source: 'event', logGap: true, turnAngle: 5 })))
      .toBeGreaterThan(0.95)
  })

  it('rewards a textbook turn angle', () => {
    const textbook = manoeuvreConfidence(base({ turnAngle: 70, target: 70 }))
    const off = manoeuvreConfidence(base({ turnAngle: 52, target: 70 }))
    expect(textbook).toBeGreaterThan(off)
  })

  it('punishes a hole in the log hardest', () => {
    expect(manoeuvreConfidence(base({ logGap: true })))
      .toBeLessThan(manoeuvreConfidence(base({ shortHitch: true })))
  })

  it('demotes a barely-there turn — a luff, not a tack', () => {
    expect(manoeuvreConfidence(base({ turnAngle: 15, target: 70 }))).toBeLessThan(0.45)
  })

  it('demotes a manoeuvre sitting on a mark rounding', () => {
    expect(manoeuvreConfidence(base({ atMark: true })))
      .toBeLessThan(manoeuvreConfidence(base()))
  })

  it('demotes one that happened at walking pace', () => {
    expect(manoeuvreConfidence(base({ bspBefore: 1.5 })))
      .toBeLessThan(manoeuvreConfidence(base({ bspBefore: 9 })))
  })

  it('always returns a usable two-decimal probability', () => {
    for (const m of [
      base(), base({ logGap: true, shortHitch: true, atMark: true, turnAngle: 2, bspBefore: 0 }),
      base({ turnAngle: null as never }), base({ target: 0 }),
    ]) {
      const c = manoeuvreConfidence(m)
      expect(c).toBeGreaterThanOrEqual(0.05)
      expect(c).toBeLessThanOrEqual(1)
      // Two decimals, checked with a tolerance — re-multiplying by 100 to test
      // the rounding is self-defeating (0.07 * 100 is 7.000000000000001).
      expect(Math.abs(c * 100 - Math.round(c * 100))).toBeLessThan(1e-9)
    }
  })
})

describe('byReviewPriority', () => {
  it('puts the least trustworthy detection first', () => {
    const d = detectDay({ boatId: BOAT, date: DATE, xml: xmlTwoRaces }).sort(byReviewPriority)
    expect(d[0].confidence).toBeLessThanOrEqual(d[d.length - 1].confidence)
    expect(d[0].meta?.valid).toBe(false)   // the doubted gate leads the queue
  })
})

describe('groupBySegment', () => {
  it('renders the day in the crew’s own order', () => {
    const segments = segmentDay({
      guns: xmlTwoRaces.raceGuns, markRoundings: xmlTwoRaces.markRoundings,
      dayStartUtc: xmlTwoRaces.dayStartUtc, dayStopUtc: xmlTwoRaces.dayStopUtc,
    })
    const grouped = groupBySegment(detectDay({ boatId: BOAT, date: DATE, xml: xmlTwoRaces }), segments)
    expect(grouped.map((g) => g.segment.label))
      .toEqual(['Pre-race', 'Race 1', 'Between races 1–2', 'Race 2', 'After racing'])
    expect(grouped.find((g) => g.segment.key === 'r1')!.detections.length).toBeGreaterThan(0)
    // Every detection lands in exactly one group.
    const total = grouped.reduce((n, g) => n + g.detections.length, 0)
    expect(total).toBe(detectDay({ boatId: BOAT, date: DATE, xml: xmlTwoRaces }).length)
  })
})

describe('autoExtractable', () => {
  it('always pulls starts and mark roundings', () => {
    const d = detectDay({ boatId: BOAT, date: DATE, xml: xmlTwoRaces })
    const slugs = new Set(autoExtractable(d).map((x) => x.slug))
    expect(slugs).toEqual(new Set(['race-start', 'topmark', 'gate']))
  })

  it('never pulls manoeuvres — a day has 60 tacks and 58 are unremarkable', () => {
    const rows = steadyRows(T('12:00'), T('12:10'))
    const xml = {
      raceGuns: [{ utc: T('12:00'), raceNum: 1 }],
      tackJibes: [{ utc: T('12:05'), isTack: true, isValid: true }],
      markRoundings: [], sailsUpEvents: [],
      dayStartUtc: T('11:00'), dayStopUtc: T('13:00'),
    }
    const d = detectDay({ boatId: BOAT, date: DATE, rows, xml })
    expect(d.some((x) => x.slug === 'tack')).toBe(true)
    expect(autoExtractable(d).some((x) => x.slug === 'tack')).toBe(false)
    expect(ALWAYS_EXTRACT).not.toContain('tack')
    expect(ALWAYS_EXTRACT).not.toContain('gybe')
  })
})

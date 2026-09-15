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
      // The day's own ends move with everything else: a re-timed file is
      // re-timed throughout, and leaving these put would be a different test.
      dayStartUtc: xmlTwoRaces.dayStartUtc + 1500,
      dayStopUtc: xmlTwoRaces.dayStopUtc + 1500,
    }
    const before = detectDay({ boatId: BOAT, date: DATE, xml: xmlTwoRaces })
    const after = detectDay({ boatId: BOAT, date: DATE, xml: shifted })
    // Same identities, different times — so a sync UPDATES rather than duplicating.
    expect(after.map((d) => d.key)).toEqual(before.map((d) => d.key))
    // Every one of them moved, not just whichever happens to sort first.
    expect(after.map((d) => d.t0)).toEqual(before.map((d) => d.t0 + 1500))
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

describe('mark roundings from the log', () => {
  const MIN = 60_000
  const legRows = (start: number, minutes: number, twa: number): any[] => {
    const out: any[] = []
    for (let t = start; t < start + minutes * MIN; t += 1000) out.push({ utc: t, twa, bsp: 9, sog: 9, tws: 14 })
    return out
  }
  // A training day: two laps of windward-leeward, no event file at all.
  const trainingRows = [
    ...legRows(T('12:00'), 8, 42),
    ...legRows(T('12:08'), 8, 150),
    ...legRows(T('12:16'), 8, 44),
    ...legRows(T('12:24'), 8, 152),
  ]

  it('gives a day with no event file its roundings', () => {
    const d = detectDay({ boatId: BOAT, date: DATE, rows: trainingRows })
    const marks = d.filter((x) => x.slug === 'topmark' || x.slug === 'gate')
    expect(marks.length).toBeGreaterThanOrEqual(3)
    expect(marks.every((m) => m.producer === 'log')).toBe(true)
    expect(marks.every((m) => m.meta?.inferred === true)).toBe(true)
  })

  it('scores an inferred rounding below a recorded one', () => {
    const inferred = detectDay({ boatId: BOAT, date: DATE, rows: trainingRows })
      .find((x) => x.slug === 'topmark')!
    const recorded = detectDay({ boatId: BOAT, date: DATE, xml: xmlTwoRaces })
      .find((x) => x.slug === 'topmark')!
    expect(inferred.confidence).toBeLessThan(recorded.confidence)
  })

  it('defers to the event file and never double-counts', () => {
    // Event file HAS roundings, so the log fallback must not also fire.
    const d = detectDay({ boatId: BOAT, date: DATE, rows: trainingRows, xml: xmlTwoRaces })
    const marks = d.filter((x) => x.slug === 'topmark' || x.slug === 'gate')
    expect(marks.every((m) => m.producer === 'eventfile')).toBe(true)
    expect(marks).toHaveLength(4)
  })

  it('can be switched off', () => {
    const d = detectDay({ boatId: BOAT, date: DATE, rows: trainingRows, skipLegDetection: true })
    expect(d.filter((x) => x.slug === 'topmark' || x.slug === 'gate')).toHaveLength(0)
  })

  it('makes training-day roundings extractable, like any other', () => {
    const d = detectDay({ boatId: BOAT, date: DATE, rows: trainingRows })
    expect(autoExtractable(d).length).toBeGreaterThan(0)
  })
})

describe('roundings are only tagged while racing', () => {
  const marks = (d: ReturnType<typeof detectDay>) =>
    d.filter((x) => x.slug === 'topmark' || x.slug === 'gate')
  const at = (d: ReturnType<typeof detectDay>) => marks(d).map((x) => x.meta?.roundingUtc)

  it('drops the warm-up', () => {
    // A mark sailed round before the first gun is practice, and it used to
    // arrive as a "Top mark" for the crew to go and delete.
    const xml = {
      ...xmlTwoRaces,
      markRoundings: [
        { utc: T('11:00'), isTop: true, isValid: true },    // warm-up
        { utc: T('12:20'), isTop: true, isValid: true },    // race 1
      ],
    }
    expect(at(detectDay({ boatId: BOAT, date: DATE, rows: [], xml }))).toEqual([T('12:20')])
  })

  it('drops the sail home once the last race has a recorded finish', () => {
    const xml = {
      ...xmlTwoRaces,
      markRoundings: [
        { utc: T('12:20'), isTop: true, isValid: true },
        { utc: T('15:30'), isTop: false, isValid: true },   // sailing home
      ],
    }
    const d = detectDay({
      boatId: BOAT, date: DATE, rows: [], xml,
      segmentOptions: { finishes: [{ utc: T('14:45'), raceNum: 2 }] },
    })
    expect(at(d)).toEqual([T('12:20')])
  })

  it('KEEPS a late rounding when the last race has no finish — no gun to measure against', () => {
    // The limit of the rule as asked for. After the final gun there is no
    // following start to black out against, so a rounding on the way home is
    // still "after a gun and before the finish we had to guess". Recording a
    // finish for the last race is what fixes it.
    const xml = {
      ...xmlTwoRaces,
      markRoundings: [
        { utc: T('12:20'), isTop: true, isValid: true },
        { utc: T('15:30'), isTop: false, isValid: true },
      ],
    }
    expect(at(detectDay({ boatId: BOAT, date: DATE, rows: [], xml }))).toEqual([T('12:20'), T('15:30')])
  })

  it('drops the pre-start of the next race when the finish was only guessed', () => {
    // The one that matters: the stray rounding is itself what the day's shape
    // was guessed from, so it sits inside the race it invented for itself and
    // looks completely legitimate.
    const xml = {
      ...xmlTwoRaces,
      markRoundings: [
        { utc: T('12:20'), isTop: true, isValid: true },
        { utc: T('13:40'), isTop: false, isValid: true },   // milling about
      ],
    }
    expect(at(detectDay({ boatId: BOAT, date: DATE, rows: [], xml }))).toEqual([T('12:20')])
  })

  it('keeps it when a real finish says the boat was still racing', () => {
    const xml = {
      ...xmlTwoRaces,
      markRoundings: [
        { utc: T('12:20'), isTop: true, isValid: true },
        { utc: T('13:40'), isTop: false, isValid: true },
      ],
    }
    const d = detectDay({
      boatId: BOAT, date: DATE, rows: [], xml,
      segmentOptions: { finishes: [{ utc: T('13:50'), raceNum: 1 }] },
    })
    expect(at(d)).toEqual([T('12:20'), T('13:40')])
  })

  it('leaves a training day alone — there is no race to be outside of', () => {
    // No guns at all. The log fallback exists for exactly this day, and roundings
    // are one of the two things always worth pulling footage of.
    const xml = {
      raceGuns: [], markRoundings: [{ utc: T('12:20'), isTop: true, isValid: true }],
      tackJibes: [], sailsUpEvents: [], dayStartUtc: T('10:30'), dayStopUtc: T('16:00'),
    }
    expect(at(detectDay({ boatId: BOAT, date: DATE, rows: [], xml }))).toEqual([T('12:20')])
  })

  it('still knows where race 1 ended, having dropped the tag for it', () => {
    // The filter decides what gets TAGGED; the day's shape is still inferred
    // from every rounding the file recorded. Drop it from the segmentation too
    // and race 1 would suddenly run to the next warning signal.
    const xml = {
      ...xmlTwoRaces,
      markRoundings: [
        { utc: T('12:20'), isTop: true, isValid: true },
        { utc: T('13:40'), isTop: false, isValid: true },
      ],
    }
    const r1 = segmentDay({
      guns: xml.raceGuns, markRoundings: xml.markRoundings,
      dayStartUtc: xml.dayStartUtc, dayStopUtc: xml.dayStopUtc,
    }).find((s) => s.key === 'r1')!
    expect(r1.t1).toBe(T('13:43'))
    expect(at(detectDay({ boatId: BOAT, date: DATE, rows: [], xml }))).toEqual([T('12:20')])
  })

  it('does not touch the starts, the sail changes or the manoeuvres', () => {
    const xml = {
      ...xmlTwoRaces,
      markRoundings: [{ utc: T('11:00'), isTop: true, isValid: true }],
    }
    const d = detectDay({ boatId: BOAT, date: DATE, rows: [], xml })
    expect(d.some((x) => x.slug === 'race-start')).toBe(true)
    expect(d.some((x) => x.slug === 'sail-change')).toBe(true)
  })
})

describe('the day’s own two ends', () => {
  const edges = (d: ReturnType<typeof detectDay>) =>
    d.filter((x) => x.slug === 'day-start' || x.slug === 'day-end')

  it('come from the event file, so nobody has to press a button', () => {
    const d = detectDay({ boatId: BOAT, date: DATE, rows: [], xml: xmlTwoRaces })
    expect(edges(d).map((x) => [x.slug, x.meta?.utc])).toEqual([
      ['day-start', T('10:30')],
      ['day-end', T('16:00')],
    ])
  })

  it('are windows, not instants — a day starts somewhere around there', () => {
    const start = edges(detectDay({ boatId: BOAT, date: DATE, rows: [], xml: xmlTwoRaces }))[0]
    expect(start.t1 - start.t0).toBe(60_000)
  })

  it('are trusted: the file recorded them', () => {
    for (const e of edges(detectDay({ boatId: BOAT, date: DATE, rows: [], xml: xmlTwoRaces }))) {
      expect(e.confidence).toBeGreaterThanOrEqual(0.9)
      expect(e.producer).toBe('eventfile')
    }
  })

  it('are simply absent on a day with no event file', () => {
    // Which is when the Racing button carries them instead.
    expect(edges(detectDay({ boatId: BOAT, date: DATE, rows: [], xml: null }))).toEqual([])
  })

  it('takes one end without the other', () => {
    const xml = { ...xmlTwoRaces, dayStopUtc: null }
    expect(edges(detectDay({ boatId: BOAT, date: DATE, rows: [], xml })).map((x) => x.slug))
      .toEqual(['day-start'])
  })

  it('does not invent one from a junk timestamp', () => {
    const xml = { ...xmlTwoRaces, dayStartUtc: NaN, dayStopUtc: 'noon' }
    expect(edges(detectDay({ boatId: BOAT, date: DATE, rows: [], xml }))).toEqual([])
  })

  it('gets its own ordinal key like everything else', () => {
    const d = detectDay({ boatId: BOAT, date: DATE, rows: [], xml: xmlTwoRaces })
    for (const e of edges(d)) expect(e.key).toContain(e.slug)
    expect(new Set(d.map((x) => x.key)).size).toBe(d.length)
  })
})

import { describe, it, expect } from 'vitest'
import { detectLegs, roundingsFromLegs, detectLegsAndRoundings } from '../detectLegs'
import type { PhaseLogRow } from '../autoPhases'

const T0 = Date.parse('2026-09-11T12:00:00Z')
const MIN = 60_000

/** 1 Hz rows holding one point of sail for `minutes`. */
function leg(startMs: number, minutes: number, twa: number, bsp = 9): PhaseLogRow[] {
  const out: PhaseLogRow[] = []
  for (let t = startMs; t < startMs + minutes * MIN; t += 1000) {
    out.push({ utc: t, twa, bsp, sog: bsp, tws: 14 })
  }
  return out
}

/** Beat, bear away, run, round up, beat — a windward-leeward lap. */
function lap(): PhaseLogRow[] {
  return [
    ...leg(T0, 8, 42),                       // upwind stbd
    ...leg(T0 + 8 * MIN, 1, 95),             // brief reach through the bear-away
    ...leg(T0 + 9 * MIN, 8, 150),            // downwind
    ...leg(T0 + 17 * MIN, 1, 88),            // brief reach rounding up
    ...leg(T0 + 18 * MIN, 8, -44),           // upwind port
  ]
}

const at = (ms: number) => Math.round((ms - T0) / MIN)

describe('detectLegs', () => {
  it('finds the legs of a windward-leeward lap', () => {
    const legs = detectLegs(lap())
    expect(legs.map((l) => l.mode)).toEqual(['up', 'down', 'up'])
  })

  it('absorbs the brief reach at a mark rather than calling it a leg', () => {
    // The 1-minute reaches are below minLegSec, so they belong to a neighbour.
    const legs = detectLegs(lap(), { minLegSec: 90 })
    expect(legs).toHaveLength(3)
    expect(legs.some((l) => l.mode === 'reach')).toBe(false)
  })

  it('keeps a genuine reaching leg', () => {
    const rows = [...leg(T0, 8, 42), ...leg(T0 + 8 * MIN, 8, 90), ...leg(T0 + 16 * MIN, 8, 150)]
    expect(detectLegs(rows).map((l) => l.mode)).toEqual(['up', 'reach', 'down'])
  })

  it('does not produce phantom legs when TWA oscillates on a band edge', () => {
    // A boat wandering either side of 60° would run-length encode into dozens of
    // runs; merging short ones is what stops that becoming dozens of legs.
    const rows: PhaseLogRow[] = []
    for (let i = 0; i < 600; i++) {
      rows.push({ utc: T0 + i * 1000, twa: i % 2 ? 58 : 62, bsp: 9, sog: 9 })
    }
    expect(detectLegs(rows).length).toBeLessThanOrEqual(2)
  })

  it('reads tack from the sign of TWA', () => {
    const legs = detectLegs(lap())
    expect(legs[0].tack).toBe('stbd')   // +42
    expect(legs[2].tack).toBe('port')   // −44
  })

  it('ignores samples where the boat is not moving', () => {
    const rows = [...leg(T0, 8, 42, 0.5), ...leg(T0 + 8 * MIN, 8, 150, 9)]
    const legs = detectLegs(rows, { minBsp: 2 })
    expect(legs.map((l) => l.mode)).toEqual(['down'])
  })

  it('carries mean TWA and boat speed', () => {
    const [first] = detectLegs(lap())
    expect(first.twa).toBeCloseTo(42, 0)
    expect(first.bsp).toBeCloseTo(9, 1)
    expect(first.nSamples).toBeGreaterThan(400)
  })

  it('survives junk', () => {
    expect(detectLegs(null)).toEqual([])
    expect(detectLegs([])).toEqual([])
    expect(detectLegs([{ utc: T0 }])).toEqual([])
    expect(detectLegs([{ utc: NaN, twa: 40, bsp: 9 } as never])).toEqual([])
    // All TWA missing — nothing to classify.
    expect(detectLegs(leg(T0, 5, NaN))).toEqual([])
  })
})

describe('roundingsFromLegs', () => {
  it('finds a top mark and a leeward rounding on one lap', () => {
    const { roundings } = detectLegsAndRoundings(lap())
    expect(roundings.map((r) => r.isTop)).toEqual([true, false])
    expect(at(roundings[0].utc)).toBe(9)    // where the run committed
    expect(at(roundings[1].utc)).toBe(18)   // where the second beat committed
  })

  it('treats upwind → reach → downwind as ONE bear-away', () => {
    const rows = [
      ...leg(T0, 8, 42),
      ...leg(T0 + 8 * MIN, 4, 90),     // a real reaching leg, long enough to keep
      ...leg(T0 + 12 * MIN, 8, 150),
    ]
    const { legs, roundings } = detectLegsAndRoundings(rows)
    expect(legs.map((l) => l.mode)).toEqual(['up', 'reach', 'down'])
    expect(roundings).toHaveLength(1)   // not two
    expect(roundings[0].isTop).toBe(true)
  })

  it('distrusts a rounding with a long dawdle between the legs', () => {
    const quick = [...leg(T0, 8, 42), ...leg(T0 + 8 * MIN, 8, 150)]
    const dawdled = [
      ...leg(T0, 8, 42),
      ...leg(T0 + 8 * MIN, 5, 90),      // five minutes of reaching between
      ...leg(T0 + 13 * MIN, 8, 150),
    ]
    const a = detectLegsAndRoundings(quick).roundings[0]
    const b = detectLegsAndRoundings(dawdled).roundings[0]
    expect(b.confidence).toBeLessThan(a.confidence)
    expect(b.transitionSec).toBeGreaterThan(a.transitionSec)
  })

  it('distrusts a rounding between two short legs', () => {
    const short = [...leg(T0, 2, 42), ...leg(T0 + 2 * MIN, 2, 150)]
    const long = [...leg(T0, 8, 42), ...leg(T0 + 8 * MIN, 8, 150)]
    expect(detectLegsAndRoundings(short, { minLegSec: 60 }).roundings[0].confidence)
      .toBeLessThan(detectLegsAndRoundings(long).roundings[0].confidence)
  })

  it('emits nothing when the boat never changes mode', () => {
    expect(detectLegsAndRoundings(leg(T0, 30, 42)).roundings).toEqual([])
  })

  it('never emits a rounding for a tack — same point of sail either side', () => {
    // Starboard beat, tack, port beat. Both legs are upwind, so no rounding.
    const rows = [...leg(T0, 8, 42), ...leg(T0 + 8 * MIN, 8, -42)]
    const { legs, roundings } = detectLegsAndRoundings(rows)
    expect(legs.map((l) => l.mode)).toEqual(['up'])   // one continuous beat
    expect(roundings).toEqual([])
  })

  it('always returns a usable confidence', () => {
    for (const r of detectLegsAndRoundings(lap()).roundings) {
      expect(r.confidence).toBeGreaterThanOrEqual(0.05)
      expect(r.confidence).toBeLessThanOrEqual(1)
    }
  })

  it('handles a two-lap course', () => {
    const rows = [
      ...leg(T0, 8, 42), ...leg(T0 + 8 * MIN, 8, 150),
      ...leg(T0 + 16 * MIN, 8, 44), ...leg(T0 + 24 * MIN, 8, 152),
    ]
    const { roundings } = detectLegsAndRoundings(rows)
    expect(roundings.map((r) => r.isTop)).toEqual([true, false, true])
  })
})

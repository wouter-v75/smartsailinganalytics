import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain JS module, no types
import { twsConfidence, weightedSpread, confidence } from '../forecastDiagnostics'

// The deck's WEIGHTS: the nest and the good local models at 8.5, the globals ~1.
const W: Record<string, number> = {
  ICONRACE_1KM: 8.5, AROME: 8.5, HRRR: 8.5, ICONRACE: 7.0,
  NAM: 3.0, ITALIA: 1.5, ECMWF: 1.3, ICON: 1.3, DMI: 1.0, ARPEGE: 0.9,
}
const E = (o: Record<string, number>) =>
  Object.entries(o).map(([k, v]) => ({ key: k, label: k, v, w: W[k] }))

describe('weightedSpread', () => {
  it('pulls the mean toward the heavy models', () => {
    const r = weightedSpread([{ v: 10, w: 8.5 }, { v: 20, w: 1 }])
    expect(r.mean).toBeCloseTo((10 * 8.5 + 20) / 9.5, 6)
    expect(r.mean).toBeLessThan(12)          // nowhere near the unweighted 15
  })
  it('is zero for one sample and null for none', () => {
    expect(weightedSpread([{ v: 9, w: 3 }]).sigma).toBe(0)
    expect(weightedSpread([]).mean).toBeNull()
  })
})

describe('twsConfidence', () => {
  it('holds up when the leaders agree and one weak global is way off', () => {
    // ARPEGE (w 0.9) 5 kn adrift would wreck an unweighted std.
    const r = twsConfidence(E({ ICONRACE_1KM: 11.0, AROME: 11.2, ECMWF: 10.5, ARPEGE: 16.0 }))
    expect(r.label).toBe('HIGH')
    expect(r.leadKn).toBeLessThanOrEqual(0.5)
    expect(r.note).toMatch(/agree within/)
  })

  it('drops when the LEADERS disagree, even with the globals tightly clustered', () => {
    const r = twsConfidence(E({ ICONRACE_1KM: 14.0, AROME: 9.0, ECMWF: 11.4, ICON: 11.5, ARPEGE: 11.5, DMI: 11.6 }))
    expect(r.label).toBe('LOW')
    expect(r.leadKn).toBeCloseTo(5, 1)
  })

  it('ranks leader agreement above overall clustering', () => {
    const leadersAgree = twsConfidence(E({ ICONRACE_1KM: 11.0, AROME: 11.2, ECMWF: 10.5, ARPEGE: 16.0 }))
    const leadersSplit = twsConfidence(E({ ICONRACE_1KM: 14.0, AROME: 9.0, ECMWF: 11.4, ARPEGE: 11.5 }))
    expect(leadersAgree.score10).toBeGreaterThan(leadersSplit.score10)
  })

  it('reads the same spread differently in light air and in a breeze', () => {
    const light = twsConfidence(E({ ICONRACE_1KM: 5.0, AROME: 6.4, ECMWF: 5.6, ICON: 6.0 }))
    const breeze = twsConfidence(E({ ICONRACE_1KM: 20.0, AROME: 21.4, ECMWF: 20.6, ICON: 21.0 }))
    expect(breeze.score10).toBeGreaterThan(light.score10)
  })

  it('never calls a single model agreement', () => {
    const r = twsConfidence(E({ ICONRACE_1KM: 12.0 }))
    expect(r.label).toBe('LOW')
    expect(r.note).toMatch(/no cross-model check/)
  })

  it('returns null with nothing usable', () => {
    expect(twsConfidence([])).toBeNull()
    expect(twsConfidence([{ v: NaN, w: 8.5 }])).toBeNull()
  })
})

describe('confidence takes the weighted TWS score', () => {
  const base = { seaBreezeMarginality: 0.7, sigmaTwd: 12, twsKn: 11 }

  it('splits the day when the leaders split', () => {
    const agree = confidence({ ...base, twsScore10: 8.3 })
    const split = confidence({ ...base, twsScore10: 1.4 })
    expect(agree.score10).toBeGreaterThan(split.score10)
    expect(agree.label).toBe('HIGH')
    expect(split.label).not.toBe('HIGH')
  })

  it('leaves callers that pass only sigmaTws exactly as they were', () => {
    const before = confidence({ ...base, sigmaTws: 1.2 })
    const after = confidence({ ...base, sigmaTws: 1.2, twsScore10: undefined })
    expect(after).toEqual(before)
  })
})

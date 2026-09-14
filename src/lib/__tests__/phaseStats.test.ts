import { describe, it, expect } from 'vitest'
import { computePhaseStats, groupPhases, sailComboLabel, bandOf, autoBandEdges, type LogRow } from '../phaseStats'
import { preparePolar } from '../polarCalc'

const T0 = Date.UTC(2026, 8, 11, 10, 0, 0)

// 1 Hz rows over [from, to) seconds, all fields from `fields`.
const rowsFor = (from: number, to: number, fields: Record<string, number>): LogRow[] =>
  Array.from({ length: to - from }, (_, i) => ({ utc: T0 + (from + i) * 1000, ...fields }))

const phase = (from: number, to: number, mode: number) =>
  ({ utc: T0 + from * 1000, endUtc: T0 + to * 1000, mode })

const xml = {
  phases: [phase(0, 30, 1), phase(30, 60, 1), phase(60, 90, 8), phase(90, 120, 99), phase(120, 150, 1)],
  sailsUpEvents: [
    { utc: T0 - 1000, sails: ['MAIN_B 2026', 'J4_A 2026'] },
    { utc: T0 + 55_000, sails: ['MAIN_B 2026', 'J4_A 2026', 'A2+B 2026'] },
  ],
  raceGuns: [{ utc: T0 + 30_000 }, { utc: T0 + 90_000 }],
}

const common = { tws: 20, bsp: 10, trim: -0.8, forestay: 16, v1p: 2.5, v1s: 9, ruddP: 2, ruddS: 1 }
const rows: LogRow[] = [
  ...rowsFor(0, 30, { ...common, twa: 40, awa: 26, heel: -22 }),   // stbd upwind
  ...rowsFor(30, 60, { ...common, twa: -40, awa: -26, heel: 22 }), // port upwind
  ...rowsFor(60, 90, { ...common, twa: 150, awa: 85, heel: -10 }), // stbd downwind
  ...rowsFor(90, 120, { ...common, twa: -150, awa: -85 }),         // unknown mode code
  ...rowsFor(120, 122, { ...common, twa: 40 }),                    // only 2 rows
]

describe('computePhaseStats', () => {
  const stats = computePhaseStats(rows, xml)

  it('takes tack from the TWA sign and mode from the event file', () => {
    expect(stats.map(s => [s.mode, s.tack])).toEqual([
      ['up', 'stbd'], ['up', 'port'], ['down', 'stbd'], ['down', 'port'],
    ])
  })

  it('skips phases with too few log rows', () => {
    expect(stats).toHaveLength(4)
    expect(stats[0].n).toBe(30)
  })

  it('averages magnitudes for the |x| channels', () => {
    expect(stats[1].mean.twa).toBe(40)
    expect(stats[1].mean.awa).toBe(26)
    expect(stats[0].mean.heel).toBe(22)
    expect(stats[0].mean.trim).toBeCloseTo(-0.8)
  })

  it('reads the rudder and V1 loads relative to the tack', () => {
    expect(stats[0].mean.rudder).toBe(2)    // stbd: port rudder
    expect(stats[1].mean.rudder).toBe(-1)   // port: negated stbd rudder
    expect(stats[0].mean.v1wwd).toBe(9)     // stbd: windward = V1 S
    expect(stats[0].mean.v1lwd).toBe(2.5)
    expect(stats[1].mean.v1wwd).toBe(2.5)   // port: windward = V1 P
  })

  it('prefers a single RUDDER channel when the log has one', () => {
    const r = computePhaseStats(rowsFor(0, 30, { ...common, twa: -40, rudder: 1.5 }), { phases: [phase(0, 30, 1)] })
    expect(r[0].mean.rudder).toBe(1.5)
  })

  it('labels the sails hoisted at the phase midpoint', () => {
    expect(stats[0].sailCombo).toBe('J4_A 2026')
    expect(stats[2].sailCombo).toBe('A2+B 2026/J4_A 2026')
  })

  it('applies the lidar plausibility caps and needs 5 valid samples per phase', () => {
    const r = computePhaseStats([
      ...rowsFor(0, 20, { ...common, twa: 40, mnCa25: 8, tMnCa25: 5 }),
      ...rowsFor(20, 30, { ...common, twa: 40, mnCa25: 25, tMnCa25: 5 }),   // camber above 20 % → ignored
      ...rowsFor(30, 34, { ...common, twa: 40, mnCa25: 7 }),
      ...rowsFor(34, 60, { ...common, twa: 40, mnCa25: 30 }),                // only 4 valid samples in phase 2
    ], { phases: [phase(0, 30, 1), phase(30, 60, 1)] })
    expect(r[0].mean.mnCa25).toBe(8)
    expect(r[0].max.mnCa25).toBe(8)
    expect(r[0].mean.tMnCa25).toBe(5)
    expect(r[1].mean.mnCa25).toBeNull()
    expect(r[1].mean.jibCa25).toBeNull()
  })

  it('computes BSP/SOG% per sample, skipping near-zero SOG', () => {
    const r = computePhaseStats([
      ...rowsFor(0, 15, { ...common, twa: 40, sog: 10 }),
      ...rowsFor(15, 30, { ...common, twa: 40, sog: 0.5 }),
    ], { phases: [phase(0, 30, 1)] })
    expect(r[0].mean.bspSog).toBeCloseTo(100)   // BSP 10 / SOG 10; the 0.5 kn samples are left out
  })

  it('leaves polar channels empty without a polar', () => {
    expect(stats[0].mean.bspPol).toBeNull()
    expect(stats[0].mean.vmgPct).toBeNull()
  })

  it('computes BSPpol% and VMG% from a polar', () => {
    // Flat 10 kn polar: every angle is 100 %; best upwind VMG is at the lowest angle (30°).
    const flat = { entries: [10, 30].map(tws => ({ tws, points: [30, 60, 90, 120, 150, 180].map(twa => ({ twa, bsp: 10 })) })) }
    const s = computePhaseStats(rows, xml, { polar: preparePolar(flat) })
    expect(s[0].mean.bspPol).toBeCloseTo(100, 1)
    expect(s[0].mean.vmgPct).toBeCloseTo((100 * Math.cos((40 * Math.PI) / 180)) / Math.cos((30 * Math.PI) / 180), 0)
  })

  it('returns nothing without rows or phases', () => {
    expect(computePhaseStats([], xml)).toEqual([])
    expect(computePhaseStats(rows, {})).toEqual([])
  })
})

describe('groupPhases', () => {
  const stats = computePhaseStats(rows, xml)

  it('groups by mode and tack in a stable order, with counts and means', () => {
    const g = groupPhases(stats, ['mode', 'tack'])
    expect(g.map(x => [x.key.mode, x.key.tack, x.n])).toEqual([
      ['up', 'port', 1], ['up', 'stbd', 1], ['down', 'port', 1], ['down', 'stbd', 1],
    ])
    expect(groupPhases(stats, ['mode']).find(x => x.key.mode === 'up')?.mean.bsp).toBe(10)
  })

  it('numbers races from the start guns and leaves pre-start phases out', () => {
    expect(stats.map(s => s.race)).toEqual([null, 1, 1, 2])
    expect(groupPhases(stats, ['race']).map(x => [x.key.race, x.n])).toEqual([['1', 2], ['2', 1]])
  })

  it('groups into bands with explicit edges', () => {
    const withTws = stats.map((s, i) => ({ ...s, mean: { ...s.mean, tws: [19, 21, 22.9, 26][i] } }))
    const g = groupPhases(withTws, ['twsBand'], { edges: { tws: [21, 23, 25] } })
    expect(g.map(x => [x.key.twsBand, x.n])).toEqual([['under 21', 1], ['21-23', 2], ['25 plus', 1]])
  })
})

describe('bands', () => {
  it('labels values the way the KND report does', () => {
    const e = [21, 23, 25]
    expect(bandOf(20.9, e)?.label).toBe('under 21')
    expect(bandOf(21, e)?.label).toBe('21-23')
    expect(bandOf(24.99, e)?.label).toBe('23-25')
    expect(bandOf(25, e)?.label).toBe('25 plus')
    expect(bandOf(null, e)).toBeNull()
    expect(bandOf(22, [])).toBeNull()
  })

  it('places automatic edges on multiples of the width across the middle of the data', () => {
    const tws = Array.from({ length: 101 }, (_, i) => 18 + i * 0.1)   // 18 … 28 kn
    expect(autoBandEdges(tws, 2)).toEqual([20, 22, 24, 26])
    expect(autoBandEdges(tws, 2, 1)).toEqual([19, 21, 23, 25, 27])   // TWS: bands centred on even speeds
    expect(autoBandEdges([22.4, 22.5, 22.6], 2)).toEqual([22])
    expect(autoBandEdges([], 2)).toEqual([])
  })
})

describe('sailComboLabel', () => {
  it('drops the mainsail and sorts the rest', () => {
    expect(sailComboLabel(['MAIN_B 2026', 'J4_A 2026', 'A2+B 2026'])).toBe('A2+B 2026/J4_A 2026')
    expect(sailComboLabel(['MAIN_B 2026'])).toBe('MAIN_B 2026')
  })
})

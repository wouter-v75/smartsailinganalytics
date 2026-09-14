import { describe, it, expect } from 'vitest'
import { lidarTables, lidarGaps, hasLidar, formatLidarCell, lidarTableToTsv, LIDAR_VARS } from '../lidarTables'
import type { PhaseStat } from '../phaseStats'

let t = 0
const phase = (mode: 'up' | 'down', tack: 'port' | 'stbd', mean: Record<string, number>): PhaseStat =>
  ({ utc: (t += 30_000), endUtc: t + 30_000, mode, tack, sails: [], sailCombo: 'J4_A 2026', race: 1, n: 120, mean, max: {} })

// camber at 25 %: measured / target per phase
const stats = [
  phase('up', 'stbd', { mnCa25: 8, tMnCa25: 5 }),     // gap 3, +60 %
  phase('up', 'stbd', { mnCa25: 7, tMnCa25: 5 }),     // gap 2, +40 %
  phase('up', 'stbd', { mnCa25: 9, tMnCa25: 2.5 }),   // target below the CA floor of 3 → dropped
  phase('up', 'port', { mnCa25: 6, tMnCa25: 5 }),     // gap 1, +20 %
  phase('up', 'port', { mnCa25: 7, tMnCa25: 4 }),     // gap 3, +75 %
  phase('down', 'port', { mnCa25: 12, tMnCa25: 4 }),  // gap 8, +200 %
  phase('down', 'port', { mnCa25: 44, tMnCa25: 4 }),  // gap 40 → 1.5 × IQR outlier
]
const CA = LIDAR_VARS[0]

describe('lidarGaps', () => {
  it('drops targets below their floor and IQR outliers, counting every dropped phase', () => {
    const { valid, dropped } = lidarGaps(stats, 'mn', CA, 25)
    expect(valid.map(g => g.gap)).toEqual([3, 2, 1, 3, 8])
    expect(dropped).toBe(2)
    expect(valid[0].pct).toBeCloseTo(60)
  })
})

describe('lidarTables', () => {
  const [byModeTack, overall, byPoint] = lidarTables(stats, 'mn')
  const col = (tbl: typeof byModeTack, label: string) => tbl.columns.findIndex(c => c.label === label)

  it('1 · measured vs target by mode and tack, blank under 2 valid phases', () => {
    expect(byModeTack.rows.map(r => r.slice(0, 3))).toEqual([['Upwind', 'Stbd', 3], ['Upwind', 'Port', 2], ['Downwind', 'Port', 2]])
    const ca = col(byModeTack, 'CA25'), dca = col(byModeTack, 'dCA25')
    expect([byModeTack.rows[0][ca], byModeTack.rows[0][dca]]).toEqual([7.5, 2.5])
    expect([byModeTack.rows[1][ca], byModeTack.rows[1][dca]]).toEqual([6.5, 2])
    expect([byModeTack.rows[2][ca], byModeTack.rows[2][dca]]).toEqual([null, null])   // one valid phase left
    expect(byModeTack.columns.slice(3, 9).map(c => c.label)).toEqual(['CA25', 'dCA25', 'CA50', 'dCA50', 'CA75', 'dCA75'])
  })

  it('2 · overall: % diff is the mean of per-phase gaps, with median, n and dropped', () => {
    expect(overall.rows[0]).toEqual(['Camber 25%', 8, 4.6, 79, 60, 5, 2])
    expect(overall.rows.find(r => r[0] === 'Draft 25%')).toEqual(['Draft 25%', null, null, null, null, 0, 7])
  })

  it('3 · % difference by point of sail, with the phase count per mode', () => {
    expect(byPoint.columns.map(c => c.label)).toEqual(['Variable', 'Upwind (n=5)', 'Downwind (n=2)', 'Reaching (n=0)'])
    expect(byPoint.rows[0]).toEqual(['Camber 25%', 48.8, null, null])
  })

  it('knows which sails have lidar data', () => {
    expect(hasLidar(stats, 'mn')).toBe(true)
    expect(hasLidar(stats, 'jib')).toBe(false)
  })
})

describe('formatting', () => {
  it('prints gaps with a sign, n/a for missing percentages and no "-0.0"', () => {
    expect(formatLidarCell(79, 'pct1')).toBe('+79.0%')
    expect(formatLidarCell(-13.1, 'pct1')).toBe('-13.1%')
    expect(formatLidarCell(null, 'pct1')).toBe('n/a')
    expect(formatLidarCell(null, 'num1')).toBe('')
    expect(formatLidarCell(-0.04, 'num1')).toBe('0.0')
    expect(formatLidarCell(39, 'int')).toBe('39')
  })

  it('copies a table tab-separated', () => {
    const tsv = lidarTableToTsv(lidarTables(stats, 'mn')[1]).split('\n')
    expect(tsv[0]).toBe('Variable\tAvg Meas\tAvg Tgt\t% Diff\tMedian %\tn\tDropped')
    expect(tsv[1]).toBe('Camber 25%\t8.0\t4.6\t+79.0%\t+60.0%\t5\t2')
  })
})

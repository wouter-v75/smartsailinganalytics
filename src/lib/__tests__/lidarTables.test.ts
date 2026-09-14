import { describe, it, expect } from 'vitest'
import { lidarTables, lidarGaps, hasLidar, formatLidarCell, lidarTableToTsv, LIDAR_VARS, sailKindOf, phaseSailName, lidarSailOptions } from '../lidarTables'
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
    expect(byModeTack.rows.map(r => r.slice(0, 4))).toEqual([['Upwind', 'Stbd', '—', 3], ['Upwind', 'Port', '—', 2], ['Downwind', 'Port', '—', 2]])
    const ca = col(byModeTack, 'CA25'), dca = col(byModeTack, 'dCA25')
    expect([byModeTack.rows[0][ca], byModeTack.rows[0][dca]]).toEqual([7.5, 2.5])
    expect([byModeTack.rows[1][ca], byModeTack.rows[1][dca]]).toEqual([6.5, 2])
    expect([byModeTack.rows[2][ca], byModeTack.rows[2][dca]]).toEqual([null, null])   // one valid phase left
    expect(byModeTack.columns.slice(4, 10).map(c => c.label)).toEqual(['CA25', 'dCA25', 'CA50', 'dCA50', 'CA75', 'dCA75'])
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

describe('sails', () => {
  const mk = (utc: number, mode: 'up' | 'down', tack: 'port' | 'stbd', mean: Record<string, number>): PhaseStat =>
    ({ utc, endUtc: utc + 30_000, mode, tack, sails: [], sailCombo: '', race: 1, n: 120, mean, max: {} })
  const xml = {
    sailsUpEvents: [
      { utc: 0, sails: ['MAIN_A 2026', 'J3_A 2026'] },
      { utc: 100_000, sails: ['MAIN_B 2026', 'J4_A 2026'] },
      { utc: 200_000, sails: ['MAIN_B 2026', 'J4_A 2026', 'A2+B 2026'] },
    ],
  }
  const day = [
    mk(0, 'up', 'stbd', { mnCa25: 8, tMnCa25: 5, jibCa25: 12, tJibCa25: 6 }),   // MAIN_A · J3
    mk(30_000, 'up', 'stbd', { mnCa25: 7, tMnCa25: 5 }),                        // MAIN_A · J3
    mk(120_000, 'up', 'stbd', { mnCa25: 9, tMnCa25: 5, jibCa25: 10, tJibCa25: 6 }), // MAIN_B · J4
    mk(150_000, 'up', 'stbd', { mnCa25: 6, tMnCa25: 5 }),                       // MAIN_B · J4
    mk(210_000, 'down', 'port', { bsp: 20 }),                                   // A2 up, no lidar
  ]

  it('sorts inventory names into main, jib and spinnaker, and finds the one up in a phase', () => {
    expect(['MAIN_B 2026', 'J4_A 2026', 'A2+B 2026', 'S2 2025', 'Code 0'].map(sailKindOf)).toEqual(['mn', 'jib', 'spi', 'spi', 'spi'])
    expect(phaseSailName(day[2], 'jib', xml)).toBe('J4_A 2026')
    expect(phaseSailName(day[2], 'spi', xml)).toBeNull()
    expect(phaseSailName({ ...day[0], sails: ['MAIN_C 2027'] }, 'mn', xml)).toBe('MAIN_C 2027')   // the phase's own list wins
  })

  it('lists the sails in use during the lidar captures, with phase counts', () => {
    expect(lidarSailOptions(day, 'mn', xml, 'mn')).toEqual([{ name: 'MAIN_A 2026', n: 2 }, { name: 'MAIN_B 2026', n: 2 }])
    expect(lidarSailOptions(day, 'jib', xml, 'mn')).toEqual([{ name: 'J3_A 2026', n: 2 }, { name: 'J4_A 2026', n: 2 }])
    expect(lidarSailOptions(day, 'jib', xml, 'jib')).toEqual([{ name: 'J3_A 2026', n: 1 }, { name: 'J4_A 2026', n: 1 }])
    expect(lidarSailOptions(day, 'spi', xml, 'mn')).toEqual([])
  })

  it('tags rows and phases with their sails, and filters on them', () => {
    const [byModeTack, , , phases] = lidarTables(day, 'mn', { xml })
    expect(byModeTack.rows.map(r => r.slice(0, 4))).toEqual([['Upwind', 'Stbd', 'MAIN_A 2026', 2], ['Upwind', 'Stbd', 'MAIN_B 2026', 2]])
    expect(phases.columns.slice(0, 5).map(c => c.label)).toEqual(['Time', 'Main', 'Jib', 'Mode', 'Tack'])
    expect(phases.rows.map(r => r.slice(0, 5))).toEqual([
      [0, 'MAIN_A 2026', 'J3_A 2026', 'Upwind', 'Stbd'], [30_000, 'MAIN_A 2026', 'J3_A 2026', 'Upwind', 'Stbd'],
      [120_000, 'MAIN_B 2026', 'J4_A 2026', 'Upwind', 'Stbd'], [150_000, 'MAIN_B 2026', 'J4_A 2026', 'Upwind', 'Stbd'],
    ])
    const [f1, f2] = lidarTables(day, 'mn', { xml, filter: { jib: 'J4_A 2026', mn: null } })
    expect(f1.rows.map(r => r[2])).toEqual(['MAIN_B 2026'])
    expect(f2.title).toContain('MAIN_B 2026')
    // Camber 25 %: only the J4 phases — 2 valid, and the downwind J4 phase without lidar counts as dropped
    expect(f2.rows[0].slice(5)).toEqual([2, 1])
  })
})

describe('formatting', () => {
  it('prints phase times in venue time', () => {
    expect(formatLidarCell(Date.UTC(2026, 8, 11, 10, 18, 59), 'time', '', 120)).toBe('12:18:59')
  })

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

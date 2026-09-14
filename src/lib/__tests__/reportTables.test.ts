import { describe, it, expect } from 'vitest'
import { REPORTS, buildTable, tableToTsv, groupCellText, formatCell } from '../reportTables'
import type { PhaseStat } from '../phaseStats'

let t = 0
const phase = (mode: 'up' | 'down', tack: 'port' | 'stbd', mean: Record<string, number | null>, max: Record<string, number | null> = {}): PhaseStat => ({
  utc: (t += 30_000), endUtc: t + 30_000, mode, tack, sails: [], sailCombo: 'J4_A 2026', race: 1, n: 5, mean, max,
})
const spec = (id: string) => [...REPORTS.up, ...REPORTS.down, ...REPORTS.loads].find(s => s.id === id)!

const stats = [
  phase('up', 'stbd', { tws: 21, bsp: 11.6, twa: 39, bspPol: 97, vmgPct: 95, heel: 22, fsty: 16.2, logPolPct: 96 }, { fsty: 17.0 }),
  phase('up', 'stbd', { tws: 23, bsp: 11.8, twa: 40, bspPol: 99, vmgPct: 96, heel: 23, fsty: 16.0, logPolPct: 97 }, { fsty: 16.5 }),
  phase('up', 'port', { tws: 24, bsp: 11.9, twa: 41, bspPol: 98, vmgPct: 97, heel: 21, fsty: 16.1, logPolPct: 98 }, { fsty: 16.9 }),
  phase('down', 'port', { tws: 23, bsp: 21.5, twa: 146, bspPol: 97, vmgPct: 95, heel: 13 }),
]

describe('buildTable', () => {
  it('groups by sails and tack, Port first, with means and group maxima in KND column order', () => {
    const tb = buildTable(stats, spec('up-sails'))
    expect(tb.total).toBe(3)
    expect(tb.rows.map(r => [r.key.sailCombo, r.key.tack, r.n])).toEqual([['J4_A 2026', 'port', 1], ['J4_A 2026', 'stbd', 2]])
    const cols = tb.columns.map(c => c.label)
    expect(cols).toEqual(['TWS (kn)', 'BSP (kn)', 'TWA (deg)', '%Pol', 'VMG%', 'Heel (deg)', 'Fsty (t)', 'Fsty max (t)'])
    const stbd = tb.rows[1].values
    expect(stbd[cols.indexOf('BSP (kn)')]).toBeCloseTo(11.7)
    expect(stbd[cols.indexOf('Fsty (t)')]).toBeCloseTo(16.1)
    expect(stbd[cols.indexOf('Fsty max (t)')]).toBe(17.0)
  })

  it('drops columns the boat doesn’t log', () => {
    const tb = buildTable(stats, spec('up-sails'))
    expect(tb.columns.map(c => c.key)).not.toContain('mainsheet')
    expect(tb.columns.map(c => c.key)).not.toContain('v1wwd')
  })

  it('falls back to the log’s PolBsp% and hides VMG% without a polar', () => {
    const tb = buildTable(stats, spec('up-sails'), { hasPolar: false })
    const labels = tb.columns.map(c => c.label)
    expect(labels).toContain('PolBsp% (log)')
    expect(labels).not.toContain('%Pol')
    expect(labels).not.toContain('VMG%')
  })

  it('builds band tables from the given edges', () => {
    const tb = buildTable(stats, spec('up-tws'), { edges: { tws: [22, 24] } })
    expect(tb.rows.map(r => [r.key.twsBand, r.key.tack, r.n])).toEqual([
      ['under 22', 'stbd', 1], ['22-24', 'stbd', 1], ['24 plus', 'port', 1],
    ])
  })

  it('keeps each report to its points of sail', () => {
    expect(buildTable(stats, spec('down-sails')).total).toBe(1)
    expect(buildTable(stats, spec('loads')).rows.map(r => r.key.mode)).toEqual(['up', 'up', 'down'])
  })
})

describe('formatCell', () => {
  it('rounds to the column’s decimals without a minus on zero', () => {
    expect(formatCell(-0.02, 1)).toBe('0.0')     // 11 Sep downwind port trim
    expect(formatCell(-0.4, 0)).toBe('0')
    expect(formatCell(-0.06, 1)).toBe('-0.1')
    expect(formatCell(11.875, 2)).toBe('11.88')
    expect(formatCell(null, 1)).toBe('')
  })
})

describe('tableToTsv', () => {
  it('writes a header and one tab-separated line per row, with readable group labels', () => {
    const tsv = tableToTsv(buildTable(stats, spec('up-heel'), { edges: { heel: [22] } }))
    // heel 21 (port) → under 22; heel 22 and 23 (stbd) → 22 plus (edges are lower-bound inclusive)
    expect(tsv.split('\n')).toEqual([
      'Heel band (deg)\tTack\tn\tTWS (kn)\tTWA (deg)\t%Pol\tVMG%',
      'under 22\tPort\t1\t24.0\t41.0\t98.0\t97.0',
      '22 plus\tStbd\t2\t22.0\t39.5\t98.0\t95.5',
    ])
    expect(groupCellText('mode', 'down')).toBe('Downwind')
  })
})

import { describe, it, expect } from 'vitest'
import { parseSailGrid, gridToChart, groupForName, looksLikeSailGrid } from '../sailchart/grid'
import { outline, contains } from '../sailchart/geometry'
import { toCrossoverXml, parseCrossoverXml } from '../sailchart/model'

// A synthetic table in the old nav format: TWS down, TWA across, a sail per cell.
// A diagonal crossover, a reacher band, and a kite used in two separate places.
const TABLE = [
  '\t40\t50\t60\t70\t80\t90\t100\t110\t120\t130',
  '5\tJ0\tJ0\tJ0\tJ0\tJ0\tJ0\tJ0\tA1\tA1\tA1',
  '6\tJ0\tJ0\tJ0\tJ0\tJ0\tJ0\tJ0\tA1\tA1\tA1',
  '7\tJ2\tJ0\tJ0\tJ0\tJ0\tJ0\tJ0\tJ0\tA1\tA1',
  '8\tJ2\tJ2\tJ0\tJ0\tJ0\tJ0\tJ0\tJ0\tA3\tA3',
  '9\tJ2\tJ2\tJ2\tJ0\tJ0\tR2\tR2\tJ0\tA3\tA3',
  '10\tJ2\tJ2\tJ2\tJ2\tJ0\tR2\tR2\tJ0\tA2\tA2',
  '11\tJ2\tJ2\tJ2\tJ2\tJ2\tR2\tR2\tR2\tA2\tA2',
  '12\tJ3+\tJ2\tJ2\tJ2\tJ2\tJ2\tR2\tR2\tA2\tA2',
  '13\tJ3+\tJ3+\tJ2\tJ2\tJ2\tJ2\tR2\tR2\tA3\tA3',
].join('\n')

describe('old sail table → shapes', () => {
  const g = parseSailGrid(TABLE)

  it('reads the axes and cells', () => {
    expect(g.twa).toEqual([40, 50, 60, 70, 80, 90, 100, 110, 120, 130])
    expect(g.tws).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(g.cells[0][0]).toBe('J0')
    expect(g.cells[8][9]).toBe('A3')
  })

  it('reads a TRANSPOSED table the same way', () => {
    const rows = TABLE.split('\n').map(l => l.split('\t'))
    const t = rows[0].map((_, j) => rows.map(r => r[j]).join('\t')).join('\n')
    expect(parseSailGrid(t)).toEqual(g)
  })

  it('reads a comma-separated table', () => {
    expect(parseSailGrid(TABLE.replace(/\t/g, ','))).toEqual(g)
  })

  it('refuses a non-table', () => {
    expect(() => parseSailGrid('hello\nworld')).toThrow()
    expect(looksLikeSailGrid('<crossoverchart>')).toBe(false)
  })

  const chart = gridToChart(g, 'x.txt')

  it('one shape per block: A3 used in two places is two shapes', () => {
    const counts: Record<string, number> = {}
    chart.sails.forEach(s => { counts[s.name] = (counts[s.name] || 0) + 1 })
    expect(counts).toEqual({ J0: 1, A1: 1, J2: 1, A3: 2, R2: 1, A2: 1, 'J3+': 1 })
  })

  it('every cell centre lies inside a shape of its own sail', () => {
    const outl = chart.sails.map(s => ({ name: s.name, poly: outline(s.points) }))
    g.cells.forEach((r, i) => r.forEach((name, j) => {
      const p = { twa: g.twa[j], tws: g.tws[i] }
      expect(outl.some(o => o.name === name && contains(o.poly, p)), `${name} at ${p.twa}/${p.tws}`).toBe(true)
    }))
  })

  it('and almost never inside another sail’s shape', () => {
    const outl = chart.sails.map(s => ({ name: s.name, poly: outline(s.points) }))
    let foreign = 0, total = 0
    g.cells.forEach((r, i) => r.forEach((name, j) => {
      const p = { twa: g.twa[j], tws: g.tws[i] }
      total++
      if (outl.some(o => o.name !== name && contains(o.poly, p))) foreign++
    }))
    expect(foreign / total).toBeLessThan(0.05)
  })

  it('shapes are small enough to edit and stay on the chart', () => {
    for (const s of chart.sails) {
      expect(s.points.length).toBeGreaterThanOrEqual(3)
      expect(s.points.length).toBeLessThan(30)
      for (const p of s.points) {
        expect(p.twa).toBeGreaterThanOrEqual(35)
        expect(p.twa).toBeLessThanOrEqual(135)
        expect(p.tws).toBeGreaterThanOrEqual(4.5)
        expect(p.tws).toBeLessThanOrEqual(13.5)
      }
    }
  })

  it('groups by sail code and exports as crossover XML', () => {
    expect(groupForName('J3+')).toBe('Headsails')
    expect(groupForName('A1.5')).toBe('Spinnakers')
    expect(groupForName('R2')).toBe('Furlers')
    expect(groupForName('GS')).toBe('Staysails')
    const back = parseCrossoverXml(toCrossoverXml(chart))
    expect(back.sails.map(s => s.name)).toEqual(chart.sails.map(s => s.name))
  })
})

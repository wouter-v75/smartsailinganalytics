import { describe, it, expect } from 'vitest'
import { validate, type ScatterPhasesArgs } from '../askTools'
import { buildScatter } from '../askData'
import type { PhaseStat } from '../../phaseStats'

// ─────────────────────────────────────────────────────────────────────────────
// From the second live test: "show an x-y scatter plot with SOG on x-axis and
// BSP on y-axis for the season data of UPwind phases + trend lines and port and
// starboard in different colours".
//
// It came back as two separate traces against the clock, for one day. There was
// no scatter tool, so the model reached for the only thing that could draw a
// channel at all. The tool is the fix; these pin it.
// ─────────────────────────────────────────────────────────────────────────────

type Dated = PhaseStat & { date: string }
let seq = 0
const phase = (o: { tack?: 'port' | 'stbd'; sog?: number; bsp?: number; date?: string; mode?: 'up' | 'down' | 'reach' }): Dated => {
  const utc = 1_000_000 + seq++ * 30_000
  return {
    utc, endUtc: utc + 30_000, mode: o.mode ?? 'up', tack: o.tack ?? 'port',
    sails: [], sailCombo: 'J4_A 2026', race: null, n: 5, max: {},
    mean: { sog: o.sog ?? 10, bsp: o.bsp ?? 10, tws: 14 },
    date: o.date ?? '2026-09-11',
  } as Dated
}

const args = (o: Partial<ScatterPhasesArgs> = {}): ScatterPhasesArgs =>
  ({ x: 'sog', y: 'bsp', splitBy: 'tack', trend: true, maxPoints: 800, ...o })

// A clean line y = 0.5x + 5 on port, a noisier one on starboard.
const clean = Array.from({ length: 12 }, (_, i) => phase({ tack: 'port', sog: 8 + i * 0.4, bsp: 0.5 * (8 + i * 0.4) + 5 }))
const noisy = Array.from({ length: 10 }, (_, i) => phase({ tack: 'stbd', sog: 8 + i * 0.4, bsp: 9 + (i % 3) * 0.6 }))

describe('the scatter tool the first attempt did not have', () => {
  it('is reached for by name', () => {
    const v = validate('scatter_phases', JSON.stringify({ x: 'sog', y: 'bsp', modes: ['up'], dateFrom: '2026-07-27', dateTo: '2026-10-03' }))
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const a = v.args as ScatterPhasesArgs
    expect([a.x, a.y]).toEqual(['sog', 'bsp'])
    expect(a.splitBy).toBe('tack')      // port vs starboard without being asked
    expect(a.trend).toBe(true)
    expect(a.modes).toEqual(['up'])
    expect([a.dateFrom, a.dateTo]).toEqual(['2026-07-27', '2026-10-03'])
  })

  it('refuses a channel that is not one', () => {
    const v = validate('scatter_phases', JSON.stringify({ x: 'speed', y: 'bsp' }))
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.error).toContain('speed')
  })

  it('refuses a channel plotted against itself', () => {
    const v = validate('scatter_phases', JSON.stringify({ x: 'bsp', y: 'bsp' }))
    expect(v.ok).toBe(false)
  })
})

describe('buildScatter', () => {
  const built = () => buildScatter([...clean, ...noisy], args(), '2026-07-27', '2026-10-03')

  it('gives one dot per phase, split into coloured series', () => {
    const c = built().charts![0]
    expect(c.kind).toBe('scatter')
    expect(c.series.map(s => s.label)).toEqual(['Port', 'Stbd'])
    expect(c.series[0].points).toHaveLength(12)
    expect(c.series[1].points).toHaveLength(10)
  })

  it('fits a trend per series and reports how much it explains', () => {
    const c = built().charts![0]
    const port = c.series.find(s => s.label === 'Port')!
    expect(port.trend!.slope).toBeCloseTo(0.5, 6)
    expect(port.trend!.r2).toBeCloseTo(1, 6)          // it IS a line
    const stbd = c.series.find(s => s.label === 'Stbd')!
    expect(stbd.trend!.r2).toBeLessThan(0.5)          // and that one is not
  })

  it('draws the trend only across the data it was fitted to', () => {
    const port = built().charts![0].series[0]
    expect(port.trend!.x0).toBeCloseTo(8, 6)
    expect(port.trend!.x1).toBeCloseTo(12.4, 6)
  })

  it('carries both axis units, because they are different channels', () => {
    const c = built().charts![0]
    expect(c.xLabel).toBe('|SOG|')
    expect(c.yLabel).toBe('BSP')
    expect(c.unit).toBe('kn')
    expect(c.xUnit).toBe('kn')
  })

  // The whole point of the split: the model gets something it can write a
  // sentence from, and never the hundreds of coordinates.
  it('gives the model a summary table, not the dots', () => {
    const r = built()
    expect(r.tables).toHaveLength(1)
    expect(r.tables[0].rows).toHaveLength(2)
    expect(r.tables[0].columns.map(c => c.key)).toEqual(['series', 'n', 'meanX', 'meanY', 'slope', 'r2'])
    expect(r.tables[0].rows[0]).toEqual(['Port', 12, 10.2, 10.1, 0.5, 1])
  })

  it('can colour by something other than the tack', () => {
    const across = [phase({ date: '2026-09-08' }), phase({ date: '2026-09-08' }), phase({ date: '2026-09-11' })]
    const c = buildScatter(across, args({ splitBy: 'date' }), '2026-09-08', '2026-09-11').charts![0]
    expect(c.series.map(s => s.label)).toEqual(['2026-09-08', '2026-09-11'])
  })

  it('drops a phase missing either channel rather than plotting it at zero', () => {
    const blind = phase({ tack: 'port' })
    blind.mean.bsp = null
    const c = buildScatter([...clean, blind], args(), 'a', 'b').charts![0]
    expect(c.series[0].points).toHaveLength(12)
  })

  // Taking the first N would quietly crop a season chart to its opening weeks.
  it('thins evenly across the range, and still fits the trend to every point', () => {
    const many = Array.from({ length: 400 }, (_, i) => phase({ tack: 'port', sog: 8 + i * 0.01, bsp: 0.5 * (8 + i * 0.01) + 5 }))
    const r = buildScatter(many, args({ maxPoints: 100 }), 'a', 'b')
    const s = r.charts![0].series[0]
    expect(s.points.length).toBeLessThanOrEqual(100)
    expect(s.n).toBe(400)                                  // n is the real count
    expect(s.trend!.x1).toBeCloseTo(8 + 399 * 0.01, 6)     // fitted to the last point, not the last drawn
    expect(r.summary).toContain('not just the drawn ones')
  })

  it('says so rather than drawing an empty chart when no phase has both', () => {
    const r = buildScatter(clean, args({ x: 'fsty', y: 'vang' }), '2026-09-11', '2026-09-11')
    expect(r.charts).toBeUndefined()
    expect(r.unavailable).toContain('has both')
  })

  it('can be asked for no trend at all', () => {
    const c = buildScatter(clean, args({ trend: false }), 'a', 'b').charts![0]
    expect(c.series[0].trend).toBeNull()
  })
})

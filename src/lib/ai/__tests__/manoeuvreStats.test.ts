import { describe, it, expect } from 'vitest'
import { distribution, normalCurve, binCount, shapeNote } from '../distribution'
import { buildManoeuvreStats } from '../askData'
import { validate, type ManoeuvreStatsArgs } from '../askTools'
import type { Manoeuvre } from '../../manoeuvres'

// ─────────────────────────────────────────────────────────────────────────────
// "A bell curve of the rate of turn of all tacks of the season", and the same
// against TWS. turnRate is the 6 s centred on awa = 0; maxRotation is the single
// fastest step and exists on every stored manoeuvre.
// ─────────────────────────────────────────────────────────────────────────────

const man = (o: Partial<Manoeuvre> & { date: string }): Manoeuvre & { date: string } => ({
  utc: 1, kind: 'tack', source: 'event', context: 'race', race: 1, atMark: false, intoMark: false,
  shortHitch: false, logGap: false, from: 'port', to: 'stbd', sails: 'J4', tws: 14,
  bspBefore: 10, bspAfter: 10, timeTo95: 20, distLost: 40, maxRotation: 8,
  turnRate: 6, turnRateSpan: 6, turnAngle: 75, target: 70, ...o,
} as Manoeuvre & { date: string })

const args = (o: Partial<ManoeuvreStatsArgs> = {}): ManoeuvreStatsArgs =>
  ({ metric: 'turnRate', kind: 'all', splitBy: 'kind', ...o })

describe('distribution', () => {
  it('refuses to draw a shape from four points', () => {
    expect(distribution([1, 2, 3, 4])).toBeNull()
  })

  it('bins across the range and keeps every value, the maximum included', () => {
    const d = distribution(Array.from({ length: 40 }, (_, i) => i))!
    expect(d.bins.reduce((s, b) => s + b.n, 0)).toBe(40)
    expect(d.min).toBe(0)
    expect(d.max).toBe(39)
  })

  it('measures centre and spread', () => {
    const d = distribution([4, 5, 5, 5, 6, 5, 5])!
    expect(d.mean).toBeCloseTo(5, 6)
    expect(d.median).toBe(5)
    expect(d.sd).toBeGreaterThan(0)
  })

  it('survives every value being identical, without pretending there is a bell', () => {
    const d = distribution([3, 3, 3, 3, 3, 3])!
    expect(d.sd).toBe(0)
    expect(normalCurve(d)).toEqual([])
  })

  it('scales the fitted curve to the counts, so it can be read against the bars', () => {
    const d = distribution(Array.from({ length: 200 }, (_, i) => Math.sin(i) * 2 + 6))!
    const peak = Math.max(...normalCurve(d).map(p => p.y))
    const tallest = Math.max(...d.bins.map(b => b.n))
    expect(peak).toBeGreaterThan(tallest * 0.3)
    expect(peak).toBeLessThan(tallest * 3)
  })

  // A curve laid over a lopsided histogram dresses it as a bell. Say so instead.
  it('says when the spread is not a bell', () => {
    const skewed = [...Array.from({ length: 40 }, () => 5), 14, 16, 19, 22, 25]
    expect(shapeNote(distribution(skewed)!)).toMatch(/skewed|pulled by the tail/)
    expect(shapeNote(distribution(Array.from({ length: 60 }, (_, i) => 5 + Math.sin(i)))!)).toBe('')
  })

  it('picks a sane number of bars from the sample size', () => {
    expect(binCount(10)).toBeGreaterThanOrEqual(5)
    expect(binCount(5000)).toBeLessThanOrEqual(20)
    expect(binCount(100, 12)).toBe(12)
  })
})

describe('manoeuvre_stats', () => {
  const season = [
    ...Array.from({ length: 30 }, (_, i) => man({ date: '2026-09-12', turnRate: 6 + Math.sin(i) * 1.5, tws: 10 + (i % 8) })),
    ...Array.from({ length: 20 }, (_, i) => man({ date: '2026-09-10', kind: 'gybe', turnRate: 4 + Math.cos(i), tws: 12 + (i % 6) })),
  ]

  it('draws a histogram with the fitted bell over it', () => {
    const r = buildManoeuvreStats(season, args(), '2026-07-27', '2026-10-03')
    const c = r.charts![0]
    expect(c.kind).toBe('histogram')
    expect(c.binWidth).toBeGreaterThan(0)
    expect(c.refLines![0].label).toBe('normal fit')
    expect(r.summary).toContain('mean')
    expect(r.summary).toContain('normal fitted')
  })

  // Tacks and gybes are different manoeuvres; one bell over both is a lie.
  it('splits the summary by kind without being asked', () => {
    const r = buildManoeuvreStats(season, args(), 'a', 'b')
    const rows = r.tables[0].rows.map(x => String(x[0]))
    expect(rows).toContain('Tacks')
    expect(rows).toContain('Gybes')
  })

  it('draws a scatter with a trend when given something to plot against', () => {
    const r = buildManoeuvreStats(season, args({ against: 'tws' }), 'a', 'b')
    const c = r.charts![0]
    expect(c.kind).toBe('scatter')
    expect(c.xLabel).toBe('TWS')
    expect(c.series[0].trend).toBeTruthy()
  })

  it('keeps tacks only when asked for tacks', () => {
    const r = buildManoeuvreStats(season, args({ kind: 'tack' }), 'a', 'b')
    expect(r.summary).toContain('30 tacks')
  })

  // turnRate is absent on any day logged coarser than ~3 s, which is most of them.
  it('says how much of the period actually carries the metric', () => {
    const mixed = [...season.slice(0, 10), ...Array.from({ length: 40 }, (_, i) => man({ date: '2026-07-13', turnRate: null, tws: 14 + (i % 5) }))]
    const r = buildManoeuvreStats(mixed, args(), 'a', 'b')
    expect(r.summary).toContain('10 of 50')
    expect(r.summary).toContain('3 s or finer')
  })

  it('says so plainly when nothing in range carries it at all', () => {
    const none = Array.from({ length: 20 }, () => man({ date: '2026-07-13', turnRate: null }))
    const r = buildManoeuvreStats(none, args(), 'a', 'b')
    expect(r.charts).toBeUndefined()
    expect(r.unavailable).toContain('too coarsely')
  })

  it('works on maxRotation, which every stored manoeuvre has', () => {
    const r = buildManoeuvreStats(season, args({ metric: 'maxRotation' }), 'a', 'b')
    expect(r.charts![0].kind).toBe('histogram')
    expect(r.summary).not.toContain('Say so in the answer')
  })

  it('is reachable by name, and defaults to splitting tacks from gybes', () => {
    const v = validate('manoeuvre_stats', JSON.stringify({ metric: 'turnRate', kind: 'tack' }))
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect((v.args as ManoeuvreStatsArgs).splitBy).toBe('kind')
  })

  it('refuses a metric plotted against itself', () => {
    expect(validate('manoeuvre_stats', JSON.stringify({ metric: 'turnRate', against: 'turnRate' })).ok).toBe(false)
  })

  it('refuses a metric that is not one', () => {
    expect(validate('manoeuvre_stats', JSON.stringify({ metric: 'rate of turn' })).ok).toBe(false)
  })
})

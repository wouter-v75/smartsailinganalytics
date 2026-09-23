import { describe, it, expect } from 'vitest'
import { chartsFor } from '../askCharts'
import type { AnswerTable } from '../askTypes'

const byTack: AnswerTable = {
  title: 'VMG% by tack',
  columns: [
    { key: 'tack', label: 'Tack', group: true },
    { key: 'n', label: 'n' },
    { key: 'vmgPct', label: 'VMG%', unit: '%', decimals: 1 },
    { key: 'heel', label: '|HEEL|', unit: '°', decimals: 1 },
  ],
  rows: [['Port', 18, 96.4, 21.2], ['Stbd', 16, 99.1, 22.8]],
}

describe('chartsFor — the chart is a rule, not an opinion', () => {
  it('draws a bar per metric and never mixes two units on one axis', () => {
    const charts = chartsFor(byTack)
    expect(charts).toHaveLength(2)
    expect(charts.map(c => c.unit)).toEqual(['%', '°'])
    expect(charts.every(c => c.kind === 'bar')).toBe(true)
  })

  it('never charts n — a sample size is not a measurement', () => {
    expect(chartsFor(byTack).some(c => c.title === 'n')).toBe(false)
  })

  it('takes its numbers from the table, so the picture cannot disagree with it', () => {
    const [vmg] = chartsFor(byTack)
    expect(vmg.series[0].points).toEqual([{ x: 'Port', y: 96.4 }, { x: 'Stbd', y: 99.1 }])
  })

  it('makes the second grouping key the series — wind band × tack', () => {
    const banded: AnswerTable = {
      title: 'VMG% by wind band and tack',
      columns: [
        { key: 'twsBand', label: 'TWS band (kn)', group: true },
        { key: 'tack', label: 'Tack', group: true },
        { key: 'n', label: 'n' },
        { key: 'vmgPct', label: 'VMG%', unit: '%', decimals: 1 },
      ],
      rows: [
        ['12-14', 'Port', 6, 95.1], ['12-14', 'Stbd', 7, 97.0],
        ['14-16', 'Port', 9, 96.8], ['14-16', 'Stbd', 8, 99.4],
      ],
    }
    const [c] = chartsFor(banded)
    expect(c.series.map(s => s.label)).toEqual(['Port', 'Stbd'])
    expect(c.series[0].points.map(p => p.x)).toEqual(['12-14', '14-16'])
    expect(c.series[1].points.map(p => p.y)).toEqual([97.0, 99.4])
  })

  it('leaves a hole where a group has no value, rather than inventing one', () => {
    const gappy: AnswerTable = { ...byTack, rows: [['Port', 18, 96.4, null], ['Stbd', 16, 99.1, 22.8]] }
    const heel = chartsFor(gappy).find(c => c.unit === '°')!
    expect(heel.series[0].points[0].y).toBeNull()
  })

  it('draws a line, with the venue offset, for a time table', () => {
    const series: AnswerTable = {
      title: 'tws through the day',
      columns: [
        { key: 'utc', label: 'Time', group: true },
        { key: 'tws', label: 'TWS', unit: 'kn', decimals: 1 },
      ],
      rows: [[1_000_000, 14.2], [1_060_000, 15.1], [1_120_000, 13.8]],
      tzOffsetMin: 120,
    }
    const [c] = chartsFor(series, { time: true })
    expect(c.kind).toBe('line')
    expect(c.xType).toBe('time')
    expect(c.tzOffsetMin).toBe(120)
    expect(c.series[0].points).toHaveLength(3)
  })

  it('draws nothing from a single category — one bar is not a comparison', () => {
    expect(chartsFor({ ...byTack, rows: [['Port', 18, 96.4, 21.2]] })).toEqual([])
  })

  it('draws nothing from an empty table', () => {
    expect(chartsFor({ ...byTack, rows: [] })).toEqual([])
  })

  it('draws nothing when every value is missing', () => {
    const empty: AnswerTable = { ...byTack, rows: [['Port', 18, null, null], ['Stbd', 16, null, null]] }
    expect(chartsFor(empty)).toEqual([])
  })
})

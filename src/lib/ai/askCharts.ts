// src/lib/ai/askCharts.ts
// ─────────────────────────────────────────────────────────────────────────────
// The chart is chosen by a RULE from the shape of the table, never by the model.
//
// Monolithic LLM chart generation handles the simple cases and falls over on
// anything structural; a hybrid that applies formal constraints and schema
// validation reaches 99.7 % execution success (+38.4 points) — formal constraints
// are the production foundation (Springer 10.1007/978-3-032-18159-6_35). V-RECS
// and the governed-API agent both pick the mark type the same way: line for
// temporal, bar for categorical.
//
// The practical consequence matters more than the numbers: a chart drawn FROM the
// table can never disagree with the table. There is no path by which the picture
// says one thing and the row under it says another.
//
// One chart per metric — never two units on one axis. VMG% and forestay tonnes do
// not share a scale, and a dual axis is where a reader is most easily misled.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnswerTable, ChartSpec, ChartSeries } from './askTypes'

/** At most this many charts per tool call: past three, nobody reads the fourth. */
const MAX_CHARTS = 3
/** A single bar is not a comparison. */
const MIN_BAR_CATEGORIES = 2

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Charts for one executed tool's tables.
 *
 * `timeTable` marks a table whose first column is a timestamp in ms (day_timeseries)
 * — that is the only case where a line is right, because it is the only case where
 * the x axis is continuous time.
 */
export function chartsFor(table: AnswerTable, opts: { time?: boolean } = {}): ChartSpec[] {
  const groupCols = table.columns.filter(c => c.group)
  const valueCols = table.columns.filter(c => !c.group && c.key !== 'n')
  if (!valueCols.length || !table.rows.length) return []

  const idx = (key: string) => table.columns.findIndex(c => c.key === key)

  if (opts.time) {
    // x is the first column, in ms. One line chart per channel.
    const xi = 0
    return valueCols.slice(0, MAX_CHARTS).map<ChartSpec>(col => {
      const ci = idx(col.key)
      const points = table.rows
        .map(r => ({ x: r[xi], y: r[ci] }))
        .filter((p): p is { x: number; y: number | null } => isNum(p.x))
        .map(p => ({ x: p.x, y: isNum(p.y) ? p.y : null }))
      return {
        kind: 'line',
        title: col.label,
        xType: 'time',
        xLabel: 'Time',
        yLabel: col.label,
        unit: col.unit || '',
        series: [{ label: col.label, points }],
        tzOffsetMin: table.tzOffsetMin ?? 0,
      }
    }).filter(c => c.series[0].points.some(p => p.y != null))
  }

  if (!groupCols.length) return []

  // Categories from the first grouping column; a second one becomes the series
  // (port vs stbd within each wind band), which is what "by twsBand × tack" means.
  const catCol = groupCols[0]
  const seriesCol = groupCols[1] || null
  const catI = idx(catCol.key)
  const serI = seriesCol ? idx(seriesCol.key) : -1

  const categories: string[] = []
  for (const r of table.rows) {
    const c = String(r[catI] ?? '')
    if (c && !categories.includes(c)) categories.push(c)
  }
  if (categories.length < MIN_BAR_CATEGORIES && !seriesCol) return []

  const seriesKeys: string[] = []
  if (seriesCol) {
    for (const r of table.rows) {
      const s = String(r[serI] ?? '')
      if (s && !seriesKeys.includes(s)) seriesKeys.push(s)
    }
  }

  return valueCols.slice(0, MAX_CHARTS).map<ChartSpec>(col => {
    const ci = idx(col.key)
    const cell = (cat: string, ser: string | null): number | null => {
      const row = table.rows.find(r => String(r[catI] ?? '') === cat && (ser == null || String(r[serI] ?? '') === ser))
      const v = row?.[ci]
      return isNum(v) ? v : null
    }
    const series: ChartSeries[] = seriesKeys.length
      ? seriesKeys.map(s => ({ label: s, points: categories.map(c => ({ x: c, y: cell(c, s) })) }))
      : [{ label: col.label, points: categories.map(c => ({ x: c, y: cell(c, null) })) }]
    return {
      kind: 'bar',
      title: col.label,
      xType: 'category',
      xLabel: catCol.label,
      yLabel: col.label,
      unit: col.unit || '',
      series,
    }
  }).filter(c => c.series.some(s => s.points.some(p => p.y != null)))
}

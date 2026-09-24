// src/lib/ai/askTypes.ts
// ─────────────────────────────────────────────────────────────────────────────
// The shapes an executed tool hands back: a table (what the model reads and what
// the person can check), a chart drawn from that table, and media items.
//
// One table type for every tool, so the number check, the UI table and the chart
// rule all have exactly one thing to understand.
// ─────────────────────────────────────────────────────────────────────────────

export interface AnswerColumn {
  key: string
  label: string
  unit?: string
  decimals?: number
  /** A grouping column (tack, sails, wind band) rather than a measured value. */
  group?: boolean
}

export interface AnswerTable {
  title: string
  columns: AnswerColumn[]
  rows: (string | number | null)[][]
  /** Rows dropped by minPhases, so the answer can say the band was too thin. */
  droppedThin?: number
  /**
   * Venue offset in minutes, when the first column is a timestamp. It travels WITH
   * the table because a time axis rendered in UTC is the day-losing bug CLAUDE.md
   * records: the log's clock is venue-local whatever the column is called.
   */
  tzOffsetMin?: number
}

export interface Trend {
  slope: number
  intercept: number
  r2: number
  x0: number
  x1: number
}

export interface ChartSeries {
  label: string
  points: { x: number | string; y: number | null }[]
  /** Least-squares line through THIS series, on a scatter. Never drawn by the model. */
  trend?: Trend | null
  /** Points behind the series, for the legend — a trend without its n says nothing. */
  n?: number
}

export interface ChartSpec {
  kind: 'bar' | 'line' | 'scatter'
  title: string
  xType: 'category' | 'time' | 'number'
  xLabel: string
  yLabel: string
  /** The y unit. A scatter's x has its own — see xUnit. */
  unit: string
  xUnit?: string
  series: ChartSeries[]
  /** Set for a time axis: x values are UTC ms, to be shown at this offset. */
  tzOffsetMin?: number
  /**
   * Context lines drawn behind the data — the polar target, the season median.
   * They are NOT series: they have no dots, no n and no trend, because they are
   * what the dots are being judged against rather than more of the same thing.
   */
  refLines?: { label: string; color?: string; dashed?: boolean; points: { x: number; y: number }[] }[]
}

export type MediaKind = 'photo' | 'video' | 'sailscan' | 'tag'

export interface MediaItem {
  kind: MediaKind
  id: string
  title: string
  /** Venue-local clock time, already converted — the model never touches a clock. */
  atLocal: string | null
  utc: number | null
  date: string | null
  thumbUrl: string | null
  fullUrl: string | null
  /** "TWS 18.2 kn · TWA 42° · BSP 11.4 kn" — what the instruments read at that moment. */
  conditions: string | null
  note: string | null
  /** For a clip: the Bunny Stream id the player needs. */
  streamId?: string | null
  durationMs?: number | null
}

export interface ToolResult {
  /** What the model sees. Kept short and already rounded. */
  summary: string
  tables: AnswerTable[]
  media: MediaItem[]
  /**
   * Charts the tool built itself, instead of letting askCharts derive them from
   * the table. A scatter needs this: its picture is one dot per phase — hundreds
   * of them — while its TABLE is the handful of summary rows the model reads.
   * Sending the model the dots would be pointless and would blow the context.
   */
  charts?: ChartSpec[]
  /** Set when the tool could not answer — the model must relay this, not guess around it. */
  unavailable?: string
}

export const emptyResult = (summary: string, unavailable?: string): ToolResult =>
  ({ summary, tables: [], media: [], ...(unavailable ? { unavailable } : {}) })

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

export interface ChartSeries {
  label: string
  points: { x: number | string; y: number | null }[]
}

export interface ChartSpec {
  kind: 'bar' | 'line'
  title: string
  xType: 'category' | 'time'
  xLabel: string
  yLabel: string
  unit: string
  series: ChartSeries[]
  /** Set for a time axis: x values are UTC ms, to be shown at this offset. */
  tzOffsetMin?: number
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
  /** Set when the tool could not answer — the model must relay this, not guess around it. */
  unavailable?: string
}

export const emptyResult = (summary: string, unavailable?: string): ToolResult =>
  ({ summary, tables: [], media: [], ...(unavailable ? { unavailable } : {}) })

// src/lib/logPartsMerge.ts
// ─────────────────────────────────────────────────────────────────────────────
// One day's instrument log arriving as several part files, joined back into one.
//
// Expedition rolls its export to a new file during a session, so a day comes off
// the card as a folder of parts that between them are one continuous log. SSA
// imports ONE file per day, and importing the parts one after another does not
// work: each import rewrites the day's log rather than extending it.
//
// Joining is at the TEXT level on purpose. Parsing to rows and writing them back
// out would silently drop every column this codebase has no name for — and this
// export has 190 of them, most of them rig hydraulics nothing reads yet. The
// header is checked for equality, the data lines are passed through untouched,
// and the only thing this understands about a row is where its timestamp ends.
//
// THE SEAM is the one real decision. Consecutive parts overlap: the last rows of
// one reappear as the first rows of the next. Dropping any row whose stamp is
// not newer than the last kept one would also drop genuine rows inside a part
// (two rows can share a millisecond at 10 Hz), so the rule is narrower — the
// overlap is trimmed from the FRONT of each part after the first, and nothing
// inside a part is ever second-guessed.
//
// Pure: no I/O, no encoding decisions. The script reads and writes bytes.
// ─────────────────────────────────────────────────────────────────────────────

export interface LogPart {
  /** For the report — a filename, not used for ordering. */
  name: string
  /** The file's full text, header row included. */
  text: string
}

export interface PartReport {
  name: string
  rows: number
  /** Rows kept after the seam with the previous part was trimmed. */
  kept: number
  firstUtc: number | null
  lastUtc: number | null
}

export interface MergeGap {
  afterUtc: number
  beforeUtc: number
  seconds: number
}

export interface MergePlan {
  ok: true
  header: string
  /** Data lines, in time order, seams trimmed. */
  lines: string[]
  parts: PartReport[]
  gaps: MergeGap[]
  rows: number
  overlapDropped: number
  unstamped: number
  firstUtc: number | null
  lastUtc: number | null
}

export interface MergeRefusal {
  ok: false
  error: string
}

/**
 * The first cell of a row, as an instant.
 *
 * Four layouts, because Expedition writes a different one depending on how the
 * log was exported and this script should not care which:
 *
 *   30.09.2026 11:44:26.970   dotted — the log-viewer export
 *   30/09/2026 11:44:26       slash — the 2026-06 flat CSV
 *   2026-09-30 11:44:26.970   ISO — the navigator's layout
 *   45930.4892...             OLE serial / FILETIME — older exports
 *
 * Read as UTC, ALWAYS — and that is not a claim about what the clock means.
 * CLAUDE.md's first trap is that these stamps are usually local wall-time even
 * when the column says UTC, and deciding that is the importer's job, not this
 * one's. Ordering and overlap are unaffected by which zone it is, as long as
 * every part is read the same way. Nothing here is written back into a file.
 */
const OLE_EPOCH_DAYS = 25569
const MS_PER_DAY = 86400000
const FILETIME_MIN = 1e12
const FILETIME_EPOCH_MS = 11644473600000
const FILETIME_TICKS_PER_MS = 10000

export function parseStamp(cell: string | undefined): number | null {
  const s = String(cell ?? '').trim()
  if (!s) return null

  const dmy = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?/)
  if (dmy) {
    const [, dd, mm, yyRaw, hh, mi, ss] = dmy
    const yy = yyRaw.length === 2 ? 2000 + Number(yyRaw) : Number(yyRaw)
    const ms = Date.UTC(yy, Number(mm) - 1, Number(dd)) +
      (Number(hh) * 3600 + Number(mi) * 60 + Number(ss || 0)) * 1000
    return Number.isFinite(ms) ? ms : null
  }

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?/)
  if (iso) {
    const [, yy, mm, dd, hh, mi, ss] = iso
    const ms = Date.UTC(Number(yy), Number(mm) - 1, Number(dd)) +
      (Number(hh) * 3600 + Number(mi) * 60 + Number(ss || 0)) * 1000
    return Number.isFinite(ms) ? ms : null
  }

  const serial = parseFloat(s)
  if (Number.isNaN(serial)) return null
  const ms = serial >= FILETIME_MIN
    ? Math.round(serial / FILETIME_TICKS_PER_MS) - FILETIME_EPOCH_MS
    : Math.round((serial - OLE_EPOCH_DAYS) * MS_PER_DAY)
  return Number.isFinite(ms) ? ms : null
}

/** Lines with content, CR stripped, BOM off the front. */
function linesOf(text: string): string[] {
  return String(text || '')
    .replace(/^﻿/, '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0)
}

const firstCell = (line: string): string => line.slice(0, Math.max(0, line.indexOf(',')))

/**
 * Join the parts.
 *
 * Parts are ordered by their first timestamp, not by filename: `_a`, `_b`, `_j`,
 * `_k` sort the way you would hope right up until there are more than 26 of
 * them, and a part whose name breaks the pattern would silently land in the
 * wrong place. The stamps are in the file.
 */
export function planMerge(
  parts: readonly LogPart[],
  opts: { gapSec?: number } = {}
): MergePlan | MergeRefusal {
  const gapSec = opts.gapSec ?? 60
  if (!parts.length) return { ok: false, error: 'no part files found' }

  const read = parts.map((p) => {
    const lines = linesOf(p.text)
    return { name: p.name, header: lines[0] || '', body: lines.slice(1) }
  })

  const withRows = read.filter((p) => p.body.length > 0)
  if (!withRows.length) return { ok: false, error: 'every part is empty — a header and no rows' }

  // Every part must describe the same channels. A mismatch means one part came
  // from a different session or a different Expedition layout, and joining them
  // would put one file's numbers under another file's column names — the kind of
  // wrong that looks completely fine until somebody trusts a chart.
  const header = withRows[0].header
  const odd = withRows.find((p) => p.header !== header)
  if (odd) {
    const a = header.split(',')
    const b = odd.header.split(',')
    const at = a.findIndex((c, i) => c !== b[i])
    const detail = a.length !== b.length
      ? `${a.length} columns vs ${b.length}`
      : `column ${at + 1}: "${a[at]}" vs "${b[at]}"`
    return { ok: false, error: `"${odd.name}" has a different header (${detail}) — not the same log` }
  }

  const stamped = withRows.map((p) => {
    const rows = p.body.map((line) => ({ line, utc: parseStamp(firstCell(line)) }))
    const times = rows.map((r) => r.utc).filter((t): t is number => t != null)
    return { name: p.name, rows, first: times[0] ?? null, last: times[times.length - 1] ?? null }
  })

  const ordered = [...stamped].sort((x, y) => (x.first ?? Infinity) - (y.first ?? Infinity))

  const lines: string[] = []
  const reports: PartReport[] = []
  const gaps: MergeGap[] = []
  let last: number | null = null
  let overlapDropped = 0
  let unstamped = 0

  for (const part of ordered) {
    let kept = 0
    let trimming = last != null          // only ever at the FRONT of a part
    for (const r of part.rows) {
      if (r.utc == null) {
        // A row the stamp parser cannot read. Kept — it is somebody's data and
        // this is a join, not a filter — but counted, because a lot of them
        // means the timestamp layout is not what this thinks it is.
        unstamped++
        lines.push(r.line); kept++
        continue
      }
      if (trimming) {
        if (last != null && r.utc <= last) { overlapDropped++; continue }
        trimming = false
      }
      if (last != null && r.utc - last > gapSec * 1000) {
        gaps.push({ afterUtc: last, beforeUtc: r.utc, seconds: Math.round((r.utc - last) / 1000) })
      }
      lines.push(r.line); kept++
      last = r.utc
    }
    reports.push({ name: part.name, rows: part.rows.length, kept, firstUtc: part.first, lastUtc: part.last })
  }

  const firstStamped = ordered.map((p) => p.first).filter((t): t is number => t != null)[0] ?? null

  return {
    ok: true,
    header,
    lines,
    parts: reports,
    gaps,
    rows: lines.length,
    overlapDropped,
    unstamped,
    firstUtc: firstStamped,
    lastUtc: last,
  }
}

/** The merged file's text. The header, then the rows, then a trailing newline. */
export function mergedText(plan: MergePlan, eol = '\r\n'): string {
  return [plan.header, ...plan.lines].join(eol) + eol
}

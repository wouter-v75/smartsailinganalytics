// src/lib/polarFile.ts
// ─────────────────────────────────────────────────────────────────────────────
// Uploaded polar files → the `polars.data` JSONB shape, and back to a prepared
// polarCalc polar for the analytics.
//
// Accepted text formats (tab / space / comma / semicolon separated; lines starting
// with ! # ; are comments):
//   • Expedition   one row per TWS: `TWS  TWA1 BSP1  TWA2 BSP2 …`
//   • Grid         a header row of TWS values, then `TWA  BSP@TWS1  BSP@TWS2 …`.
//                  The header's first cell may be a label ("twa/tws") or 0. A grid
//                  whose header holds the ANGLES (values > 60) is read transposed.
//
// Workbooks (parsePolarWorkbook, e.g. "NS76 Polar Development History.xlsx"):
//   • every sheet whose first row starts "TWS/TWA" is one polar version (TWS down,
//     TWA across), named after the sheet;
//   • a "<version> Targets" sheet (Up BSP / Up TWA / Dn BSP / Dn TWA per TWS) becomes
//     that version's headline targets;
//   • a list row "<version name> | <note>" (the "Polar List" sheet) becomes its notes.
//   Versions are matched on their version token ("v1.6").
//
// Stored data keeps the exact points (`entries`) for the analytics, plus a TWS×TWA
// `matrices.bsp` grid and a `headline` (best VMG angle + speed per TWS) so the
// Targets tab and its print sheet render an uploaded polar like the bundled V1.4.
// ─────────────────────────────────────────────────────────────────────────────

import { parsePolarFile, preparePolar } from './polarCalc'

export interface PolarPoint { twa: number; bsp: number }
export interface PolarEntry { tws: number; points: PolarPoint[] }

interface Target { bsp: number | null; twa: number | null; awa: null; heel: null; rudd: null }
export interface HeadlineRow { tws: number; up: Target; dn: Target }

export interface PolarVersion {
  name: string
  entries: PolarEntry[]
  notes: string | null
  headline: HeadlineRow[] | null
}

const SEP = /[\t ,;]+/
const isComment = (l: string) => /^[!#;]/.test(l)
const toNum = (s: string) => (s === '' ? NaN : Number(s))

const trimRow = (r: unknown[]): string[] => {
  const x = (r || []).map(v => String(v ?? '').trim())
  while (x.length && x[x.length - 1] === '') x.pop()
  return x
}

// A table whose first row is the header → entries, or null if it isn't a polar grid.
// Reading stops at the first row that doesn't start with a number.
export function gridEntries(table: unknown[][]): PolarEntry[] | null {
  const rows = table.map(trimRow).filter(r => r.length)
  if (rows.length < 3) return null
  const head = rows[0]
  const labelled = Number.isNaN(toNum(head[0]))
  const cols = head.slice(1).map(toNum)
  if (cols.length < 2 || cols.some(Number.isNaN)) return null
  if (!labelled && toNum(head[0]) !== 0) return null

  const body: number[][] = []
  for (const r of rows.slice(1)) {
    const v = r.map(toNum)
    if (Number.isNaN(v[0])) break
    body.push(v)
  }
  if (body.length < 2) return null

  // Header of angles (e.g. 0 … 180) → rows are TWS; header of wind speeds → rows are TWA.
  const transposed = Math.max(...cols) > 60
  const entries: PolarEntry[] = []
  if (transposed) {
    for (const r of body) {
      const points = cols
        .map((twa, j) => ({ twa, bsp: r[j + 1] }))
        .filter(p => Number.isFinite(p.bsp) && p.bsp > 0)
      if (points.length >= 2) entries.push({ tws: r[0], points })
    }
  } else {
    cols.forEach((tws, j) => {
      const points = body
        .map(r => ({ twa: r[0], bsp: r[j + 1] }))
        .filter(p => Number.isFinite(p.bsp) && p.bsp > 0 && p.twa > 0 && p.twa <= 180)
      if (points.length >= 2) entries.push({ tws, points })
    })
  }
  return entries.length >= 2 ? sortEntries(entries) : null
}

const sortEntries = (entries: PolarEntry[]): PolarEntry[] =>
  entries
    .map(e => ({ tws: e.tws, points: [...e.points].sort((a, b) => a.twa - b.twa) }))
    .sort((a, b) => a.tws - b.tws)

// Parse a polar file's text into raw entries (sorted by TWS, points by TWA).
export function parsePolarText(text: string): PolarEntry[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !isComment(l))
  if (lines.length < 2) throw new Error('Polar file too short')
  const grid = gridEntries(lines.map(l => l.split(SEP)))
  if (grid) return grid
  return sortEntries(parsePolarFile(text).entries.map((e: any) => ({
    tws: e.tws,
    points: e.points.map((p: PolarPoint) => ({ twa: p.twa, bsp: p.bsp })),
  })))
}

// ── Workbooks ───────────────────────────────────────────────────────────────

const versionKey = (s: string) =>
  s.match(/v\d+(?:\.\d+)*/i)?.[0].toLowerCase() ?? s.trim().toLowerCase()
const versionNums = (s: string) => (versionKey(s).match(/\d+/g) || []).map(Number)
const cmpVersion = (a: string, b: string) => {
  const x = versionNums(a), y = versionNums(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1)
    if (d) return d
  }
  return a.localeCompare(b)
}
const nonEmptyRows = (rows: unknown[][]) => rows.map(trimRow).filter(r => r.length)
const r1 = (v: number) => Math.round(v * 10) / 10
const r2 = (v: number) => Math.round(v * 100) / 100
const numOrNull = (s: string | undefined) => {
  const n = toNum(String(s ?? '').trim())
  return Number.isFinite(n) ? r2(n) : null
}

function targetSheet(rows: string[][], sheetName: string): { key: string; headline: HeadlineRow[] } | null {
  const h = rows.findIndex(r => r.some(c => /^up\s*bsp$/i.test(c)))
  if (h < 0) return null
  const col = (re: RegExp) => rows[h].findIndex(c => re.test(c))
  const upBsp = col(/^up\s*bsp$/i), upTwa = col(/^up\s*twa$/i)
  const dnBsp = col(/^dn\s*bsp$/i), dnTwa = col(/^dn\s*twa$/i)
  const headline: HeadlineRow[] = []
  for (const r of rows.slice(h + 1)) {
    const tws = toNum(r[0])
    if (Number.isNaN(tws)) break
    const t = (bsp: number, twa: number): Target =>
      ({ bsp: bsp >= 0 ? numOrNull(r[bsp]) : null, twa: twa >= 0 ? numOrNull(r[twa]) : null, awa: null, heel: null, rudd: null })
    headline.push({ tws, up: t(upBsp, upTwa), dn: t(dnBsp, dnTwa) })
  }
  const title = h > 0 ? rows[0][0] : sheetName
  return headline.length ? { key: versionKey(title || sheetName), headline } : null
}

export function parsePolarWorkbook(sheets: { name: string; rows: unknown[][] }[]): PolarVersion[] {
  const grids: { name: string; entries: PolarEntry[] }[] = []
  const headlines = new Map<string, HeadlineRow[]>()
  const listRows: string[][] = []

  for (const s of sheets) {
    const rows = nonEmptyRows(s.rows)
    if (!rows.length) continue
    if (/^tws\s*[/\\]\s*twa/i.test(rows[0][0])) {
      const entries = gridEntries(rows)
      if (entries) grids.push({ name: s.name.trim(), entries })
      continue
    }
    const t = targetSheet(rows, s.name)
    if (t) { headlines.set(t.key, t.headline); continue }
    listRows.push(...rows.filter(r => r.length >= 2 && r[0] && r[1]))
  }

  return grids
    .map(g => {
      const key = versionKey(g.name)
      const listed = listRows.find(r => versionKey(r[0]) === key)
      return {
        // Excel caps sheet names at 31 characters — prefer the full name from the list.
        name: listed && listed[0].length > g.name.length ? listed[0] : g.name,
        entries: g.entries,
        notes: listed?.[1] || null,
        headline: headlines.get(key) || null,
      }
    })
    .sort((a, b) => cmpVersion(a.name, b.name))
}

// ── Stored shape ────────────────────────────────────────────────────────────

const STD_TWA = [30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100, 110, 120, 130, 135, 140, 145, 150, 160, 170, 180]

export interface PolarMeta {
  name: string
  version?: string | null
  source?: string | null
  valid_from?: string | null
  file_name?: string | null
  source_note?: string | null
  headline?: HeadlineRow[] | null   // the sheet's own targets; derived from the polar when absent
}

// Build the `polars.data` object for an uploaded polar.
export function buildPolarData(entries: PolarEntry[], meta: PolarMeta) {
  const prepared = preparePolar({ entries, tws: entries.map(e => e.tws) }, { interp: 'linear' })
  const angles = Array.from(new Set(entries.flatMap(e => e.points.map(p => r1(p.twa))))).sort((a, b) => a - b)
  const lo = Math.min(...angles), hi = Math.max(...angles)
  const twa = angles.length <= 24 ? angles : STD_TWA.filter(a => a >= lo && a <= hi)

  const bsp = prepared.entries.map((e: any) =>
    twa.map(a => (a >= e.xMin && a <= e.xMax ? r2(e.bspAt(a)) : null)))

  const derived: HeadlineRow[] = prepared.entries.map((e: any) => ({
    tws: e.tws,
    up: { twa: r1(e.upTwa), bsp: r2(e.bspAt(e.upTwa)), awa: null, heel: null, rudd: null },
    dn: { twa: r1(e.downTwa), bsp: r2(e.bspAt(e.downTwa)), awa: null, heel: null, rudd: null },
  }))

  return {
    name: meta.name,
    version: meta.version ?? null,
    source: meta.source ?? null,
    source_note: meta.source_note ?? (meta.file_name ? `Uploaded from ${meta.file_name}` : null),
    valid_from: meta.valid_from ?? null,
    file_name: meta.file_name ?? null,
    tws: entries.map(e => e.tws),
    twa,
    headline: meta.headline?.length ? meta.headline : derived,
    matrices: { bsp },
    matrix_meta: { bsp: { unit: 'kn', label: 'BSP target (Polar)', decimals: 1 } },
    entries,
  }
}

// A stored `polars.data` (uploaded entries, or the V1.4-style TWS×TWA matrix)
// → a prepared polarCalc polar, or null when it holds no speed data.
export function polarFromData(data: any): any | null {
  if (!data) return null
  let entries: PolarEntry[] | null = null
  if (Array.isArray(data.entries) && data.entries.length >= 2) {
    entries = data.entries
  } else if (Array.isArray(data.matrices?.bsp) && Array.isArray(data.tws) && Array.isArray(data.twa)) {
    const m: (number | null)[][] = data.matrices.bsp
    entries = data.tws
      .map((tws: number, i: number) => ({
        tws,
        points: data.twa
          .map((twa: number, j: number) => ({ twa, bsp: m[i]?.[j] as number }))
          .filter((p: PolarPoint) => typeof p.bsp === 'number' && p.bsp > 0),
      }))
      .filter((e: PolarEntry) => e.points.length >= 2)
  }
  if (!entries || entries.length < 2) return null
  return preparePolar({ entries, tws: entries.map(e => e.tws) }, { interp: 'linear' })
}

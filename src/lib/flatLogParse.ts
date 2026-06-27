// src/lib/flatLogParse.ts
// ─────────────────────────────────────────────────────────────────────────────
// Flat-CSV Expedition export with a HEADER row, an OLE/Excel date serial in the
// `Utc` column, and SEPARATE decimal `Lat`/`Lon` columns. This is the format the
// 2026 Northstar 76 export switched to (header: Boat,Utc,UtcDate,UtcTime,BSP,…).
//
// It is NOT handled by the two existing parsers (both left untouched):
//   • expLogParse.ts  — the Expedition *raw* sparse log (lines prefixed with !).
//   • csvLogParse.ts  — the older flat CSV with a single NMEA `Pos` column and a
//     `dd/mm/yy` + `hh:mm:ss` time (parseCsvLog skips every row here because the
//     time is an OLE serial, not a slash date).
//
// Column NAME → index mapping (so reordering/insertions survive). Row field names
// match expLogParse's output so every downstream consumer (instrument overlay,
// 2-min SailScan window, windweight, dbSync) reads it unchanged. Pure / no deps.
// ─────────────────────────────────────────────────────────────────────────────

import { effectiveAliases, resolveHeaderIndices, normLabel as norm, type LogField } from './logProfile'

const OLE_EPOCH_DAYS = 25569 // days between 1899-12-30 (OLE epoch) and 1970-01-01
const MS_PER_DAY = 86400000

export interface FlatLogRow {
  utc: number
  lat: number | null; lon: number | null
  bsp: number | null; awa: number | null; aws: number | null
  twa: number | null; tws: number | null; twd: number | null
  heel: number | null; trim: number | null; forestay: number | null; vmg: number | null
  cog: number | null; sog: number | null
  leeway: number | null; set: number | null; drift: number | null; hdg: number | null
  polBsp: number | null; polarBspPct: number | null; keelAng: number | null
  upDflctPct: number | null; lwDflctPct: number | null
  targVmg: number | null; targTwa: number | null; targBsp: number | null
}

export interface FlatLogResult { rows: FlatLogRow[]; startUtc: number; endUtc: number }

// Detect the header-flat / OLE-serial / separate-lat-lon variant. Distinct from
// the raw log (! prefix) and the old NMEA flat CSV (single `Pos`, dd/mm/yy date).
export function isFlatOleLog(text: string): boolean {
  if (!text) return false
  const first = text.replace(/\r/g, '').split('\n').find((l) => l.trim()) || ''
  if (first.trim().startsWith('!')) return false
  const cols = first.split(',').map(norm)
  const has = (k: string) => cols.includes(k)
  // Separate lat & lon columns + a Utc column + wind/speed columns, and NOT the
  // old NMEA position column (which normalises to include "ddmm").
  return has('utc') && has('lat') && has('lon') && (has('bsp') || has('tws')) && !cols.some((c) => c.includes('ddmm'))
}

// `aliases` (optional): effective per-field label lists from the boat's log
// profile. Omitted ⇒ built-in defaults (identical behaviour to before).
export function parseFlatOleLog(text: string, aliases?: Record<LogField, string[]>): FlatLogResult {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim())
  if (!lines.length) return { rows: [], startUtc: 0, endUtc: 0 }

  // Need the Utc column explicitly (it isn't a LogField); resolve everything else
  // through the shared profile so per-boat aliases extend the defaults.
  const headerCols = lines[0].split(',')
  const utcIdx = headerCols.findIndex((h) => norm(h) === 'utc')
  const M = resolveHeaderIndices(headerCols, aliases || effectiveAliases())

  const num = (c: string[], i: number | undefined): number | null => {
    if (i == null || i < 0 || i >= c.length) return null
    const v = parseFloat(c[i])
    return Number.isNaN(v) ? null : v
  }

  const rows: FlatLogRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',')
    const serial = num(c, utcIdx)
    if (serial == null) continue
    const utc = Math.round((serial - OLE_EPOCH_DAYS) * MS_PER_DAY)
    if (!Number.isFinite(utc)) continue
    rows.push({
      utc, lat: num(c, M.lat), lon: num(c, M.lon),
      bsp: num(c, M.bsp), awa: num(c, M.awa), aws: num(c, M.aws),
      twa: num(c, M.twa), tws: num(c, M.tws), twd: num(c, M.twd),
      heel: num(c, M.heel), trim: num(c, M.trim), forestay: num(c, M.forestay), vmg: num(c, M.vmg),
      cog: num(c, M.cog), sog: num(c, M.sog),
      leeway: num(c, M.leeway), set: num(c, M.set), drift: num(c, M.drift), hdg: num(c, M.hdg),
      polBsp: num(c, M.polBsp), polarBspPct: num(c, M.polarBspPct), keelAng: num(c, M.keelAng),
      upDflctPct: num(c, M.upDflctPct), lwDflctPct: num(c, M.lwDflctPct),
      targVmg: num(c, M.targVmg), targTwa: num(c, M.targTwa), targBsp: num(c, M.targBsp),
    })
  }
  return { rows, startUtc: rows[0]?.utc || 0, endUtc: rows[rows.length - 1]?.utc || 0 }
}

// src/lib/flatLogParse.ts
// ─────────────────────────────────────────────────────────────────────────────
// Flat-CSV Expedition export with a HEADER row and SEPARATE decimal `Lat`/`Lon`
// columns — the Northstar 76 export format. The `Utc` column is EITHER an
// OLE/Excel date serial (older export) OR a `DD/MM/YYYY HH:MM` slash-date (the
// 2026-06 export); both are handled per-row, so the parser survives the switch.
//
// NOT handled here:
//   • csvLogParse.ts — the older flat CSV with a single NMEA `Pos` column and a
//     `dd/mm/yy` + `hh:mm:ss` time (N72 backfill; kept separate).
//
// Column NAME → index mapping via the shared per-boat alias profile (so
// reordering/insertions/renames survive). Row field names match the downstream
// consumers (instrument overlay, 2-min SailScan window, windweight, dbSync) so
// they read it unchanged. Pure / no deps.
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
  keelAng: number | null
  upDflctPct: number | null; lwDflctPct: number | null
  // performance / targets — CANONICAL keys shared with csvLogParse + the video
  // overlay + dbSync + autotags (so every consumer reads them unchanged).
  vsTarget: number | null; vsTargPct: number | null; vsPerf: number | null
  vsPerfPct: number | null; twaTarg: number | null
  // start-line instruments (canonical)
  dstLine: number | null; tmLine: number | null
  ttbPort: number | null; ttbStbd: number | null; ttbPin: number | null; ttbCB: number | null
  timer1: number | null; yawR: number | null; magvar: number | null; rudder: number | null
  // rig loads/settings + targets (2026-06 N76 flat-CSV): so the 2-min SailScan
  // window can average them instead of only showing them at the scan instant.
  rake: number | null; mastAng: number | null
  jibTackLoad: number | null; cunninghamLoad: number | null
  vang: number | null; outhaul: number | null; travPct: number | null; cunnoPct: number | null
  // mainsail-only batten/vang positions (port/starboard)
  v0p: number | null; v0s: number | null; v1p: number | null; v1s: number | null
  // headsail-only trim positions
  jibUpDnStbd: number | null; jibUpDnPort: number | null; jibInOut: number | null
  targHeel: number | null
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

  // Utc is EITHER a `DD/MM/YYYY HH:MM[:SS]` slash-date (2026-06 export) OR an
  // OLE/Excel date serial (older export). Detect per-cell -> epoch ms (UTC).
  const utcMs = (cell: string | undefined): number | null => {
    if (cell == null) return null
    const s = cell.trim()
    if (!s) return null
    if (s.includes('/')) {
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/)
      if (!m) return null
      const [, dd, mm, yyRaw, hh, mi, ss] = m
      const yy = yyRaw.length === 2 ? 2000 + Number(yyRaw) : Number(yyRaw)
      const t = Date.UTC(yy, Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss || '0'))
      return Number.isFinite(t) ? t : null
    }
    const serial = parseFloat(s)
    if (Number.isNaN(serial)) return null
    const t = Math.round((serial - OLE_EPOCH_DAYS) * MS_PER_DAY)
    return Number.isFinite(t) ? t : null
  }

  const rows: FlatLogRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',')
    const utc = utcMs(utcIdx >= 0 ? c[utcIdx] : undefined)
    if (utc == null) continue
    rows.push({
      utc, lat: num(c, M.lat), lon: num(c, M.lon),
      bsp: num(c, M.bsp), awa: num(c, M.awa), aws: num(c, M.aws),
      twa: num(c, M.twa), tws: num(c, M.tws), twd: num(c, M.twd),
      heel: num(c, M.heel), trim: num(c, M.trim), forestay: num(c, M.forestay), vmg: num(c, M.vmg),
      cog: num(c, M.cog), sog: num(c, M.sog),
      leeway: num(c, M.leeway), set: num(c, M.set), drift: num(c, M.drift), hdg: num(c, M.hdg),
      keelAng: num(c, M.keelAng),
      upDflctPct: num(c, M.upDflctPct), lwDflctPct: num(c, M.lwDflctPct),
      vsTarget: num(c, M.vsTarget), vsTargPct: num(c, M.vsTargPct), vsPerf: num(c, M.vsPerf),
      vsPerfPct: num(c, M.vsPerfPct), twaTarg: num(c, M.twaTarg),
      dstLine: num(c, M.dstLine), tmLine: num(c, M.tmLine),
      ttbPort: num(c, M.ttbPort), ttbStbd: num(c, M.ttbStbd), ttbPin: num(c, M.ttbPin), ttbCB: num(c, M.ttbCB),
      timer1: num(c, M.timer1), yawR: num(c, M.yawR), magvar: num(c, M.magvar), rudder: num(c, M.rudder),
      rake: num(c, M.rake), mastAng: num(c, M.mastAng),
      jibTackLoad: num(c, M.jibTackLoad), cunninghamLoad: num(c, M.cunninghamLoad),
      vang: num(c, M.vang), outhaul: num(c, M.outhaul), travPct: num(c, M.travPct), cunnoPct: num(c, M.cunnoPct),
      v0p: num(c, M.v0p), v0s: num(c, M.v0s), v1p: num(c, M.v1p), v1s: num(c, M.v1s),
      jibUpDnStbd: num(c, M.jibUpDnStbd), jibUpDnPort: num(c, M.jibUpDnPort), jibInOut: num(c, M.jibInOut),
      targHeel: num(c, M.targHeel),
    })
  }
  return { rows, startUtc: rows[0]?.utc || 0, endUtc: rows[rows.length - 1]?.utc || 0 }
}

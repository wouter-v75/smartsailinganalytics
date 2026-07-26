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

// Windows FILETIME: 100-nanosecond ticks since 1601-01-01 UTC. The 2026-07 N76
// export writes `Utc` this way (e.g. 1.34282346237428E+17). Anything above this
// threshold cannot be an OLE serial (an OLE serial of 1e12 is ~year 2.7 billion),
// so the magnitude alone disambiguates the two encodings safely.
const FILETIME_MIN = 1e12
const FILETIME_EPOCH_MS = 11644473600000 // 1601-01-01 → 1970-01-01, in ms
const FILETIME_TICKS_PER_MS = 10000

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
  ttbPort: number | null; ttbStbd: number | null; ttbOnStb: number | null; ttbPin: number | null; ttbCB: number | null
  timer1: number | null; yawR: number | null; magvar: number | null; rudder: number | null
  // rig loads/settings + targets (2026-06 N76 flat-CSV): so the 2-min SailScan
  // window can average them instead of only showing them at the scan instant.
  rake: number | null; mastAng: number | null
  jibTackLoad: number | null; gsTackLoad: number | null; cunninghamLoad: number | null
  vang: number | null; outhaul: number | null; travPct: number | null; cunnoPct: number | null
  // rig loads + control positions (2026-07 N76 export). fstyPin = forestay PIN LOAD
  // (not `forestay`, which is the length/rake reading); fstyJibTk = the boat's own
  // summed forestay + jib-tack load ("Comb HS" on the rig card).
  fstyPin: number | null; fstyJibTk: number | null; mainsheetLoad: number | null
  ruddP: number | null; ruddS: number | null
  toeIn: number | null; futek: number | null; eBarPort: number | null; eBarStbd: number | null
  // mainsail-only batten/vang positions (port/starboard)
  v0p: number | null; v0s: number | null; v1p: number | null; v1s: number | null
  // headsail-only trim positions
  jibUpDnStbd: number | null; jibUpDnPort: number | null; jibInOut: number | null
  targHeel: number | null
  targToe: number | null; targTrim: number | null; targVmg: number | null; targAwa: number | null
  // on-board environment sensors — feed observed windweight + the MOS join
  airTemp: number | null; seaTemp: number | null; rh: number | null; baro: number | null
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
  // High-resolution clock: some exports write `Utc` only to the MINUTE (no
  // seconds), which collapses every row in a minute onto one instant and makes
  // the video overlay freeze. When a seconds-of-day column is present
  // (`UTC_Time_min_sec`), use it for sub-second precision on top of the date.
  const secIdx = headerCols.findIndex((h) => {
    const k = norm(h)
    return k === 'utctimeminsec' || k === 'secofday' || k === 'timeofday'
  })
  const M = resolveHeaderIndices(headerCols, aliases || effectiveAliases())

  const num = (c: string[], i: number | undefined): number | null => {
    if (i == null || i < 0 || i >= c.length) return null
    const v = parseFloat(c[i])
    return Number.isNaN(v) ? null : v
  }

  // TTB·LINE — the 2026-07 Expedition export has no direct 'TmLine' column; derive
  // the burn at the line as (time-to-line − time-to-gun). Older exports keep a
  // direct 'TmLine' column, which wins when present.
  const tmToLnIdx = headerCols.findIndex((h) => norm(h) === 'tmtoln')
  const tmToGunIdx = headerCols.findIndex((h) => norm(h) === 'tmtogun')
  const tmLineOf = (c: string[]): number | null => {
    const direct = num(c, M.tmLine)
    if (direct != null) return direct
    const toLn = num(c, tmToLnIdx >= 0 ? tmToLnIdx : undefined)
    const toGun = num(c, tmToGunIdx >= 0 ? tmToGunIdx : undefined)
    return toLn != null && toGun != null ? toLn - toGun : null
  }

  // `Utc` is the SINGLE SOURCE OF TRUTH for the timestamp, in one of three
  // encodings (detected per-cell so a boat switching export never breaks us):
  //   1. `DD/MM/YYYY HH:MM[:SS]` slash-date  — 2026-06 export
  //   2. Windows FILETIME (100-ns ticks / 1601) — 2026-07 export
  //   3. OLE/Excel date serial (days / 1899-12-30) — older export
  //
  // DELIBERATELY NOT USED: the `UtcDate` + `UtcTime` columns that sit beside it
  // in the 2026-07 export. Despite the name they carry LOCAL wall-clock, not UTC:
  // at La Spezia on 2026-07-11 the FILETIME decodes to 09:10:23.74Z while
  // `UtcTime` reads 11:10:23.74 — exactly the +2 h CEST offset, and the row-to-row
  // deltas and sub-seconds match to the centisecond, so it is the same clock
  // merely rendered in venue time. Reading those columns as UTC would put every
  // timestamp in the log 2 h late and silently desync video/photo overlays. We
  // store true UTC everywhere and apply the venue offset only at render time.
  //
  // Returns { ms, dayStart } where dayStart is UTC-midnight of that calendar day
  // (used to re-anchor when a higher-resolution seconds-of-day column exists).
  const utcParts = (cell: string | undefined): { ms: number; dayStart: number } | null => {
    if (cell == null) return null
    const s = cell.trim()
    if (!s) return null
    if (s.includes('/')) {
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/)
      if (!m) return null
      const [, dd, mm, yyRaw, hh, mi, ss] = m
      const yy = yyRaw.length === 2 ? 2000 + Number(yyRaw) : Number(yyRaw)
      const dayStart = Date.UTC(yy, Number(mm) - 1, Number(dd), 0, 0, 0)
      const ms = dayStart + ((Number(hh) * 3600 + Number(mi) * 60 + Number(ss || '0')) * 1000)
      return Number.isFinite(ms) ? { ms, dayStart } : null
    }
    const serial = parseFloat(s) // handles both plain and 1.34e+17 exponent form
    if (Number.isNaN(serial)) return null
    const ms =
      serial >= FILETIME_MIN
        ? Math.round(serial / FILETIME_TICKS_PER_MS) - FILETIME_EPOCH_MS
        : Math.round((serial - OLE_EPOCH_DAYS) * MS_PER_DAY)
    if (!Number.isFinite(ms)) return null
    const dayStart = Math.floor(ms / MS_PER_DAY) * MS_PER_DAY
    return { ms, dayStart }
  }

  const rows: FlatLogRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',')
    const up = utcParts(utcIdx >= 0 ? c[utcIdx] : undefined)
    if (up == null) continue
    // Prefer the seconds-of-day clock for resolution; fall back to the Utc cell.
    let utc = up.ms
    if (secIdx >= 0) {
      const sod = parseFloat(c[secIdx])
      if (Number.isFinite(sod) && sod >= 0 && sod < 86400) utc = up.dayStart + Math.round(sod * 1000)
    }
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
      dstLine: num(c, M.dstLine), tmLine: tmLineOf(c),
      ttbPort: num(c, M.ttbPort), ttbStbd: num(c, M.ttbStbd), ttbOnStb: num(c, M.ttbOnStb), ttbPin: num(c, M.ttbPin), ttbCB: num(c, M.ttbCB),
      timer1: num(c, M.timer1), yawR: num(c, M.yawR), magvar: num(c, M.magvar), rudder: num(c, M.rudder),
      rake: num(c, M.rake), mastAng: num(c, M.mastAng),
      jibTackLoad: num(c, M.jibTackLoad), gsTackLoad: num(c, M.gsTackLoad), cunninghamLoad: num(c, M.cunninghamLoad),
      vang: num(c, M.vang), outhaul: num(c, M.outhaul), travPct: num(c, M.travPct), cunnoPct: num(c, M.cunnoPct),
      v0p: num(c, M.v0p), v0s: num(c, M.v0s), v1p: num(c, M.v1p), v1s: num(c, M.v1s),
      jibUpDnStbd: num(c, M.jibUpDnStbd), jibUpDnPort: num(c, M.jibUpDnPort), jibInOut: num(c, M.jibInOut),
      fstyPin: num(c, M.fstyPin), fstyJibTk: num(c, M.fstyJibTk), mainsheetLoad: num(c, M.mainsheetLoad),
      ruddP: num(c, M.ruddP), ruddS: num(c, M.ruddS),
      toeIn: num(c, M.toeIn), futek: num(c, M.futek), eBarPort: num(c, M.eBarPort), eBarStbd: num(c, M.eBarStbd),
      targHeel: num(c, M.targHeel),
      targToe: num(c, M.targToe), targTrim: num(c, M.targTrim),
      targVmg: num(c, M.targVmg), targAwa: num(c, M.targAwa),
      airTemp: num(c, M.airTemp), seaTemp: num(c, M.seaTemp), rh: num(c, M.rh), baro: num(c, M.baro),
    })
  }
  return { rows, startUtc: rows[0]?.utc || 0, endUtc: rows[rows.length - 1]?.utc || 0 }
}

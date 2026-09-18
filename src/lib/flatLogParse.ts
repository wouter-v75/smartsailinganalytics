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
  cog: number | null; sog: number | null; acc: number | null
  leeway: number | null; set: number | null; drift: number | null; hdg: number | null
  keelAng: number | null
  upDflctPct: number | null; lwDflctPct: number | null
  // performance / targets — CANONICAL keys shared with csvLogParse + the video
  // overlay + dbSync + autotags (so every consumer reads them unchanged).
  vsTarget: number | null; vsTargPct: number | null; vsPerf: number | null
  vsPerfPct: number | null; twaTarg: number | null
  // start-line instruments (canonical)
  dstLine: number | null; tmLine: number | null; pBurn: number | null; sBurn: number | null
  ttbPort: number | null; ttbStbd: number | null; ttbOnStb: number | null; ttbPin: number | null; ttbCB: number | null
  timer1: number | null; yawR: number | null; magvar: number | null; rudder: number | null
  // rig loads/settings + targets (2026-06 N76 flat-CSV): so the 2-min SailScan
  // window can average them instead of only showing them at the scan instant.
  rake: number | null; mastAng: number | null; shims: number | null
  jibTackLoad: number | null; gsTackLoad: number | null; cunninghamLoad: number | null
  bobstay: number | null
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
  // Rig / foil TARGETS. targKeel, targFsty and targBsty were declared as fields
  // but never emitted here, so a canting-keel target never reached the app from
  // ANY flat log — the navigator's `TargetKeel` and Expedition's `TargKeel` alike.
  targHeel: number | null; targKeel: number | null
  targFsty: number | null; targBsty: number | null
  targToe: number | null; targTrim: number | null; targVmg: number | null; targAwa: number | null
  // on-board environment sensors — feed observed windweight + the MOS join
  airTemp: number | null; seaTemp: number | null; rh: number | null; baro: number | null
}

export interface FlatLogResult { rows: FlatLogRow[]; startUtc: number; endUtc: number }

// ── Lidar sail-shape channels (2026-09 N76 4 Hz export) ─────────────────────
// `MN_CA_25`, `JIB_TW_50`, `SPI_DR_75` … are measured camber / twist / draft at 25 / 50 /
// 75 % height; `T_MN_CA_25` … the sailmaker's targets (the main also has `T_MN_TR_*`).
// Only what KND's lidar report uses is read — the export also carries entry / exit /
// sag / leech columns per stripe. Stored as sparse keys (`mnCa25`, `tJibDr50`, `tMnTr75`)
// set only when the cell has a value: most columns are empty most of the time (no
// spinnaker upwind), and at 4 Hz a day is ~57,600 rows.
const LIDAR_HEADER = /^(T_)?(MN|JIB|SPI)_(CA|TW|DR|TR)_(25|50|75)$/i
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

export function lidarKeyOf(header: string): string | null {
  const m = String(header || '').trim().match(LIDAR_HEADER)
  if (!m) return null
  const [, target, sail, v, h] = m
  if (!target && v.toUpperCase() === 'TR') return null
  const sailKey = target ? cap1(sail) : sail.toLowerCase()
  return `${target ? 't' : ''}${sailKey}${cap1(v)}${h}`
}

// Lidar keys stay on the importing device: the cloud copy (reduceLogForCloud) leaves them
// out so the row spacing everyone else gets doesn't coarsen. Other devices read lidar
// through the stored full-log phase stats instead.
export const isLidarKey = (k: string) => /^t?(mn|jib|spi|Mn|Jib|Spi)(Ca|Tw|Dr|Tr)(25|50|75)$/.test(k)

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
// The navigator's own layout: a plain header row (no `!` lines), fixed columns, and
// a `Datetime` column carrying LOCAL wall-clock rather than UTC. Its first row on
// 2026-09-07 reads 10:20:38, one second after the event file's DayStart at 10:20:37
// — the same clock the clip pipeline already matches camera filenames against. That
// is why it cannot simply be treated as flat-OLE: reading these stamps as UTC would
// put every row an offset late and silently desync the video and photo overlays.
export function isFlatLocalLog(text: string): boolean {
  if (!text) return false
  const first = text.replace(/\r/g, '').split('\n').find((l) => l.trim()) || ''
  if (first.trim().startsWith('!')) return false
  const cols = first.split(',').map(norm)
  const has = (k: string) => cols.includes(k)
  if (!has('lat') || !has('lon') || !(has('bsp') || has('tws'))) return false
  // One `Datetime` column, or the SPLIT PAIR `UtcDate,UtcTime` — the same clock in
  // two cells. See splitLocalClock below for why the pair is local despite its name.
  return (has('datetime') && !has('utc')) || hasSplitLocalClock(cols)
}

/**
 * `UtcDate` + `UtcTime`: the navigator's other layout, and LOCAL WALL-CLOCK despite
 * the name.
 *
 * The 2026-09 lidar exports (`…_LSB.csv`, 171 columns) and the 157-column September
 * exports split the stamp across two cells instead of carrying one `Datetime`. Before
 * this they matched neither isFlatOleLog (which wants a column normalising to exactly
 * `utc`) nor isFlatLocalLog (which wanted `datetime`), so detectLogFormat fell through
 * to flat-NMEA and the NMEA parser returned ZERO ROWS — without throwing. Four days of
 * September 2026, every one of them a lidar day, could not be imported at all and said
 * nothing about it.
 *
 * WHY LOCAL, when the columns say Utc. The 2026-09-07 file's first row reads 10:20:38,
 * one second after that day's event-file DayStart at 10:20:37 — which is the comparison
 * the comment above already makes for the `Datetime` layout, on the same day. Checked
 * against the stored event files (true UTC from the onboard assistant) for all four
 * days, the log only lines up after subtracting the venue offset: 09-12's first fix at
 * 11:34:42 against a first event at 09:34:41Z. Read as UTC, every row would be an
 * offset late and the video and photo overlays would silently desync — the same trap
 * the `Datetime` note warns about.
 */
export function hasSplitLocalClock(normCols: string[]): boolean {
  return normCols.includes('utcdate') && normCols.includes('utctime')
}

export function parseFlatOleLog(text: string, aliases?: Record<LogField, string[]>): FlatLogResult {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim())
  if (!lines.length) return { rows: [], startUtc: 0, endUtc: 0 }

  // Need the Utc column explicitly (it isn't a LogField); resolve everything else
  // through the shared profile so per-boat aliases extend the defaults.
  const headerCols = lines[0].split(',')
  // P burn / S burn, BY NAME first. These are not LogFields, so they are resolved
  // here rather than through the profile.
  //
  // This used to take the last two columns positionally, on the grounds that the
  // export "has no stable header for them". That is true only when those columns
  // are genuinely unnamed — and on every real export to hand they are not, so the
  // rule was silently reading whatever happened to sit at the end of the file. On
  // the navigator's own layout that is `V1_Lwd,Rudder_Lwd`, so a rudder angle was
  // being served as a start burn. The positional fallback is kept, but only for
  // trailing columns that really carry no name.
  const burnIdx = (want: string) => headerCols.findIndex((h) => norm(h) === want)
  let pBurnIdx = burnIdx('pburn')
  let sBurnIdx = burnIdx('sburn')
  if (pBurnIdx < 0 && sBurnIdx < 0 &&
      !norm(headerCols[headerCols.length - 2] || '') &&
      !norm(headerCols[headerCols.length - 1] || '')) {
    pBurnIdx = headerCols.length - 2
    sBurnIdx = headerCols.length - 1
  }
  // `Utc` in the Expedition exports; `Datetime` in the navigator's own layout.
  // Both are the single time column — which CLOCK they carry differs, and that is
  // decided by the caller (see detectLogFormat), not here.
  const utcIdx = headerCols.findIndex((h) => norm(h) === 'utc' || norm(h) === 'datetime')
  // The split pair. utcParts wants one string, so the two cells are joined per row
  // (below) into the `<date> <time>` shape it already understands.
  const normCols = headerCols.map(norm)
  const dateIdx = utcIdx >= 0 ? -1 : normCols.indexOf('utcdate')
  const timeIdx = utcIdx >= 0 ? -1 : normCols.indexOf('utctime')
  // High-resolution clock: some exports write `Utc` only to the MINUTE (no
  // seconds), which collapses every row in a minute onto one instant and makes
  // the video overlay freeze. When a seconds-of-day column is present
  // (`UTC_Time_min_sec`), use it for sub-second precision on top of the date.
  const secIdx = headerCols.findIndex((h) => {
    const k = norm(h)
    return k === 'utctimeminsec' || k === 'secofday' || k === 'timeofday'
  })
  const M = resolveHeaderIndices(headerCols, aliases || effectiveAliases())

  // BSP as a percentage of TARGET boat speed — the start panel's "Tgt %" gauge.
  //
  // Prefer a logged column, but the navigator's export has no such channel: it
  // carries BoatSpeed and TargetBoatSpeed separately (and BoatSpeedPercOfPolar,
  // which is a DIFFERENT quantity — percent of polar, not of target). So the
  // gauge read '--' on every clip from that layout. Derive it when it is absent.
  //
  // Guarded on a POSITIVE target: pre-start rows carry TargetBoatSpeed 0, and
  // dividing by that yields Infinity, which renders as a plausible-looking number
  // rather than the "no data" it actually is.
  const vsTargPctOf = (c: string[]): number | null => {
    const logged = num(c, M.vsTargPct)
    if (logged != null) return logged
    const bsp = num(c, M.bsp)
    const tgt = num(c, M.vsTarget)
    if (bsp == null || tgt == null || tgt <= 0) return null
    return Math.round((bsp / tgt) * 1000) / 10
  }

  const num = (c: string[], i: number | undefined): number | null => {
    if (i == null || i < 0 || i >= c.length) return null
    const v = parseFloat(c[i])
    return Number.isNaN(v) ? null : v
  }

  // Time-to-burn channels: the 2026-07 Expedition export writes these in FILETIME
  // 100-ns ticks (1e7 per second), not seconds — a 20 s burn arrives as ~2e8. When
  // the magnitude says ticks (> 1e5, far above any real burn in seconds), convert
  // to seconds; older seconds-based exports (small values) pass through unchanged.
  const toBurnSec = (v: number | null): number | null =>
    v == null ? null : Math.abs(v) > 100000 ? v / 1e7 : v

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
    // 4. `YYYY-MM-DD HH:MM[:SS]` — the navigator's layout. Parsed by hand rather
    //    than with Date(), which would apply the VIEWER's timezone to a bare stamp
    //    and move every row by whatever the laptop happens to be set to.
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?/)
    if (iso) {
      const [, yy, mm, dd, hh, mi, ss] = iso
      const dayStart = Date.UTC(Number(yy), Number(mm) - 1, Number(dd), 0, 0, 0)
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

  const lidarCols = headerCols
    .map((h, i) => ({ key: lidarKeyOf(h), i }))
    .filter((x): x is { key: string; i: number } => x.key != null)

  const rows: FlatLogRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',')
    const stamp = utcIdx >= 0
      ? c[utcIdx]
      : (dateIdx >= 0 && timeIdx >= 0 && c[dateIdx]?.trim() && c[timeIdx]?.trim())
        ? `${c[dateIdx].trim()} ${c[timeIdx].trim()}`
        : undefined
    const up = utcParts(stamp)
    if (up == null) continue
    // Prefer the seconds-of-day clock for resolution; fall back to the Utc cell.
    let utc = up.ms
    if (secIdx >= 0) {
      const sod = parseFloat(c[secIdx])
      if (Number.isFinite(sod) && sod >= 0 && sod < 86400) utc = up.dayStart + Math.round(sod * 1000)
    }
    const row: FlatLogRow = {
      utc, lat: num(c, M.lat), lon: num(c, M.lon),
      bsp: num(c, M.bsp), awa: num(c, M.awa), aws: num(c, M.aws),
      twa: num(c, M.twa), tws: num(c, M.tws), twd: num(c, M.twd),
      heel: num(c, M.heel), trim: num(c, M.trim), forestay: num(c, M.forestay), vmg: num(c, M.vmg),
      cog: num(c, M.cog), sog: num(c, M.sog), acc: null,
      leeway: num(c, M.leeway), set: num(c, M.set), drift: num(c, M.drift), hdg: num(c, M.hdg),
      keelAng: num(c, M.keelAng),
      upDflctPct: num(c, M.upDflctPct), lwDflctPct: num(c, M.lwDflctPct),
      vsTarget: num(c, M.vsTarget), vsTargPct: vsTargPctOf(c), vsPerf: num(c, M.vsPerf),
      vsPerfPct: num(c, M.vsPerfPct), twaTarg: num(c, M.twaTarg),
      dstLine: num(c, M.dstLine), tmLine: toBurnSec(tmLineOf(c)), pBurn: pBurnIdx < 0 ? null : toBurnSec(num(c, pBurnIdx)), sBurn: sBurnIdx < 0 ? null : toBurnSec(num(c, sBurnIdx)),
      ttbPort: toBurnSec(num(c, M.ttbPort)), ttbStbd: toBurnSec(num(c, M.ttbStbd)), ttbOnStb: toBurnSec(num(c, M.ttbOnStb)), ttbPin: toBurnSec(num(c, M.ttbPin)), ttbCB: toBurnSec(num(c, M.ttbCB)),
      timer1: num(c, M.timer1), yawR: num(c, M.yawR), magvar: num(c, M.magvar), rudder: num(c, M.rudder),
      rake: num(c, M.rake), mastAng: num(c, M.mastAng), shims: num(c, M.shims),
      jibTackLoad: num(c, M.jibTackLoad), gsTackLoad: num(c, M.gsTackLoad), cunninghamLoad: num(c, M.cunninghamLoad),
      bobstay: num(c, M.bobstay),
      vang: num(c, M.vang), outhaul: num(c, M.outhaul), travPct: num(c, M.travPct), cunnoPct: num(c, M.cunnoPct),
      v0p: num(c, M.v0p), v0s: num(c, M.v0s), v1p: num(c, M.v1p), v1s: num(c, M.v1s),
      jibUpDnStbd: num(c, M.jibUpDnStbd), jibUpDnPort: num(c, M.jibUpDnPort), jibInOut: num(c, M.jibInOut),
      fstyPin: num(c, M.fstyPin), fstyJibTk: num(c, M.fstyJibTk), mainsheetLoad: num(c, M.mainsheetLoad),
      ruddP: num(c, M.ruddP), ruddS: num(c, M.ruddS),
      toeIn: num(c, M.toeIn), futek: num(c, M.futek), eBarPort: num(c, M.eBarPort), eBarStbd: num(c, M.eBarStbd),
      targHeel: num(c, M.targHeel), targKeel: num(c, M.targKeel),
      targFsty: num(c, M.targFsty), targBsty: num(c, M.targBsty),
      targToe: num(c, M.targToe), targTrim: num(c, M.targTrim),
      targVmg: num(c, M.targVmg), targAwa: num(c, M.targAwa),
      airTemp: num(c, M.airTemp), seaTemp: num(c, M.seaTemp), rh: num(c, M.rh), baro: num(c, M.baro),
    }
    for (const { key, i: col } of lidarCols) {
      const v = num(c, col)
      if (v != null) (row as unknown as Record<string, number>)[key] = v
    }
    rows.push(row)
  }
  // ACCELERATION (kn/MIN — Expedition's convention for start acceleration): a 2 s
  // moving average of the 1 s SOG delta, then ×60. d[i] = SOG(t) − SOG(t−1s)
  // (nearest sample within 1.5 s) = kn per ~1 s; trailing 2 s mean × 60 → kn/min.
  // Rows are chronological (pushed in file order).
  {
    const n = rows.length
    const t = rows.map((r) => r.utc)
    const sg = rows.map((r) => r.sog)
    const sogAt = (tt: number): number | null => {
      if (!n) return null
      let lo = 0, hi = n - 1
      while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] < tt) lo = mid + 1; else hi = mid }
      let best = lo
      if (lo > 0 && Math.abs(t[lo - 1] - tt) <= Math.abs(t[lo] - tt)) best = lo - 1
      return Math.abs(t[best] - tt) <= 1500 ? sg[best] : null
    }
    const d = new Array(n).fill(null)
    for (let i = 0; i < n; i++) {
      const cur = sg[i]
      if (cur == null) continue
      const prev = sogAt(t[i] - 1000)
      if (prev != null) d[i] = cur - prev
    }
    let lo = 0
    for (let i = 0; i < n; i++) {
      while (lo < i && t[lo] < t[i] - 2000) lo++
      let sum = 0, cnt = 0
      for (let j = lo; j <= i; j++) { if (d[j] != null) { sum += d[j]; cnt++ } }
      rows[i].acc = cnt ? Math.round((sum / cnt) * 60 * 10) / 10 : null  // kn/s → kn/min
    }
  }
  return { rows, startUtc: rows[0]?.utc || 0, endUtc: rows[rows.length - 1]?.utc || 0 }
}

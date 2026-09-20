// src/lib/vakarosCsvParse.ts
// ─────────────────────────────────────────────────────────────────────────────
// Vakaros Atlas CSV export — the first GPS-only (dinghy) log format.
//
//   timestamp,latitude,longitude,sog_kts,cog,hdg_true,heel,trim
//   2026-02-08T11:56:40.049+0100,39.5310307,2.5704827,0.400,266.1,245.8,-1.8,7.7
//
// Validated against two real exports from one session (Palma, 8 Feb 2026 —
// 22,812 rows at 2 Hz and 104,617 rows at 10 Hz). See
// docs/dinghy-gps-prior-art-and-twd-2026-09.md §15 for the full findings.
//
// Four things that each cost something to discover:
//
//   • CRLF line endings. Splitting the header on ',' without stripping \r names
//     the last column `trim\r`, so `trim` silently reads undefined on every row
//     and the channel looks like garbage rather than missing.
//   • The timestamp carries an EXPLICIT UTC offset (`+0100`). That makes this
//     the one clock in this codebase without the local-wall-time-labelled-UTC
//     trap in CLAUDE.md — but it is parsed here by regex rather than
//     Date.parse, because `+0100` (no colon) is implementation-defined.
//     The offset is returned as tzOffsetMin: it is the session's venue offset.
//   • There is NO device identity anywhere in the file — no serial, no boat
//     name, no session header. Identity cannot come from content, and the
//     filename is user-typed and unparseable (the two real files wrote the same
//     date as `2-8-2026` and `08-02-2026`, one naming a boat and one a
//     session). Take the date from the first row; get the boat from elsewhere.
//   • The logging rate is per-device and differs within a session, so it is
//     measured here, not assumed.
//
// Deliberately NOT done: `sog` is not copied to `bsp`. A dinghy has no
// paddlewheel and speed over ground is not speed through water; making them
// equal silently would be exactly the class of trap CLAUDE.md exists to record.
// The synthesis layer may do it later, once channel provenance exists.
// ─────────────────────────────────────────────────────────────────────────────

import {
  effectiveAliases, resolveHeaderIndices, normLabel,
  type BoatLogProfile, type LogField,
} from './logProfile'

export interface VakarosRow {
  utc: number                     // epoch ms, like every other parser here
  lat: number | null
  lon: number | null
  sog: number | null              // knots, as logged
  cog: number | null              // deg true
  hdg: number | null              // deg true — magnetometer, see §16: NOT the wind channel
  heel: number | null             // deg
  trim: number | null             // deg (pitch)
}

export interface VakarosCsvResult {
  rows: VakarosRow[]
  startUtc: number
  endUtc: number
  rateHz: number | null           // measured, not assumed
  tzOffsetMin: number | null      // from the timestamp offset — the venue's
  fields: LogField[]              // which canonical channels this file carries
  rejected: { rows: number; heel: number; trim: number }
}

// Attitude plausibility. One of the two real devices logged heel spanning
// −173°…+133° and pitch −88°…+82° (it was clearly handled or badly mounted);
// the other stayed within −42°…+48° and −8°…+25°. Out-of-range samples are
// nulled, not dropped — the position and speed on those rows are still good.
const HEEL_LIMIT = 60
const TRIM_LIMIT = 45

const TS = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})?$/

/** Parse an ISO-8601 stamp with an optional explicit offset. */
export function parseVakarosStamp(
  s: string
): { utc: number; offsetMin: number | null } | null {
  const m = TS.exec(s.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, sec, frac, zone] = m
  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0
  const base = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, ms)
  if (!Number.isFinite(base)) return null
  if (!zone) return { utc: base, offsetMin: null }        // no offset: treat as UTC
  if (zone === 'Z') return { utc: base, offsetMin: 0 }
  const sign = zone[0] === '-' ? -1 : 1
  const hh = +zone.slice(1, 3)
  const mm = +zone.slice(zone.length - 2)
  const offsetMin = sign * (hh * 60 + mm)
  return { utc: base - offsetMin * 60_000, offsetMin }
}

const splitLines = (text: string): string[] =>
  text.replace(/\r/g, '').split('\n')                     // ← the CRLF trap

/** Content sniff, mirroring isFlatOleLog / isLogV3 in the sibling parsers. */
export function isVakarosCsv(text: string): boolean {
  const first = splitLines(text).find((l) => l.trim().length > 0)
  if (!first) return false
  const cols = first.split(',').map(normLabel)
  return cols[0] === 'timestamp' &&
    cols.includes('sogkts') &&
    (cols.includes('hdgtrue') || cols.includes('cog')) &&
    cols.includes('latitude')
}

const num = (cells: string[], i: number | undefined): number | null => {
  if (i == null) return null
  const v = Number(cells[i])
  return Number.isFinite(v) ? v : null
}

const clamp = (v: number | null, limit: number): [number | null, boolean] =>
  v != null && Math.abs(v) > limit ? [null, true] : [v, false]

export function parseVakarosCsv(
  text: string,
  opts: { boatProfile?: BoatLogProfile | null } = {}
): VakarosCsvResult {
  const empty: VakarosCsvResult = {
    rows: [], startUtc: 0, endUtc: 0, rateHz: null, tzOffsetMin: null,
    fields: [], rejected: { rows: 0, heel: 0, trim: 0 },
  }
  const lines = splitLines(text)
  const headerIdx = lines.findIndex((l) => l.trim().length > 0)
  if (headerIdx < 0) return empty

  const headerCols = lines[headerIdx].split(',')
  // Go through the shared alias machinery so a boat profile can still override
  // a column name, exactly as the Expedition/flat-CSV paths do.
  const M = resolveHeaderIndices(headerCols, effectiveAliases(opts.boatProfile))
  const tsIdx = headerCols.findIndex((h) => normLabel(h) === 'timestamp')
  if (tsIdx < 0) return empty

  const rows: VakarosRow[] = []
  const rejected = { rows: 0, heel: 0, trim: 0 }
  let tzOffsetMin: number | null = null

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    const c = line.split(',')
    const stamp = parseVakarosStamp(c[tsIdx] || '')
    if (!stamp) { rejected.rows++; continue }
    if (tzOffsetMin == null) tzOffsetMin = stamp.offsetMin

    const [heel, heelBad] = clamp(num(c, M.heel), HEEL_LIMIT)
    const [trim, trimBad] = clamp(num(c, M.trim), TRIM_LIMIT)
    if (heelBad) rejected.heel++
    if (trimBad) rejected.trim++

    rows.push({
      utc: stamp.utc,
      lat: num(c, M.lat), lon: num(c, M.lon),
      sog: num(c, M.sog), cog: num(c, M.cog), hdg: num(c, M.hdg),
      heel, trim,
    })
  }

  if (!rows.length) return { ...empty, rejected }
  rows.sort((a, b) => a.utc - b.utc)

  // Measured rate: median sample interval over an evenly spread subsample.
  const step = Math.max(1, Math.floor(rows.length / 2000))
  const dts: number[] = []
  for (let i = step; i < rows.length; i += step) dts.push((rows[i].utc - rows[i - step].utc) / step)
  dts.sort((a, b) => a - b)
  const medDt = dts.length ? dts[dts.length >> 1] : 0
  const rateHz = medDt > 0 ? Math.round((1000 / medDt) * 10) / 10 : null

  const fields = (['lat', 'lon', 'sog', 'cog', 'hdg', 'heel', 'trim'] as const)
    .filter((f) => rows.some((r) => r[f] != null)) as LogField[]

  return {
    rows,
    startUtc: rows[0].utc,
    endUtc: rows[rows.length - 1].utc,
    rateHz,
    tzOffsetMin,
    fields,
    rejected,
  }
}

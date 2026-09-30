// src/lib/expeditionExportParse.ts
// ─────────────────────────────────────────────────────────────────────────────
// Expedition's LOG-VIEWER export — full English column names, SI units, magnetic
// bearings. First seen 2026-09-30, off the card as a folder of parts.
//
//   Date/Time (UTC),True Wind Direction °M,True Wind Speed m/s,…,Alarms,User events
//   30.09.2026 11:44:26.970,212.4,8.2,…
//
// AN ALTERNATIVE, NOT A REPLACEMENT. The boat's normal export is the flat CSV
// that flatLogParse reads, and nothing here changes it. The detector below keys
// on a column — `Date/Time (UTC)` — that no other format in this codebase has,
// so it cannot claim a file one of them handles; there is a test that checks it
// against each of their headers rather than trusting that sentence.
//
// Three things make it a different parser rather than another alias table:
//
//   • UNITS ARE SI. Speeds are m/s where every consumer in this app expects
//     knots, and the barometer is in pascals where the windweight code expects
//     hPa. An alias cannot multiply.
//   • BEARINGS ARE MAGNETIC — `°M` on wind direction, course, heading and tide
//     set — and the variation is its own column. SSA stores true throughout, so
//     they are converted here, per row, using that column. magVar.ts fixes the
//     convention: varDeg is positive east and magnetic = true − varDeg, so
//     true = magnetic + varDeg.
//   • THE CLOCK IS DOTTED, `DD.MM.YYYY HH:MM:SS.mmm`, which none of the four
//     encodings in flatLogParse covers.
//
// AND THE CLOCK IS REALLY UTC. That is worth writing down because it is the
// exception: CLAUDE.md's first trap is that these stamps are usually venue-local
// even when the column says UTC, and the `UtcDate`/`UtcTime` pair in the other
// Expedition layout is local despite its name. This one was confirmed by the
// navigator on 2026-09-30. If a future export turns out otherwise the symptom is
// unmistakable — every overlay off by the venue offset — and the fix belongs in
// parseLog beside the flat-local shift, not here.
//
// Columns nobody has mapped yet are REPORTED rather than guessed at. There are
// ~190 of them, most rig hydraulics with no canonical field, and a wrong mapping
// is worse than a missing channel: a missing one shows up as blank, a wrong one
// shows up as a number somebody trusts.
// ─────────────────────────────────────────────────────────────────────────────

import { normLabel as norm } from './logProfile'

const MS_TO_KT = 1.9438444924406

/** What to do with a column on the way in. */
type Unit = 'as-is' | 'ms-to-kt' | 'pa-to-hpa' | 'mag-to-true'

interface ColumnSpec {
  field: string
  unit: Unit
}

// Normalised header label → canonical field. normLabel strips everything that is
// not [a-z0-9], which is what makes this safe against the encoding: the degree
// sign arrives as one high byte and reads as `°`, `∞` or U+FFFD depending on how
// the file was decoded, and all three normalise away to nothing.
const COLUMNS: Record<string, ColumnSpec> = {
  bowpositionlatitude: { field: 'lat', unit: 'as-is' },
  bowpositionlongitude: { field: 'lon', unit: 'as-is' },

  boatspeedms: { field: 'bsp', unit: 'ms-to-kt' },
  speedovergroundms: { field: 'sog', unit: 'ms-to-kt' },
  velocitymadegoodms: { field: 'vmg', unit: 'ms-to-kt' },
  truewindspeedms: { field: 'tws', unit: 'ms-to-kt' },
  apparentwindspeedms: { field: 'aws', unit: 'ms-to-kt' },
  tideratems: { field: 'drift', unit: 'ms-to-kt' },

  truewindangle: { field: 'twa', unit: 'as-is' },
  apparentwindangle: { field: 'awa', unit: 'as-is' },
  signedleewayangle: { field: 'leeway', unit: 'as-is' },
  heel: { field: 'heel', unit: 'as-is' },
  trim: { field: 'trim', unit: 'as-is' },
  rudderangle: { field: 'rudder', unit: 'as-is' },
  keelangle: { field: 'keelAng', unit: 'as-is' },
  mastangle: { field: 'mastAng', unit: 'as-is' },
  toeinangle: { field: 'toeIn', unit: 'as-is' },
  magneticvariation: { field: 'magvar', unit: 'as-is' },

  // Magnetic on the way in, true on the way out.
  truewinddirectionm: { field: 'twd', unit: 'mag-to-true' },
  courseovergroundm: { field: 'cog', unit: 'mag-to-true' },
  headingm: { field: 'hdg', unit: 'mag-to-true' },
  tidesetm: { field: 'set', unit: 'mag-to-true' },

  airtemperaturec: { field: 'airTemp', unit: 'as-is' },
  seatemperaturec: { field: 'seaTemp', unit: 'as-is' },
  barometricpressurepa: { field: 'baro', unit: 'pa-to-hpa' },

  // Loads and positions, where the label leaves no room for doubt.
  forestay: { field: 'forestay', unit: 'as-is' },
  forestaypin: { field: 'fstyPin', unit: 'as-is' },
  bobstay: { field: 'bobstay', unit: 'as-is' },
  boomvang: { field: 'vang', unit: 'as-is' },
  outhaulload: { field: 'outhaul', unit: 'as-is' },
  cunningham: { field: 'cunninghamLoad', unit: 'as-is' },
  mainsheet: { field: 'mainsheetLoad', unit: 'as-is' },
  mastbase: { field: 'mastButt', unit: 'as-is' },
  rudderloadport: { field: 'ruddP', unit: 'as-is' },
  rudderloadstarboard: { field: 'ruddS', unit: 'as-is' },
  futekloadcell: { field: 'futek', unit: 'as-is' },
  jibtackpin: { field: 'jibTackLoad', unit: 'as-is' },
  shimstack: { field: 'shims', unit: 'as-is' },
  v0port: { field: 'v0p', unit: 'as-is' },
  v0starboard: { field: 'v0s', unit: 'as-is' },
  v1port: { field: 'v1p', unit: 'as-is' },
  v1starboard: { field: 'v1s', unit: 'as-is' },
  ebarportpos: { field: 'eBarPort', unit: 'as-is' },
  ebarstbdpos: { field: 'eBarStbd', unit: 'as-is' },
  jibinoutpos: { field: 'jibInOut', unit: 'as-is' },
  jibupdnstbdpos: { field: 'jibUpDnStbd', unit: 'as-is' },
  jibupdnportpos: { field: 'jibUpDnPort', unit: 'as-is' },

  // Targets and performance.
  targetboatspeedms: { field: 'vsTarget', unit: 'ms-to-kt' },
  targettwa: { field: 'twaTarg', unit: 'as-is' },
  polarperformancepct: { field: 'vsPerfPct', unit: 'as-is' },
  targetheel: { field: 'targHeel', unit: 'as-is' },
  targetforestay: { field: 'targFsty', unit: 'as-is' },
  targetbobstay: { field: 'targBsty', unit: 'as-is' },
  targetkeelang: { field: 'targKeel', unit: 'as-is' },
  targettoein: { field: 'targToe', unit: 'as-is' },
  targettrim: { field: 'targTrim', unit: 'as-is' },
  targetawa: { field: 'targAwa', unit: 'as-is' },
}

// Deliberately NOT mapped, and why, so the next person does not "fix" it:
//
//   coursem            `Course °M` sits beside `Course Over Ground °M`. Both are
//                      plausibly cog and only one can be; the ambiguous one is
//                      dropped rather than guessed.
//   speedthroughwaterms  the same reading as `Boat Speed m/s` on this boat, but
//                      not by definition. bsp comes from one column only.
//   polarspeedms       `Polar Speed` and `Target Boat Speed` are both speeds a
//                      target could mean. vsTarget takes the one that says so.
//   tackload           which tack? jib, gennaker and sprit each have their own
//                      column elsewhere in the file.
//   deflectupperload / deflectlowerload  loads, whereas upDflctPct / lwDflctPct
//                      are POSITIONS. Same fitting, different quantity.
const KNOWN_UNMAPPED = new Set([
  'coursem', 'speedthroughwaterms', 'polarspeedms', 'tackload',
  'deflectupperload', 'deflectlowerload',
  // The timestamp, which is read by parseDottedUtc rather than through the
  // column table. Listing it as unmapped made the one column that IS handled
  // the first thing in a report about columns that are not.
  'datetimeutc',
])

/** `DD.MM.YYYY HH:MM:SS.mmm`, read as UTC. */
export function parseDottedUtc(cell: string | undefined): number | null {
  const m = String(cell ?? '').trim()
    .match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})[ T]+(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)/)
  if (!m) return null
  const [, dd, mm, yyyy, hh, mi, ss] = m
  const ms = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)) +
    (Number(hh) * 3600 + Number(mi) * 60 + Number(ss)) * 1000
  return Number.isFinite(ms) ? ms : null
}

/**
 * Is this the log-viewer export?
 *
 * `Date/Time (UTC)` as the first column is the signature: no other format here
 * has it, and every other format's first column (`Utc`, `Datetime`, `UtcDate`,
 * `timestamp`, a `!` channel map) fails it. A second column is required as well,
 * so a stray CSV that merely happens to name a column that way is not claimed.
 */
export function isExpeditionExport(text: string): boolean {
  if (!text) return false
  const first = text.replace(/^﻿/, '').replace(/\r/g, '').split('\n').find((l) => l.trim()) || ''
  if (first.trim().startsWith('!')) return false
  const cols = first.split(',').map(norm)
  if (cols[0] !== 'datetimeutc') return false
  return cols.includes('bowpositionlatitude') || cols.includes('truewindspeedms') || cols.includes('boatspeedms')
}

export interface ExpExportRow {
  utc: number
  [field: string]: number | null
}

export interface ExpExportResult {
  rows: ExpExportRow[]
  startUtc: number
  endUtc: number
  /** Measured, not assumed — this export's rate is a logger setting. */
  rateHz: number | null
  /** Header columns with no canonical field. Reported so a channel that turns
   *  out to matter can be added deliberately rather than discovered missing. */
  unmapped: string[]
  /** Rows whose timestamp could not be read, and which were dropped. */
  skipped: number
}

export function parseExpeditionExport(text: string): ExpExportResult {
  const lines = String(text || '').replace(/^﻿/, '').replace(/\r/g, '')
    .split('\n').filter((l) => l.trim())
  if (!lines.length) return { rows: [], startUtc: 0, endUtc: 0, rateHz: null, unmapped: [], skipped: 0 }

  const headerCols = lines[0].split(',')
  const cols = headerCols.map(norm)

  // Column index per canonical field. FIRST match wins: a label repeated later
  // in the file (this export has two `True Wind Direction` columns, one
  // magnetic and one not) must not silently replace the one we chose.
  const idx = new Map<string, { i: number; unit: Unit }>()
  const unmapped: string[] = []
  cols.forEach((c, i) => {
    const spec = COLUMNS[c]
    if (!spec) {
      if (c && !KNOWN_UNMAPPED.has(c)) unmapped.push(headerCols[i].trim())
      return
    }
    if (!idx.has(spec.field)) idx.set(spec.field, { i, unit: spec.unit })
  })

  const magvarAt = cols.indexOf('magneticvariation')

  const rows: ExpExportRow[] = []
  let skipped = 0

  for (let li = 1; li < lines.length; li++) {
    const c = lines[li].split(',')
    const utc = parseDottedUtc(c[0])
    if (utc == null) { skipped++; continue }

    // Per row, not per file: variation changes across a course, and the column
    // is there precisely so it does not have to be assumed.
    const rawVar = magvarAt >= 0 ? Number(c[magvarAt]) : NaN
    const varDeg = Number.isFinite(rawVar) ? rawVar : 0

    const row: ExpExportRow = { utc }
    for (const [field, { i, unit }] of Array.from(idx)) {
      const raw = c[i]
      if (raw == null || raw.trim() === '') { row[field] = null; continue }
      const n = Number(raw)
      if (!Number.isFinite(n)) { row[field] = null; continue }
      row[field] =
        unit === 'ms-to-kt' ? n * MS_TO_KT
          : unit === 'pa-to-hpa' ? n / 100
            : unit === 'mag-to-true' ? ((n + varDeg) % 360 + 360) % 360
              : n
    }
    rows.push(row)
  }

  const startUtc = rows.length ? rows[0].utc : 0
  const endUtc = rows.length ? rows[rows.length - 1].utc : 0

  // From the MEDIAN gap between rows, not rows-per-span. A day's log stops and
  // starts — the logger is off in the dock, off between races — and averaging
  // across those gaps reports a rate the logger never ran at: a 1 Hz fixture
  // with one 40-minute break measured 0.4 Hz. The median ignores the breaks
  // because they are the minority of the intervals, which is the whole point.
  let rateHz: number | null = null
  if (rows.length > 1) {
    const deltas: number[] = []
    for (let i = 1; i < rows.length; i++) deltas.push(rows[i].utc - rows[i - 1].utc)
    deltas.sort((a, b) => a - b)
    const mid = deltas[Math.floor(deltas.length / 2)]
    if (mid > 0) rateHz = Math.round((1000 / mid) * 10) / 10
  }

  return { rows, startUtc, endUtc, rateHz, unmapped, skipped }
}

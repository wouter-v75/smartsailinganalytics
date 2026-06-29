// src/lib/logParse.ts
// ─────────────────────────────────────────────────────────────────────────────
// Single entry point for instrument-log parsing. The FORMAT is auto-detected
// from the file content (robust to a boat changing its export). The per-boat
// PROFILE (channel-label aliases) is applied on top, so a boat whose Expedition
// setup names channels differently parses without a code change.
//
//   format = auto-detect(content)              ← robust to format changes
//   aliases = defaults ⊕ boat.specs.log_profile ← per-boat customisation
//
// Existing parsers stay the single source of truth for each format; this just
// dispatches + threads the aliases.
// ─────────────────────────────────────────────────────────────────────────────

import { isFlatOleLog, parseFlatOleLog } from './flatLogParse'
// @ts-ignore — JS module, typed as any
import { parseCsvLog } from './csvLogParse'
import { effectiveAliases, type BoatLogProfile } from './logProfile'

// 'raw' (the Expedition sparse !-log, expLogParse) is RETIRED 2026-06-29 — the
// Northstar 76 export moved to the flat-CSV (flat-ole) format. The literal is kept
// in the union only so old UI labels comparing to it stay valid; it is never
// produced by detectLogFormat anymore. (expLogParse.ts can be deleted.)
export type LogFormat = 'raw' | 'flat-ole' | 'flat-nmea'

export interface ParseLogResult {
  format: LogFormat
  rows: any[]
  startUtc: number
  endUtc: number
  version?: string | null
}

export interface ParseLogOpts {
  boatProfile?: BoatLogProfile | null
  tzOffsetMin?: number // only used by the legacy flat-NMEA format (local time)
}

export function detectLogFormat(text: string): LogFormat {
  if (isFlatOleLog(text)) return 'flat-ole'   // N76 flat-CSV (OLE serial OR slash-date Utc)
  return 'flat-nmea'                           // legacy N72 NMEA-position CSV
}

export function parseLog(text: string, opts: ParseLogOpts = {}): ParseLogResult {
  const aliases = effectiveAliases(opts.boatProfile) as unknown as Record<string, string[]>
  const tz = opts.tzOffsetMin || 0
  const format = detectLogFormat(text)

  if (format === 'flat-ole') {
    const p = parseFlatOleLog(text, aliases as any)
    return { format, rows: p.rows, startUtc: p.startUtc, endUtc: p.endUtc }
  }
  // Legacy flat-NMEA CSV (N72 backfill) — parser left untouched, no alias thread.
  const p = parseCsvLog(text, tz)
  return { format, rows: p.rows, startUtc: p.startUtc, endUtc: p.endUtc }
}

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

import { isExpeditionRawLog, parseExpeditionLog } from './expLogParse'
import { isFlatOleLog, parseFlatOleLog } from './flatLogParse'
// @ts-ignore — JS module, typed as any
import { parseCsvLog } from './csvLogParse'
import { effectiveAliases, type BoatLogProfile } from './logProfile'

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
  if (isExpeditionRawLog(text)) return 'raw'
  if (isFlatOleLog(text)) return 'flat-ole'
  return 'flat-nmea'
}

export function parseLog(text: string, opts: ParseLogOpts = {}): ParseLogResult {
  const aliases = effectiveAliases(opts.boatProfile) as unknown as Record<string, string[]>
  const tz = opts.tzOffsetMin || 0
  const format = detectLogFormat(text)

  if (format === 'raw') {
    const p = parseExpeditionLog(text, aliases)
    return { format, rows: p.rows, startUtc: p.startUtc, endUtc: p.endUtc, version: p.version }
  }
  if (format === 'flat-ole') {
    const p = parseFlatOleLog(text, aliases as any)
    return { format, rows: p.rows, startUtc: p.startUtc, endUtc: p.endUtc }
  }
  // Legacy flat-NMEA CSV (N72 backfill) — parser left untouched, no alias thread.
  const p = parseCsvLog(text, tz)
  return { format, rows: p.rows, startUtc: p.startUtc, endUtc: p.endUtc }
}

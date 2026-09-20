// src/lib/trackerIngest.ts
// ─────────────────────────────────────────────────────────────────────────────
// "Drop the file, done."
//
// SSA's fundamentals are video, photos and sailing data — simple, and available
// to ALL team members as soon as possible. For a squad that means the upload
// itself must not be an interview. Everything that CAN be inferred from the
// file is inferred here, and the result says what (if anything) is genuinely
// left to ask.
//
// What gets inferred, and from where:
//
//   format        sniffed from the file content (logParse.detectLogFormat)
//   session date  the venue-LOCAL date of the first row — never the filename
//   venue offset  the timestamp's own UTC offset, when the format carries one
//   sample rate   measured from the rows
//   boat + team   the uploader's active membership
//   title         a hint from the filename, which is the only thing a human
//                 actually chose
//
// Two rules the real files forced:
//
//   • NEVER parse the filename for a date. The two real Vakaros exports from
//     ONE session were "Miss Behavior 2 2-8-2026.csv" and "Torvar's second
//     08-02-2026.csv" — the same day in M-D-YYYY and DD-MM-YYYY, one naming a
//     boat and one naming a session. The filename is a label, nothing more.
//   • The session date is the date at the VENUE, not in UTC. A late session in
//     a positive offset, or an early one in a negative offset, lands on the
//     wrong day if you take the UTC date — the same class of bug as the
//     local-wall-time trap in CLAUDE.md.
//
// Identity comes from AUTH, not from the file: tracker exports carry no device
// serial, no boat name and no session header (see vakarosCsvParse.ts), so the
// uploader's membership is what says which boat this is. When a membership
// spans boats — a coach — that is the ONE question worth asking, and `needs`
// says so rather than the caller guessing.
//
// Pure: no fetch, no storage. It returns a plan; the caller executes it.
// ─────────────────────────────────────────────────────────────────────────────

import { parseLog, type LogFormat, type ParseLogOpts } from './logParse'
import type { BoatLogProfile } from './logProfile'

/** What the caller still has to ask a human. Empty is the goal. */
export type IngestNeed = 'boat' | 'timezone'

export interface IngestMembership {
  team_id: string
  boat_id: string | null
}

export interface TrackerIngestPlan {
  ok: boolean
  error?: string
  format: LogFormat | null
  rows: any[]
  startUtc: number
  endUtc: number
  /** Venue offset in minutes. From the file when it carries one, else the fallback. */
  tzOffsetMin: number | null
  /** True when the FILE supplied the offset, so nothing needs to be asked. */
  tzFromFile: boolean
  rateHz: number | null
  /** YYYY-MM-DD at the venue. */
  sessionDate: string | null
  teamId: string | null
  boatId: string | null
  needs: IngestNeed[]
  /** Suggested session title, from the filename — the only human-chosen thing. */
  title: string | null
  /** Things worth telling the uploader. Never things to ask them. */
  notes: string[]
}

const EMPTY: TrackerIngestPlan = {
  ok: false, format: null, rows: [], startUtc: 0, endUtc: 0,
  tzOffsetMin: null, tzFromFile: false, rateHz: null, sessionDate: null,
  teamId: null, boatId: null, needs: [], title: null, notes: [],
}

/** UTC ms → YYYY-MM-DD at a venue `offsetMin` east of UTC. */
export function venueDate(utcMs: number, offsetMin: number): string {
  return new Date(utcMs + offsetMin * 60_000).toISOString().slice(0, 10)
}

/**
 * A readable label from the filename. The human typed it, so it is worth
 * keeping — but strip the extension and any trailing date-ish tokens, because
 * those are unreliable (see the header) and the real date is already known.
 */
export function titleFromFilename(filename?: string | null): string | null {
  if (!filename) return null
  let s = filename.replace(/\.[a-z0-9]{1,5}$/i, '')          // extension
  s = s.replace(/[\s_-]*\(?\d{1,4}[-_./]\d{1,2}[-_./]\d{1,4}\)?\s*$/, '') // trailing date
  s = s.replace(/\s{2,}/g, ' ').trim()                        // "second  08-02" double space
  return s || null
}

export interface PlanOpts {
  filename?: string | null
  membership?: IngestMembership | null
  /** Used only when the format does not carry its own offset. */
  tzFallbackMin?: number | null
  boatProfile?: BoatLogProfile | null
}

export function planTrackerIngest(text: string, opts: PlanOpts = {}): TrackerIngestPlan {
  const notes: string[] = []
  let parsed: ReturnType<typeof parseLog>
  try {
    const po: ParseLogOpts = { boatProfile: opts.boatProfile ?? null }
    // Only pass a fallback offset to the formats that need one; a format
    // carrying its own offset must not be shifted twice.
    if (opts.tzFallbackMin != null) po.tzOffsetMin = opts.tzFallbackMin
    parsed = parseLog(text, po)
  } catch (e: any) {
    return { ...EMPTY, error: e?.message || 'could not read the file' }
  }

  if (!parsed.rows?.length) {
    return { ...EMPTY, format: parsed.format, error: 'no rows in the file' }
  }

  const tzFromFile = parsed.tzOffsetMin != null
  const tzOffsetMin = tzFromFile ? parsed.tzOffsetMin! : (opts.tzFallbackMin ?? null)

  const needs: IngestNeed[] = []
  if (tzOffsetMin == null) needs.push('timezone')

  const sessionDate = tzOffsetMin == null ? null : venueDate(parsed.startUtc, tzOffsetMin)

  // Identity from auth. A membership pinned to a boat answers it outright; a
  // coach's team-wide membership (boat_id null) is the one case worth asking.
  const teamId = opts.membership?.team_id ?? null
  const boatId = opts.membership?.boat_id ?? null
  if (!boatId) needs.push('boat')

  if (tzFromFile) {
    notes.push(`Venue clock UTC${tzOffsetMin! >= 0 ? '+' : ''}${tzOffsetMin! / 60} — read from the file.`)
  }
  if (parsed.rateHz) notes.push(`Logged at ${parsed.rateHz} Hz.`)

  // A session that crosses local midnight is filed under its START date; say so
  // rather than silently splitting or silently mis-filing it.
  if (tzOffsetMin != null && venueDate(parsed.endUtc, tzOffsetMin) !== sessionDate) {
    notes.push('This track crosses local midnight; it is filed under the day it started.')
  }

  return {
    ok: needs.length === 0,
    format: parsed.format,
    rows: parsed.rows,
    startUtc: parsed.startUtc,
    endUtc: parsed.endUtc,
    tzOffsetMin,
    tzFromFile,
    rateHz: parsed.rateHz ?? null,
    sessionDate,
    teamId,
    boatId,
    needs,
    title: titleFromFilename(opts.filename),
    notes,
  }
}

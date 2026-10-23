// Activation windows derived from the CAMPAIGN CALENDAR.
//
// WHY. A regatta's dates are already in SSA. The campaign calendar — the
// `sessions` table, which the Event/Regatta tab writes — holds a dated row per
// day with an `event` name and a `location`. Asking for those dates a second
// time in obs_venue_activation is asking to be told twice, and the second
// telling is the one that gets forgotten: the dense network then runs all
// winter, or worse, does not run during the regatta it was set up for.
//
// So the poller takes BOTH. Stored windows stay — they cover a venue nobody
// has put on a calendar yet, and a deliberate "watch this for a fortnight" —
// and these are derived on every poll from whatever the calendar now says.
//
// LOCATION IS FREE TEXT, which is the whole difficulty. People type
// "St Tropez", "Saint-Tropez", "Golfe de St-Tropez" and "STM" for the same
// water. So matching is on a normalised form plus an explicit alias list per
// venue, and ANYTHING UNMATCHED IS REPORTED rather than dropped — a location
// that matches no venue means a regatta with no dense network and nothing to
// say so, which is exactly the failure this is supposed to remove.
//
// It never guesses by proximity of spelling. A location either matches a known
// name or alias or it does not.

import type { ActivationWindow } from './obsActivation'

export interface CampaignSessionRow {
  date: string | null
  event?: string | null
  location?: string | null
  /** The session's own offset from UTC, which the sessions table carries. */
  tz_offset_minutes?: number | null
}

export interface VenueNames {
  key: string
  name: string
  /** Extra spellings that mean this venue. */
  aliases?: readonly string[]
}

/**
 * Letters NFD will not decompose, because they are not a base plus an accent.
 *
 * This is not pedantry. NFD turns "Tønsberg" into "t nsberg", not "tonsberg",
 * because ø is its own letter rather than o with a stroke through it. Half the
 * venues here are Norwegian, and two of the aliases written for them —
 * Vesterøy and Bygdøy — would have normalised to something that could never
 * match a thing, with no error anywhere to say so. å and ä DO decompose;
 * ø, æ and ß do not.
 */
const LIGATURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/[øØ]/g, 'o'],
  [/[æÆ]/g, 'ae'],
  [/[œŒ]/g, 'oe'],
  [/ß/g, 'ss'],
  [/[đðĐÐ]/g, 'd'],
  [/[łŁ]/g, 'l'],
]

/**
 * Lower-case, unaccented, punctuation-free, single-spaced.
 *
 * "Saint-Tropez" and "SAINT TROPEZ" and "saint–tropez" (en dash) must all
 * come out the same, or the alias list has to carry every typography.
 */
export function normaliseLocation(s: string): string {
  let pre = s
  for (const [re, to] of LIGATURES) pre = pre.replace(re, to)
  return pre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * The venue a location names, or null.
 *
 * Matches the whole normalised string against the venue's name and aliases,
 * also normalised. A venue name with a slash — "Solent / Cowes",
 * "Long Beach / San Pedro" — is tried as its parts too, since that is how they
 * are written here and either half is a real place name.
 */
export function matchVenueByName(location: string, venues: readonly VenueNames[]): string | null {
  const want = normaliseLocation(location || '')
  if (!want) return null
  for (const v of venues) {
    const forms = new Set<string>([normaliseLocation(v.key), normaliseLocation(v.name)])
    for (const part of v.name.split('/')) forms.add(normaliseLocation(part))
    for (const a of v.aliases ?? []) forms.add(normaliseLocation(a))
    forms.delete('')
    if (forms.has(want)) return v.key
  }
  return null
}

export interface CampaignWindowOptions {
  /**
   * Days either side of the calendar entries to keep dense. One by default:
   * the evening before a regatta is when the sea-breeze picture is worth
   * having, and the morning after is when the debrief happens.
   */
  padDays?: number
  /**
   * A gap of this many days or fewer does not split a regatta in two. A lay
   * day is one; two consecutive weekends is not one regatta.
   */
  gapDays?: number
}

export const CAMPAIGN_WINDOW_DEFAULTS: Required<CampaignWindowOptions> = {
  padDays: 1,
  gapDays: 2,
}

export interface CampaignWindowResult {
  windows: ActivationWindow[]
  /** Locations that matched no venue, with how many sessions each — report these. */
  unmatched: Array<{ location: string; sessions: number }>
}

const DAY_MS = 86400_000
const isDay = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)

/**
 * Turn dated calendar rows into activation windows, one per run of days at a
 * venue.
 *
 * Times come out as instants built from each day's own `tz_offset_minutes`, so
 * a Mediterranean regatta's first morning is inside its window rather than two
 * hours outside it. A row with no offset is read as UTC, which is the only
 * honest fallback — and it errs by starting the window EARLIER at a venue east
 * of Greenwich, which is the harmless direction.
 */
export function campaignWindows(
  rows: readonly CampaignSessionRow[] | null | undefined,
  venues: readonly VenueNames[],
  opts: CampaignWindowOptions = {},
): CampaignWindowResult {
  const { padDays, gapDays } = { ...CAMPAIGN_WINDOW_DEFAULTS, ...opts }

  const byVenue = new Map<string, Map<string, { offsetMin: number; event: string | null }>>()
  const unmatchedCount = new Map<string, number>()

  for (const r of rows ?? []) {
    if (!isDay(r.date)) continue
    const loc = (r.location || '').trim()
    if (!loc) continue
    const key = matchVenueByName(loc, venues)
    if (!key) {
      unmatchedCount.set(loc, (unmatchedCount.get(loc) ?? 0) + 1)
      continue
    }
    const day = r.date.slice(0, 10)
    const days = byVenue.get(key) ?? new Map()
    // First entry for a day wins; they are the same day at the same venue.
    if (!days.has(day)) {
      days.set(day, {
        offsetMin: typeof r.tz_offset_minutes === 'number' ? r.tz_offset_minutes : 0,
        event: (r.event || '').trim() || null,
      })
    }
    byVenue.set(key, days)
  }

  const windows: ActivationWindow[] = []
  for (const [key, days] of Array.from(byVenue.entries())) {
    const sorted = Array.from(days.keys()).sort()
    let run: string[] = []
    const flush = () => {
      if (!run.length) return
      const first = run[0]
      const last = run[run.length - 1]
      const a = days.get(first)!
      const b = days.get(last)!
      const startMs = Date.parse(`${first}T00:00:00Z`) - a.offsetMin * 60_000 - padDays * DAY_MS
      const endMs = Date.parse(`${last}T23:59:00Z`) - b.offsetMin * 60_000 + padDays * DAY_MS
      // The event name of the run, when the days agree on one.
      const names = Array.from(new Set(run.map((d) => days.get(d)!.event).filter(Boolean)))
      windows.push({
        venueKey: key,
        startsAt: new Date(startMs).toISOString(),
        endsAt: new Date(endMs).toISOString(),
        reason: names.length === 1 ? `calendar: ${names[0]}` : `calendar: ${run.length} session(s)`,
      })
      run = []
    }
    for (const day of sorted) {
      if (!run.length) { run = [day]; continue }
      const prev = Date.parse(`${run[run.length - 1]}T00:00:00Z`)
      const gap = (Date.parse(`${day}T00:00:00Z`) - prev) / DAY_MS
      if (gap <= gapDays) run.push(day)
      else { flush(); run = [day] }
    }
    flush()
  }

  return {
    windows,
    unmatched: Array.from(unmatchedCount.entries())
      .map(([location, sessions]) => ({ location, sessions }))
      .sort((a, b) => b.sessions - a.sessions),
  }
}

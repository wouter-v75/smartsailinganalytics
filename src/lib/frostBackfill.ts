// Pure helpers for the Frost history backfill (scripts/frost-backfill.ts).
//
// These live here rather than in the script because they are the part that can
// be wrong WITHOUT SAYING SO. A month-span generator that drops a month leaves
// a gap nobody sees — the import reports a cheerful row count, and the hole
// only surfaces when a fit is trained on it a year later.

import type { WindObs } from './windObs'

/**
 * Month boundaries covering [from, to), as ISO instants.
 *
 * Month-at-a-time because that is what Frost will actually serve: one month of
 * hourly wind for five stations is 3,600 records and 4.6 MB, and a year of it
 * would be ~55 MB — past the point where the response is reliable.
 *
 * The first span is trimmed to `from` rather than starting at the 1st, and the
 * last to `to`, so the caller gets exactly the window asked for. Normalising
 * to the 1st before stepping is what keeps `setUTCMonth` honest: stepping a
 * month from the 31st lands in the month after next.
 */
export function monthSpans(from: string, to: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const startMs = Date.parse(`${from}T00:00:00Z`)
  const endMs = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return out

  const cursor = new Date(startMs)
  cursor.setUTCDate(1)
  cursor.setUTCHours(0, 0, 0, 0)

  while (cursor.getTime() < endMs) {
    const next = new Date(cursor)
    next.setUTCMonth(next.getUTCMonth() + 1)
    const a = Math.max(cursor.getTime(), startMs)
    const b = Math.min(next.getTime(), endMs)
    if (a < b) out.push([new Date(a).toISOString(), new Date(b).toISOString()])
    cursor.setTime(next.getTime())
  }
  return out
}

/**
 * Keep only readings on the hour.
 *
 * Used for a station with no PT1H series — Larvik - Fugløya serves PT10M only.
 * Sampling the ten-minute series on the hour gives one basis per station
 * instead of two readings for the same instant, which is what upsert on
 * (station_id, t) would otherwise collapse arbitrarily.
 */
export function onTheHour(obs: readonly WindObs[]): WindObs[] {
  return obs.filter((o) => typeof o.t === 'string' && o.t.slice(14, 19) === '00:00')
}

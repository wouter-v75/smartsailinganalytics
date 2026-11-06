// Which DAY the forecast deck is about.
//
// This existed nowhere, and that was the bug. Two places each decided "today"
// for themselves, both by reading the first row of whatever data they held:
//
//   buildDaily()        const today = lt[0].slice(0, 10)        // primary model
//   captureComparison() const today = keys[0].slice(0, 10)      // union grid
//
// Both answer "the earliest hour ANY model offers", which is not today and is
// not even the same thing between the two families the deck mixes:
//
//   SSA-Race     published UTC, converted to venue-local. The box's grid runs
//                from its cycle, so at 02:59 PST on 6 Nov the first frame was
//                2026-11-05T16:00Z = 08:00 PST on the FIFTH. Local day: Nov 5.
//   Open-Meteo   asked with timezone=<venue>, and it starts at 00:00 on the
//                UTC date. Same moment, first row 2026-11-06T00:00. Day: Nov 6.
//
// So on the 6 Nov deck the union grid began on the 5th, both readers took the
// 5th as "today", and the consequences ran all the way to the front page:
//
//   · the comparison charts were ranged [Nov 5 08:00, Nov 5 20:00], where the
//     only model with any data is SSA-Race. Five Open-Meteo models drew their
//     legend entries and nothing else, and the grey +/-1 sigma band vanished
//     because a band needs two models at the same hour.
//   · "Details for today" was YESTERDAY, off one model, with weightedBand's
//     1 kn floor manufacturing a +/-1 kn "spread" that looked like agreement.
//   · the confidence slide compared SSA-Race on the 5th (5.3 kn) against HRRR
//     on the 6th (22.7 kn) and reported 7.6 kn of model disagreement. It was
//     not disagreement. It was a day.
//   · the Outlook slide reads Open-Meteo and was therefore right, which is how
//     one deck came to say 4-10 kn for today and 22-31 kn for Friday.
//
// The rule below is deliberately not "the venue's today, always". A deck built
// late in the evening is for tomorrow's racing, and a venue whose SSA-Race run
// is a cycle behind still has a usable Open-Meteo day. So: among the days the
// models actually cover that have not already passed at the venue, take the one
// the MOST models cover, earliest wins a tie. On a normal morning every model
// covers today and that is today; at 02:59 with a stale nest it is the first
// day the ensemble agrees exists.

import { nowInTz } from './venueTz'

export interface DayModel {
  /** Venue-local 'YYYY-MM-DDTHH:MM' stamps, as localTimes() produces. */
  lt: readonly string[]
}

/** The venue's current calendar date, 'YYYY-MM-DD'. */
export function venueToday(tz: string, now: Date = new Date()): string {
  return nowInTz(tz, now).day
}

/** How many of `models` carry at least one hour on each local date. */
export function dayCoverage(models: readonly DayModel[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of models || []) {
    const seen: Record<string, true> = {}
    for (const t of m?.lt || []) {
      if (typeof t !== 'string' || t.length < 10) continue
      seen[t.slice(0, 10)] = true
    }
    for (const d of Object.keys(seen)) out[d] = (out[d] || 0) + 1
  }
  return out
}

/**
 * The day the deck should be built for.
 *
 * @param models  every model that will appear on it, with venue-local `lt`
 * @param tz      the venue's IANA zone
 * @param now     injectable clock, for tests
 * @returns 'YYYY-MM-DD'. Falls back to the venue's today when the models carry
 *   nothing usable, so a caller always has a date to filter on — an empty deck
 *   dated correctly beats a full one dated wrong.
 */
export function deckDay(models: readonly DayModel[], tz: string, now: Date = new Date()): string {
  const today = venueToday(tz, now)
  const cover = dayCoverage(models)
  const days = Object.keys(cover).sort()
  if (!days.length) return today
  const future = days.filter((d) => d >= today)
  // Every model's last frame is already behind us: a stale product, nothing to
  // say about today. Keep the venue's today so the deck is at least honestly
  // dated and the day filters simply come up empty.
  if (!future.length) return today
  let best = future[0]
  for (const d of future) if (cover[d] > cover[best]) best = d
  return best
}

/**
 * The hours of `day` a model covers, as indices into its own `lt`.
 * Kept here so callers stop writing `lt[i].slice(0, 10) !== today` by hand —
 * one of the two places that did also used `break`, which silently truncated
 * any model whose series did not START on the chosen day.
 */
export function indicesOnDay(lt: readonly string[], day: string): number[] {
  const out: number[] = []
  for (let i = 0; i < (lt?.length || 0); i++) if (lt[i]?.slice(0, 10) === day) out.push(i)
  return out
}

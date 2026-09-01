// campaignEvent.ts — which regatta the boat is AT (or heading to).
//
// Used for the forecast deck's title slide. The rule has to cope with a calendar
// that holds both past and future dated sessions:
//
//   1. a session dated today            -> we are at that regatta
//   2. else the EARLIEST session from today onwards -> the one we are heading to
//   3. else the LATEST session before today         -> the last one we sailed
//
// The bug this replaces sorted the whole calendar DESCENDING and took the first
// row, which is the FURTHEST-FUTURE event, not the current one. With Les Voiles de
// St Tropez sitting on the calendar for 29 September, every deck generated during
// the Maxi Worlds was titled "Les Voiles de St Tropez".

export interface EventRow {
  date: string | null           // YYYY-MM-DD
  event?: string | null
  location?: string | null
}

const isDate = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)

export function pickCampaignEvent(rows: EventRow[] | null | undefined, today: string): string | null {
  const named = (rows || []).filter((r) => isDate(r.date) && !!r.event)
  if (!named.length) return null
  // Dates are ISO, so lexicographic order is chronological order.
  const byDate = [...named].sort((a, b) => String(a.date).localeCompare(String(b.date)))

  const onToday = byDate.find((r) => String(r.date).slice(0, 10) === today)
  if (onToday) return onToday.event ?? null

  const next = byDate.find((r) => String(r.date).slice(0, 10) > today)
  if (next) return next.event ?? null

  const last = byDate[byDate.length - 1]
  return last?.event ?? null
}

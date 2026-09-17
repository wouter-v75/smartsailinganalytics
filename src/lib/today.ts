// What day is it?
//
// Six copies of `new Date().toISOString().slice(0, 10)` were spread across the app
// (localStore, the main UI, PhotosTab, AdminTab, DayPicker, ForecastView) — all
// identical, so nothing was ever inconsistent between them, and all answering in
// UTC, which was the wrong question.
//
// The app's answer is now venueToday(): every other date in SSA is venue-local
// (`new Date(utc + tzOffsetMin * 60000)`, offset resolved from the log's own
// position), and "today" was the one place that disagreed. Reach for it through
// localStore.venueTodayIso(), which supplies the offset from the session index.
//
// todayIso() below is kept as the UTC reading, NOT for app use — it is what the
// six copies did, and the tests assert the difference so the reason venueToday
// exists stays on the record.

/** The UTC date. See the note above: this is the old behaviour, not the answer. */
export const todayIso = (): string => new Date().toISOString().slice(0, 10)

/** Today in the DEVICE's timezone. */
export const localToday = (): string => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Today AT THE VENUE — the answer the rest of the app already gives.
 *
 * Every other date in SSA is venue-local: a session's date is
 * `new Date(utc + tzOffsetMin * 60000)`, with the offset resolved from the log's
 * own position (src/lib/tzFromCoords.ts). "Today" was the one place still
 * answering in UTC, which is why a 09:00 start in Auckland defaulted to the
 * previous day's session and a Med crew between 00:00 and 02:00 local got
 * yesterday.
 *
 * @param offsetMin minutes east of UTC at the venue. Null/undefined — no session
 *   has been loaded yet, so there is no venue — falls back to the DEVICE's date,
 *   which is a better guess than UTC for anyone who is not in it.
 *
 * Deliberately the same arithmetic as everywhere else, so "today" and a session's
 * own date can never disagree about which day it is.
 */
export const venueToday = (offsetMin?: number | null): string =>
  typeof offsetMin === 'number' && Number.isFinite(offsetMin)
    ? new Date(Date.now() + offsetMin * 60000).toISOString().slice(0, 10)
    : localToday()

// Today's date as YYYY-MM-DD — the default session date, the timeline's "now", the
// day a new note or scan lands on.
//
// Six copies of `new Date().toISOString().slice(0, 10)` were spread across the app
// (localStore, the main UI, PhotosTab, AdminTab, DayPicker, ForecastView). Identical,
// so nothing was ever inconsistent — but six places to change if the definition below
// ever needs to.
//
// IT IS THE UTC DATE, not the device's. That is the behaviour every copy had and this
// keeps it, but it is worth knowing where it bites: between midnight and the UTC
// offset, "today" is still yesterday. A Med venue (UTC+2) is wrong from 00:00 to 02:00
// local; Auckland (UTC+12/13) is wrong for the whole morning, so a 09:00 start would
// default to the previous day's session. Everywhere else in SSA a session's date is
// venue-local (`new Date(utc + tzOffsetMin * 60000)`, from the log's own position), so
// localToday() below is the more consistent answer — it is simply not the one that
// shipped, and switching is a behaviour change that deserves its own decision.
export const todayIso = (): string => new Date().toISOString().slice(0, 10)

/** Today in the DEVICE's timezone. See the note above before reaching for it. */
export const localToday = (): string => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

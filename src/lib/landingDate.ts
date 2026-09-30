// src/lib/landingDate.ts
// ─────────────────────────────────────────────────────────────────────────────
// Which day the app opens on.
//
// The rule is one line — "the newest day that has something and has actually
// happened, or today" — and it was written out by hand in four places. Three of
// them bounded the future. The fourth, the boat-switch path in
// useWorkspaceIdentity, bounded its local sessions and not its cloud ones, and
// that was enough: a campaign creates its days before the regatta, so the cloud
// list carries days nobody has sailed, and the app opened on the last of them.
// On 28 September it settled on 3 October and every tag pressed on the water was
// filed there — correctly timed, onto a day that had not happened. It was still
// doing it on 30 September, from the one path nobody had fixed.
//
// So the rule lives here now, once, with the bound inside it rather than at each
// call site where the next path can forget it.
//
// Dates are plain YYYY-MM-DD, which sort and compare as strings. That is the
// whole reason this can be a five-line function — see TODAY() for how the string
// is produced, and note that it is LOCAL, because a crew tagging at 23:00 in
// Sardinia is not yet on tomorrow.
// ─────────────────────────────────────────────────────────────────────────────

type MaybeDate = string | null | undefined

/** The ones that have happened, newest first. */
export function pastDates(dates: readonly MaybeDate[], today: string): string[] {
  return dates
    .filter((d): d is string => typeof d === 'string' && !!d && d <= today)
    .sort()
    .reverse()
}

/**
 * The day to open on.
 *
 * @param withData  days that hold something worth opening — a log, clips, photos
 * @param anyKnown  every day the app knows about, as a second choice: better to
 *                  land on an empty day the crew created than on nothing
 * @param today     YYYY-MM-DD, local
 *
 * Today when neither list offers a day that has happened. Never a future day:
 * "the newest session" and "a day nobody has sailed" are the same string to a
 * sort, and only one of them is somewhere to be.
 */
export function landingDate(
  withData: readonly MaybeDate[],
  anyKnown: readonly MaybeDate[],
  today: string
): string {
  return pastDates(withData, today)[0] || pastDates(anyKnown, today)[0] || today
}

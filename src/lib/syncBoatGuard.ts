// Does the ACTIVE membership own this day?
//
// syncSessionToCloud files everything it is given under whichever team/boat is
// active right now, but the local stores are keyed by DATE alone — so `activeDate`
// can perfectly well be a session belonging to a different boat. Pushing then
// silently re-files e.g. old Northstar 72 footage and its log against Northstar 76,
// and nothing in the result says so.
//
// The mobile sync path has refused this since it was found; the Upload tab and the
// desktop library sync did not, which left the same mis-filing reachable from two
// buttons. This is that check, in one place, so a fourth call site inherits it.
//
// Pure on purpose: the caller supplies the day list (getSessionsForMembership is
// localStorage-backed and browser-only), so this is testable and has no imports.

export interface BoatGuardDay {
  date: string
}

export interface BoatGuardMembership {
  boat_name?: string | null
}

/**
 * null  → safe to push.
 * string → refuse, and show this to the user. It names the boat the day would
 *          have been filed under, because "wrong boat" without saying which is
 *          not something anyone can act on.
 */
export function daySyncRefusal(
  date: string | null | undefined,
  daysForMembership: BoatGuardDay[] | null | undefined,
  membership: BoatGuardMembership | null | undefined,
  fmtDate: (d: string) => string = (d) => d
): string | null {
  if (!date) return null
  const days = daysForMembership || []
  // No local day list at all — a fresh device, or a session that only ever
  // existed in the cloud. Refusing here would block the first sync on a new
  // phone, which is worse than the risk: with nothing to compare against there
  // is no evidence the day belongs elsewhere.
  if (!days.length) return null
  if (days.some((s) => s.date === date)) return null
  const boat = membership?.boat_name || 'the active boat'
  return `⚠ ${fmtDate(date)} belongs to a different boat — not uploaded. It would be filed under ${boat}. Switch to that session's boat to sync it.`
}

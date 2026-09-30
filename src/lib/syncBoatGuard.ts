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
// POSITIVE EVIDENCE ONLY. The first version refused any day that was not in the
// active boat's local list, which quietly made "I have never heard of this day"
// mean "it is somebody else's". On 30 September that blocked the upload of the
// day the crew were sailing: today's session did not exist locally yet — the log
// was still in parts on the card — so the guard called today another boat's day
// and told them to switch to the boat they were already on. A day nobody has
// created belongs to whoever creates it. Only a day that EXISTS under a
// different (team, boat) is evidence of anything.
//
// Pure on purpose: the caller supplies the day list (getSessions is
// localStorage-backed and browser-only), so this is testable and has no imports.

export interface BoatGuardDay {
  date: string
  /** Absent on a legacy row written before sessions were workspace-tagged.
   *  Such a row is no evidence of ownership either way — see below. */
  team_id?: string | null
  boat_id?: string | null
  /** Only some callers can resolve it; the message copes without. */
  boat_name?: string | null
}

export interface BoatGuardMembership {
  team_id?: string | null
  boat_id?: string | null
  boat_name?: string | null
}

const owns = (s: BoatGuardDay, m: BoatGuardMembership | null | undefined): boolean =>
  !!m?.team_id && !!m?.boat_id && s.team_id === m.team_id && s.boat_id === m.boat_id

/** A row that names a boat, and not this one. An untagged legacy row names none,
 *  so it proves nothing and is ignored rather than counted against the day. */
const ownedByAnother = (s: BoatGuardDay, m: BoatGuardMembership | null | undefined): boolean =>
  !!s.team_id && !!s.boat_id && !owns(s, m)

/**
 * null  → safe to push.
 * string → refuse, and show this to the user.
 *
 * @param date    the day about to be pushed
 * @param allDays EVERY known session, not just the active boat's — the check is
 *                for a day that exists elsewhere, which a filtered list cannot
 *                show. Passing a filtered list makes this refuse nothing.
 */
export function daySyncRefusal(
  date: string | null | undefined,
  allDays: BoatGuardDay[] | null | undefined,
  membership: BoatGuardMembership | null | undefined,
  fmtDate: (d: string) => string = (d) => d
): string | null {
  if (!date) return null
  const sameDate = (allDays || []).filter((s) => s?.date === date)
  if (!sameDate.length) return null                       // nobody's day yet — ours to make
  if (sameDate.some((s) => owns(s, membership))) return null  // ours already
  const elsewhere = sameDate.filter((s) => ownedByAnother(s, membership))
  if (!elsewhere.length) return null                      // only untagged rows: no evidence

  // Name BOTH boats where we can. The first version named only the active one
  // and then said "switch to that session's boat" without ever saying which —
  // a sentence that reads as a contradiction when the boat it does name is the
  // one you are already on.
  const here = membership?.boat_name || 'the active boat'
  const there = elsewhere.map((s) => s.boat_name).find(Boolean) || 'another boat'
  return `⚠ ${fmtDate(date)} is ${there === 'another boat' ? 'another boat’s' : `${there}’s`} session — not uploaded. ` +
    `Syncing now would file it under ${here}. Switch to the boat that owns it first.`
}

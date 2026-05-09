// Active-membership helper.
//
// Persists the user's chosen membership scope across reloads. Other parts
// of the app (cloud tag list, future scoped data fetchers) read from here
// to know which (team, boat) to query.
//
// Stored as JSON in localStorage keyed by user id so it's per-browser-per-user.
// Falls back gracefully when localStorage is unavailable.

export type MembershipRole =
  | 'team_manager'
  | 'coach'
  | 'tl1'
  | 'tl2'
  | 'consultant'

export interface ActiveMembership {
  id: string
  team_id: string
  boat_id: string | null
  role: MembershipRole
  team_name: string
  boat_name: string | null
}

const KEY_PREFIX = 'ssa:active-membership:'

export function getActiveMembership(userId: string): ActiveMembership | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + userId)
    if (!raw) return null
    // Backwards compat: older code stored just the ID string. If we see a
    // bare ID (no JSON braces), ignore — caller will re-pick.
    if (!raw.startsWith('{')) return null
    return JSON.parse(raw) as ActiveMembership
  } catch {
    return null
  }
}

export function setActiveMembership(
  userId: string,
  m: ActiveMembership
): void {
  try {
    localStorage.setItem(KEY_PREFIX + userId, JSON.stringify(m))
  } catch {
    /* localStorage unavailable */
  }
}

export function clearActiveMembership(userId: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + userId)
  } catch {
    /* see above */
  }
}

// Legacy id-only API kept as a deprecated shim so existing callers don't
// break during the migration. Prefer get/setActiveMembership.
export function getActiveMembershipId(userId: string): string | null {
  return getActiveMembership(userId)?.id ?? null
}
export function setActiveMembershipId(
  userId: string,
  membershipId: string
): void {
  // No-op without the full object — caller should switch to setActiveMembership.
  // Kept as a non-throwing stub to avoid runtime errors in older code paths.
  void userId
  void membershipId
}

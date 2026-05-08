// Active-membership helper.
//
// When a user has multiple memberships (e.g. coach of Team A, tl2 of Team B),
// they pick one to be "active" — that scopes the SSA workspace.
//
// We persist the choice in localStorage keyed by user id so it survives
// reloads and is per-browser. When the user signs out, the key stays put
// and is reused if they sign in on the same machine. If their memberships
// change (admin revoked one, etc.) the consumer is responsible for falling
// back to the first available membership.

const KEY_PREFIX = 'ssa:active-membership:'

export function getActiveMembershipId(userId: string): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + userId)
  } catch {
    return null
  }
}

export function setActiveMembershipId(
  userId: string,
  membershipId: string
): void {
  try {
    localStorage.setItem(KEY_PREFIX + userId, membershipId)
  } catch {
    /* localStorage unavailable (private browsing limits, etc.) */
  }
}

export function clearActiveMembership(userId: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + userId)
  } catch {
    /* see above */
  }
}

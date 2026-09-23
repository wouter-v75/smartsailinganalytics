// src/lib/memberships.ts
// ─────────────────────────────────────────────────────────────────────────────
// A WORKSPACE is a team and a boat. A ROLE is how you may act in it.
//
// Those are different things, and conflating them is what made one person with
// two roles look like two people. On a small campaign the person who runs the
// team is usually also the person coaching it, so team_manager + coach in one
// team is the normal case rather than an edge one — the schema has always
// allowed it (`role` is part of memberships' unique key, and has_team_role()
// is an EXISTS over every row a user holds), but the switcher listed one entry
// per MEMBERSHIP, so the same team and boat appeared twice with different
// bracketed roles and no way to tell which to pick.
//
// collapseWorkspaces() merges them: one entry per team+boat, carrying every
// role the user holds there. Picking a workspace is then a question about
// WHERE you are working, which is the only question the switcher should ask.
// ─────────────────────────────────────────────────────────────────────────────

import type { MembershipRole } from './active-membership'

/**
 * Strongest first. Used only to choose a PRIMARY role to store and display —
 * never to decide access, which is always the database's job via
 * has_team_role(). A rank here that disagreed with a policy would be a
 * second, silently-drifting copy of the permission model.
 */
export const ROLE_RANK: MembershipRole[] = [
  'owner', 'team_manager', 'coach', 'tl3', 'tl1', 'consultant', 'guest',
]

const rankOf = (r: string): number => {
  const i = ROLE_RANK.indexOf(r as MembershipRole)
  return i === -1 ? ROLE_RANK.length : i
}

/** Strongest of a set, by ROLE_RANK. Unknown roles sort last but still win over nothing. */
export function strongestRole<T extends string>(roles: T[]): T | null {
  if (!roles.length) return null
  return [...roles].sort((a, b) => rankOf(a) - rankOf(b))[0]
}

export interface WorkspaceRowIn {
  id: string
  team_id: string
  boat_id: string | null
  role: string
  team_name: string
  boat_name: string | null
  valid_from?: string | null
  valid_to?: string | null
}

export interface WorkspaceRow extends WorkspaceRowIn {
  /** Every role this user holds in this team+boat, strongest first. */
  roles: string[]
}

/**
 * One entry per team+boat, merging a user's several roles there.
 *
 * Keeps the row of the STRONGEST role as the representative, so anything
 * reading `.role`, `.id` or the validity window off it gets the membership
 * that actually grants the most — a caller that stored the weaker one would
 * appear to lose access it still has.
 *
 * Order is preserved from the input: the switcher's ordering is decided by
 * the loader, and re-sorting here would silently override it.
 */
export function collapseWorkspaces<T extends WorkspaceRowIn>(rows: T[]): (T & { roles: string[] })[] {
  const byPlace = new Map<string, (T & { roles: string[] })[]>()
  const order: string[] = []
  for (const r of rows) {
    const key = `${r.team_id}::${r.boat_id ?? ''}`
    if (!byPlace.has(key)) { byPlace.set(key, []); order.push(key) }
    byPlace.get(key)!.push({ ...r, roles: [] })
  }
  return order.map((key) => {
    const group = byPlace.get(key)!
    const seen: string[] = []
    for (const g of group) if (!seen.includes(g.role)) seen.push(g.role)
    const roles = seen.sort((a, b) => rankOf(a) - rankOf(b))
    const best = group.find((g) => g.role === roles[0]) || group[0]
    return { ...best, roles }
  })
}

/**
 * "Northstar · Northstar 76 (team_manager, coach)".
 *
 * Every role, not just the strongest: a person who is manager AND coach wants
 * to see both, and showing only the strongest would make the second one look
 * like it had been dropped.
 */
export function workspaceLabel(m: { team_name: string; boat_name: string | null; roles?: string[]; role?: string }): string {
  const scope = m.boat_name ? `${m.team_name} · ${m.boat_name}` : m.team_name
  const roles = m.roles?.length ? m.roles : (m.role ? [m.role] : [])
  return roles.length ? `${scope} (${roles.join(', ')})` : scope
}

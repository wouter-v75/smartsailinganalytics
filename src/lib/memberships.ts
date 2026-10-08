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

// ─── Which boats are a WORKSPACE, and which are only subjects ───────────────

export interface BoatForWorkspace {
  id: string
  name: string
  team_id: string
  /** 0091: a rival, filed under the team that photographs it. */
  is_competitor?: boolean | null
}

export interface MembershipForExpand {
  id: string
  team_id: string
  boat_id: string | null
  role: string
  valid_from?: string | null
  valid_to?: string | null
}

/**
 * An "all boats" membership (boat_id NULL) → one workspace per boat.
 *
 * COMPETITORS ARE LEFT OUT, and that is the whole reason this is a function
 * rather than a loop in the switcher.
 *
 * Migration 0091 files a rival under the team that photographs it, because
 * "they have to be somewhere a coach can see, and a team is the only scope
 * there is". That is right for measuring them: /api/boats offers every boat
 * the caller can see, flagged, and SailTrim reads a rival's rig model off its
 * public IRC certificate. But the workspace switcher is asking a different
 * question — whose data am I looking at — and a rival has none. There is no
 * session, no log, no upload, no debrief; 0091 is explicit that NONE of our
 * instrument data describes them. Picking "Bella Mente" scoped the whole app
 * to a boat with nothing in it.
 *
 * So six rivals sat in the menu above the one workspace that does anything,
 * and the switcher could not tell the difference because it never asked for
 * the flag.
 *
 * A membership named a competitor EXPLICITLY (boat_id set) is kept: somebody
 * chose that, and this is not the place to overrule them. And if a team is
 * nothing but competitors, the team-level row survives with no boat rather
 * than the workspace vanishing — losing a team from the menu is worse than
 * showing one with no boat chosen.
 */
export function expandWorkspaces(
  memberships: readonly MembershipForExpand[],
  boats: readonly BoatForWorkspace[],
  teamName: (teamId: string) => string,
  boatName: (boatId: string) => string
): WorkspaceRowIn[] {
  const ours = new Map<string, BoatForWorkspace[]>()
  for (const b of boats) {
    if (b.is_competitor) continue
    const arr = ours.get(b.team_id) || []
    arr.push(b)
    ours.set(b.team_id, arr)
  }

  const out: WorkspaceRowIn[] = []
  for (const m of memberships) {
    const team_name = teamName(m.team_id)
    if (m.boat_id) {
      out.push({ ...m, team_name, boat_name: boatName(m.boat_id) })
      continue
    }
    const teamBoats = ours.get(m.team_id) || []
    if (!teamBoats.length) {
      out.push({ ...m, team_name, boat_name: null })
      continue
    }
    for (const b of teamBoats) {
      // A synthetic id (`<membershipId>::<boatId>`) so the switcher can tell
      // the expansions apart; only ever read inside the switcher.
      out.push({ ...m, id: `${m.id}::${b.id}`, boat_id: b.id, team_name, boat_name: b.name })
    }
  }
  return out
}

// src/lib/tagging/identity.ts
// Who is tagging, from the caller's memberships — the input gating.ts needs.
//
// Server-side only (it takes a Supabase client), but kept out of the route files
// because several routes need it and a Next route module should export HTTP
// handlers and nothing else.

import type { TaggerIdentity } from './types'

/** Rank used only to pick the most capable of several memberships. */
const ROLE_ORDER = [
  'guest', 'consultant', 'owner', 'tl1', 'tl3', 'coach', 'team_manager', 'admin',
]
const rank = (r: string) => {
  const i = ROLE_ORDER.indexOf(r)
  return i < 0 ? 0 : i
}

/**
 * The caller's role and crew sections for this team.
 *
 * A user can hold several memberships — crew on one boat, coach on another —
 * so the most capable one that applies to this boat decides, and the sections
 * are the union of them all.
 */
export async function identityFor(
  supabase: any,
  userId: string,
  teamId: string,
  boatId: string | null
): Promise<TaggerIdentity> {
  const [{ data: me }, { data: memberships }] = await Promise.all([
    supabase.from('users').select('global_role').eq('id', userId).maybeSingle(),
    supabase.from('memberships').select('role,section,boat_id').eq('user_id', userId).eq('team_id', teamId),
  ])
  const rows = (memberships || []) as { role: string; section: string | null; boat_id: string | null }[]
  // A team-wide membership (boat_id null) applies to every boat.
  const scoped = rows.filter((m) => !boatId || !m.boat_id || m.boat_id === boatId)
  const best = scoped.slice().sort((a, b) => rank(b.role) - rank(a.role))[0]

  return {
    userId,
    teamId,
    boatId,
    role: me?.global_role === 'admin' ? 'admin' : (best?.role || 'guest'),
    sections: Array.from(new Set(scoped.map((m) => m.section).filter((s): s is string => !!s))),
  }
}

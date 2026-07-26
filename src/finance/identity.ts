// ─────────────────────────────────────────────────────────────────────────────
// THE SEAM. This file is the ONLY contract between the finance module and the
// rest of SSA. Everything finance knows about "who is calling" comes through
// here. Finance code MUST NOT import SSA internals anywhere else — only from
// this file. When finance is one day lifted into its own app, this is the single
// file that gets reimplemented (verifying the SSA-issued JWT against SSA's public
// JWKS endpoint instead of reading the shared cookie); nothing else in the module
// changes. Keep it small on purpose.
// ─────────────────────────────────────────────────────────────────────────────
import { getServerSupabase, authedUserId } from '@/lib/supabase/server'

export type FinanceRole = 'admin' | 'project_manager' | 'boat_captain' | 'first_mate'

export interface FinanceCaller {
  userId: string       // SSA auth user UUID — the identity shared across both DBs
  teamIds: string[]    // SSA teams the user belongs to (Northstar for now)
  ssaRoles: string[]   // the user's SSA membership roles (reference only)
  isSsaAdmin: boolean  // SSA global admin (you) — used for maintenance access
}

// Resolve the current SSA-authenticated caller from the existing session, or
// null if not signed in. Uses the RLS client so the user only ever reads their
// OWN user row + memberships (no service-role needed here — that keeps this seam
// portable to a standalone finance app later).
export async function getFinanceCaller(): Promise<FinanceCaller | null> {
  const supabase = getServerSupabase()
  const userId = await authedUserId(supabase)
  if (!userId) return null

  const [{ data: userRow }, { data: memberships }] = await Promise.all([
    supabase.from('users').select('global_role').eq('id', userId).maybeSingle(),
    supabase.from('memberships').select('team_id, role').eq('user_id', userId),
  ])

  const rows = (memberships ?? []) as { team_id: string; role: string }[]
  return {
    userId,
    teamIds: Array.from(new Set(rows.map((m) => m.team_id))),
    ssaRoles: Array.from(new Set(rows.map((m) => m.role))),
    isSsaAdmin: (userRow as { global_role?: string } | null)?.global_role === 'admin',
  }
}

// The claims blob the app injects into the finance DB (Tier 2 — see db.ts). This
// is what finance-side RLS reads via request.jwt.claims. Defined here so the
// identity shape lives in one place.
export function financeClaims(caller: FinanceCaller): Record<string, unknown> {
  return {
    sub: caller.userId,
    role: 'authenticated',
    ssa_roles: caller.isSsaAdmin ? [...caller.ssaRoles, 'admin'] : caller.ssaRoles,
    ssa_teams: caller.teamIds,
  }
}

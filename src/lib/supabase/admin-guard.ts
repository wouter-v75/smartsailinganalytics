// Auth guards for privileged route handlers.
//
// requireAdmin()        — global admin only. Used for cross-tenant ops.
// requireTeamManager()  — admin OR team_manager (within the named team).
//                         Used for routes scoped to /api/admin/teams/[id]/*.
// requireActiveUser()   — any approved user. The floor for the routes that have
//                         no RLS behind them (Bunny, the AI proxies).
//
// All return either { ok: true, userId } or { ok: false, response: 401/403 }.

import { NextResponse } from 'next/server'
import { authedUserId, getServerSupabase, getServiceSupabase } from './server'

export async function requireAdmin(): Promise<
  | { ok: true; userId: string }
  | { ok: false; response: NextResponse }
> {
  const ssr = getServerSupabase()
  const {
    data: { user },
  } = await ssr.auth.getUser()
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'unauth' }, { status: 401 }),
    }
  }
  const { data: me } = await ssr
    .from('users')
    .select('global_role, status')
    .eq('id', user.id)
    .maybeSingle()
  if (!me || me.global_role !== 'admin' || me.status !== 'active') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    }
  }
  return { ok: true, userId: user.id }
}

// True if the caller is admin OR has an active team_manager membership for
// the given team. Used for team-scoped management routes.
export async function requireTeamManager(
  teamId: string
): Promise<
  | { ok: true; userId: string; isAdmin: boolean }
  | { ok: false; response: NextResponse }
> {
  const ssr = getServerSupabase()
  const {
    data: { user },
  } = await ssr.auth.getUser()
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'unauth' }, { status: 401 }),
    }
  }
  const { data: me } = await ssr
    .from('users')
    .select('global_role, status')
    .eq('id', user.id)
    .maybeSingle()
  if (!me || me.status !== 'active') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    }
  }
  if (me.global_role === 'admin') {
    return { ok: true, userId: user.id, isAdmin: true }
  }
  // Service role here so we can read any team's memberships, regardless of
  // RLS, to make a reliable yes/no.
  const service = getServiceSupabase()
  const { data: rows } = await service
    .from('memberships')
    .select('id, valid_from, valid_to')
    .eq('user_id', user.id)
    .eq('team_id', teamId)
    .eq('role', 'team_manager')
  const now = Date.now()
  const isManager = (rows || []).some((m) => {
    if (m.valid_from && new Date(m.valid_from).getTime() > now) return false
    if (m.valid_to && new Date(m.valid_to).getTime() < now) return false
    return true
  })
  if (!isManager) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    }
  }
  return { ok: true, userId: user.id, isAdmin: false }
}

// Any signed-in, active user. The floor for routes that spend money or touch
// shared infrastructure (Bunny Storage / Stream, the Scaleway + Anthropic
// proxies) and so have no RLS policy standing behind them — unlike the
// team-scoped routes, where an unauthorised read simply returns no rows.
//
// `status` matters as much as the session here: a `pending` signup holds a
// valid JWT, and without this check could upload video into the paid Stream
// library or run transcriptions before anyone has approved them.
export async function requireActiveUser(): Promise<
  | { ok: true; userId: string }
  | { ok: false; response: NextResponse }
> {
  const ssr = getServerSupabase()
  const userId = await authedUserId(ssr)
  if (!userId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'unauth' }, { status: 401 }),
    }
  }
  const { data: me } = await ssr
    .from('users')
    .select('status')
    .eq('id', userId)
    .maybeSingle()
  if (me?.status !== 'active') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    }
  }
  return { ok: true, userId }
}

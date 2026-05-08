// Admin-route guard. Every admin route handler calls requireAdmin() at the
// top to confirm the caller has an active admin profile. Returns the auth
// user id (used as approved_by, audit actor) on success, or a NextResponse
// with the appropriate error code on failure.

import { NextResponse } from 'next/server'
import { getServerSupabase } from './server'

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

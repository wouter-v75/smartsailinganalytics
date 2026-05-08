// Admin-only API route for user approvals.
//
// Privileged actions (approve / disable / reactivate) are performed with
// the service-role key. The route still re-checks the caller is an admin —
// the service-role key bypasses RLS, so we have to be careful that no path
// hits this without an admin session.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, getServiceSupabase } from '../../../../lib/supabase/server'

type Action = 'approve' | 'disable' | 'reactivate'

const STATUS_BY_ACTION: Record<Action, 'active' | 'disabled'> = {
  approve: 'active',
  disable: 'disabled',
  reactivate: 'active',
}

export async function POST(req: NextRequest) {
  const ssr = getServerSupabase()
  const {
    data: { user },
  } = await ssr.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data: me } = await ssr
    .from('users')
    .select('global_role, status')
    .eq('id', user.id)
    .maybeSingle()
  if (!me || me.global_role !== 'admin' || me.status !== 'active') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as
    | { userId?: string; action?: Action }
    | null
  if (!body?.userId || !body?.action || !(body.action in STATUS_BY_ACTION)) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  const newStatus = STATUS_BY_ACTION[body.action]
  const service = getServiceSupabase()

  const update: Record<string, unknown> = { status: newStatus }
  if (body.action === 'approve') {
    update.approved_at = new Date().toISOString()
    update.approved_by = user.id
  }

  const { error } = await service
    .from('users')
    .update(update)
    .eq('id', body.userId)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Audit
  await service.from('events').insert({
    user_id: user.id,
    action: `user.${body.action}`,
    details: { target_user_id: body.userId, new_status: newStatus },
  })

  return NextResponse.json({ ok: true, status: newStatus })
}

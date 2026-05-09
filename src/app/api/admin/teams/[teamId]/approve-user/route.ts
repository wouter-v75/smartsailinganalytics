// Team-scoped user approval. Used by the pending-requests panel on the
// team detail page so a team_manager can one-click admit a user who
// redeemed an open-link invite for THEIR team.
//
// Body: { user_id }.
// Pulls the user's requested_role / requested_boat_id (set on redeem),
// flips status='active', creates the membership, clears the requested_*
// hints. Refuses if the user isn't actually requesting this team.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../lib/supabase/admin-guard'

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as
    | { user_id?: string }
    | null
  if (!body?.user_id) {
    return NextResponse.json({ error: 'user_id required' }, { status: 400 })
  }

  const service = getServiceSupabase()
  const { data: target } = await service
    .from('users')
    .select(
      'id, status, requested_team_id, requested_role, requested_boat_id'
    )
    .eq('id', body.user_id)
    .maybeSingle()

  if (!target) {
    return NextResponse.json({ error: 'user not found' }, { status: 404 })
  }
  if (target.status !== 'pending') {
    return NextResponse.json({ error: 'user is not pending' }, { status: 400 })
  }
  if (target.requested_team_id !== params.teamId) {
    return NextResponse.json(
      { error: 'user did not request this team' },
      { status: 403 }
    )
  }

  // Default role to tl1 if requested_role wasn't set somehow.
  const role = target.requested_role || 'tl1'
  const boatId = target.requested_boat_id || null

  // Step 1 — create membership.
  const { error: memErr } = await service.from('memberships').insert({
    user_id: target.id,
    team_id: params.teamId,
    boat_id: boatId,
    role,
  })
  if (memErr && !String(memErr.message).includes('duplicate')) {
    return NextResponse.json({ error: memErr.message }, { status: 500 })
  }

  // Step 2 — flip user to active, clear hints.
  const { error: usrErr } = await service
    .from('users')
    .update({
      status: 'active',
      approved_at: new Date().toISOString(),
      approved_by: guard.userId,
      requested_team_id: null,
      requested_role: null,
      requested_boat_id: null,
    })
    .eq('id', target.id)
  if (usrErr) {
    return NextResponse.json({ error: usrErr.message }, { status: 500 })
  }

  // Audit
  await service.from('events').insert({
    user_id: guard.userId,
    action: 'user.approve.team_scoped',
    details: {
      target_user_id: target.id,
      team_id: params.teamId,
      role,
      boat_id: boatId,
    },
  })

  return NextResponse.json({ ok: true })
}

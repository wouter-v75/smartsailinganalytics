// Team-scoped decline. Clears requested_team_id / role / boat on the user
// so they no longer appear in this team's pending queue. Doesn't change
// the user's global status — they remain pending and the global admin can
// still see / approve / disable them.

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
    .select('id, requested_team_id')
    .eq('id', body.user_id)
    .maybeSingle()

  if (!target) {
    return NextResponse.json({ error: 'user not found' }, { status: 404 })
  }
  if (target.requested_team_id !== params.teamId) {
    return NextResponse.json(
      { error: 'user did not request this team' },
      { status: 403 }
    )
  }

  const { error } = await service
    .from('users')
    .update({
      requested_team_id: null,
      requested_role: null,
      requested_boat_id: null,
    })
    .eq('id', target.id)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'user.decline.team_scoped',
    details: { target_user_id: target.id, team_id: params.teamId },
  })

  return NextResponse.json({ ok: true })
}

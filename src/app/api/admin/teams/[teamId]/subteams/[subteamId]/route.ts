// PATCH  → rename / re-order / (de)activate a sub-team. Body: { label?, seq?, active? }
// DELETE → remove a sub-team (its membership links cascade; backlog items keep
//          their row but lose the sub-team reference via ON DELETE SET NULL).

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../../lib/supabase/admin-guard'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { teamId: string; subteamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as
    | { label?: string; seq?: number; active?: boolean }
    | null

  const update: Record<string, unknown> = {}
  if (body && typeof body.label === 'string') update.label = body.label.trim()
  if (body && typeof body.seq === 'number') update.seq = body.seq
  if (body && typeof body.active === 'boolean') update.active = body.active
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const service = getServiceSupabase()
  const { data, error } = await service
    .from('subteams')
    .update(update)
    .eq('id', params.subteamId)
    .eq('team_id', params.teamId)
    .select('id, category, key, label, seq, active')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'subteam.update',
    details: { team_id: params.teamId, subteam_id: params.subteamId, ...update },
  })
  return NextResponse.json({ subteam: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { teamId: string; subteamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const service = getServiceSupabase()
  const { error } = await service
    .from('subteams')
    .delete()
    .eq('id', params.subteamId)
    .eq('team_id', params.teamId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'subteam.delete',
    details: { team_id: params.teamId, subteam_id: params.subteamId },
  })
  return NextResponse.json({ ok: true })
}

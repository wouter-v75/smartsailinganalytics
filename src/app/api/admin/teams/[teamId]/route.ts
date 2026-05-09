// Single team:
//   GET    → details + boats + memberships (admin OR team_manager).
//   PATCH  → rename (admin OR team_manager).
//   DELETE → admin only. Cascade-deletes boats and memberships via FK.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../lib/supabase/server'
import {
  requireAdmin,
  requireTeamManager,
} from '../../../../../lib/supabase/admin-guard'

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const service = getServiceSupabase()
  const { data: team, error: teamErr } = await service
    .from('teams')
    .select('id, name, created_at')
    .eq('id', params.teamId)
    .maybeSingle()
  if (teamErr) {
    return NextResponse.json({ error: teamErr.message }, { status: 500 })
  }
  if (!team) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const { data: boats } = await service
    .from('boats')
    .select('id, name, sail_number, created_at')
    .eq('team_id', params.teamId)
    .order('name', { ascending: true })

  const { data: memberships } = await service
    .from('memberships')
    .select(
      'id, user_id, boat_id, role, valid_from, valid_to, created_at, users:users(id, name, email, status)'
    )
    .eq('team_id', params.teamId)
    .order('created_at', { ascending: true })

  return NextResponse.json({
    team,
    boats: boats || [],
    memberships: memberships || [],
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as
    | { name?: string }
    | null
  const name = body?.name?.trim()
  if (!name) {
    return NextResponse.json({ error: 'name required' }, { status: 400 })
  }

  const service = getServiceSupabase()
  const { data, error } = await service
    .from('teams')
    .update({ name })
    .eq('id', params.teamId)
    .select('id, name')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'team.rename',
    details: { team_id: params.teamId, name },
  })
  return NextResponse.json({ team: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  // Tenant-deletion stays admin-only.
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  const service = getServiceSupabase()
  const { error } = await service
    .from('teams')
    .delete()
    .eq('id', params.teamId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'team.delete',
    details: { team_id: params.teamId },
  })
  return NextResponse.json({ ok: true })
}

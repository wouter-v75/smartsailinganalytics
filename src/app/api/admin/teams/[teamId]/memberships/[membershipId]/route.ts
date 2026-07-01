// PATCH → edit role / boat / window. DELETE → revoke.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../../lib/supabase/admin-guard'

const ROLES = ['team_manager', 'coach', 'tl3', 'tl1', 'tl2', 'consultant', 'guest'] as const
type Role = (typeof ROLES)[number]

export async function PATCH(
  req: NextRequest,
  { params }: { params: { teamId: string; membershipId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as
    | {
        boat_id?: string | null
        role?: Role
        valid_from?: string | null
        valid_to?: string | null
        data_from?: string | null
        data_to?: string | null
      }
    | null

  const update: Record<string, unknown> = {}
  if (body && 'boat_id' in body) update.boat_id = body.boat_id || null
  if (body?.role) {
    if (!ROLES.includes(body.role)) {
      return NextResponse.json({ error: 'invalid role' }, { status: 400 })
    }
    update.role = body.role
  }
  if (body && 'valid_from' in body) update.valid_from = body.valid_from || null
  if (body && 'valid_to' in body) update.valid_to = body.valid_to || null
  if (body && 'data_from' in body) update.data_from = body.data_from || null
  if (body && 'data_to' in body) update.data_to = body.data_to || null

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const service = getServiceSupabase()
  const { data, error } = await service
    .from('memberships')
    .update(update)
    .eq('id', params.membershipId)
    .eq('team_id', params.teamId)
    .select('id, user_id, team_id, boat_id, role, valid_from, valid_to, data_from, data_to')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'membership.update',
    details: {
      team_id: params.teamId,
      membership_id: params.membershipId,
      ...update,
    },
  })
  return NextResponse.json({ membership: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { teamId: string; membershipId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const service = getServiceSupabase()
  const { error } = await service
    .from('memberships')
    .delete()
    .eq('id', params.membershipId)
    .eq('team_id', params.teamId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'membership.delete',
    details: { team_id: params.teamId, membership_id: params.membershipId },
  })
  return NextResponse.json({ ok: true })
}

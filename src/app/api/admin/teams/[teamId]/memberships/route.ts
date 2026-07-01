// POST → assign a user to (team, boat?) with role and optional time window.
// Body: { user_id, boat_id?, role, valid_from?, valid_to? }

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../lib/supabase/admin-guard'

const ROLES = ['team_manager', 'coach', 'tl3', 'tl1', 'tl2', 'consultant', 'guest'] as const
type Role = (typeof ROLES)[number]

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as
    | {
        user_id?: string
        boat_id?: string | null
        role?: Role
        valid_from?: string | null
        valid_to?: string | null
        data_from?: string | null // YYYY-MM-DD: earliest session date they may VIEW
        data_to?: string | null   // YYYY-MM-DD: latest session date they may VIEW
      }
    | null
  if (!body?.user_id || !body?.role) {
    return NextResponse.json(
      { error: 'user_id and role required' },
      { status: 400 }
    )
  }
  if (!ROLES.includes(body.role)) {
    return NextResponse.json({ error: 'invalid role' }, { status: 400 })
  }

  // Consultants must have a time window. Other roles may have one but rarely do.
  if (body.role === 'consultant') {
    if (!body.valid_from || !body.valid_to) {
      return NextResponse.json(
        { error: 'consultant requires valid_from and valid_to' },
        { status: 400 }
      )
    }
  }

  const service = getServiceSupabase()

  // Defence in depth on the picker filter in the admin UI: team_managers
  // (not global admins) may only re-scope users who already have a
  // membership on this team. Onboarding new users goes via invitations.
  if (!guard.isAdmin) {
    const { data: existing } = await service
      .from('memberships')
      .select('id')
      .eq('team_id', params.teamId)
      .eq('user_id', body.user_id)
      .limit(1)
    if (!existing || existing.length === 0) {
      return NextResponse.json(
        { error: 'user must already be on this team — invite them instead' },
        { status: 403 }
      )
    }
  }
  const { data, error } = await service
    .from('memberships')
    .insert({
      user_id: body.user_id,
      team_id: params.teamId,
      boat_id: body.boat_id || null,
      role: body.role,
      valid_from: body.valid_from || null,
      valid_to: body.valid_to || null,
      data_from: body.data_from || null,
      data_to: body.data_to || null,
    })
    .select('id, user_id, team_id, boat_id, role, valid_from, valid_to, data_from, data_to')
    .single()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'membership.create',
    details: {
      team_id: params.teamId,
      target_user_id: body.user_id,
      boat_id: body.boat_id || null,
      role: body.role,
    },
  })
  return NextResponse.json({ membership: data })
}

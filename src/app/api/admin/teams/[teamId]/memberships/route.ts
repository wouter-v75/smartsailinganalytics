// POST → assign a user to (team, boat?) with role and optional time window.
// Body: { user_id, boat_id?, role, valid_from?, valid_to? }

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../lib/supabase/admin-guard'

const ROLES = ['team_manager', 'coach', 'tl1', 'tl2', 'consultant', 'guest'] as const
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
  const { data, error } = await service
    .from('memberships')
    .insert({
      user_id: body.user_id,
      team_id: params.teamId,
      boat_id: body.boat_id || null,
      role: body.role,
      valid_from: body.valid_from || null,
      valid_to: body.valid_to || null,
    })
    .select('id, user_id, team_id, boat_id, role, valid_from, valid_to')
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

// POST   → add a membership to a sub-team   body: { membership_id, subteam_id }
// DELETE → remove a membership from a sub-team body: { membership_id, subteam_id }
//
// A member can belong to many sub-teams (the join table membership_subteams).
// Both the membership and the sub-team must belong to THIS team.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../lib/supabase/admin-guard'

interface Body {
  membership_id?: string
  subteam_id?: string
}

async function validate(
  teamId: string,
  body: Body | null
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!body?.membership_id || !body?.subteam_id) {
    return { ok: false, status: 400, error: 'membership_id and subteam_id required' }
  }
  const service = getServiceSupabase()
  const [{ data: m }, { data: s }] = await Promise.all([
    service
      .from('memberships')
      .select('id')
      .eq('id', body.membership_id)
      .eq('team_id', teamId)
      .maybeSingle(),
    service
      .from('subteams')
      .select('id')
      .eq('id', body.subteam_id)
      .eq('team_id', teamId)
      .maybeSingle(),
  ])
  if (!m) return { ok: false, status: 404, error: 'membership not in this team' }
  if (!s) return { ok: false, status: 404, error: 'subteam not in this team' }
  return { ok: true }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as Body | null
  const v = await validate(params.teamId, body)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status })

  const service = getServiceSupabase()
  // Idempotent: ignore if the link already exists (PK is membership+subteam).
  const { error } = await service.from('membership_subteams').upsert(
    {
      membership_id: body!.membership_id,
      subteam_id: body!.subteam_id,
      team_id: params.teamId,
    },
    { onConflict: 'membership_id,subteam_id', ignoreDuplicates: true }
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'membership_subteam.add',
    details: {
      team_id: params.teamId,
      membership_id: body!.membership_id,
      subteam_id: body!.subteam_id,
    },
  })
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as Body | null
  if (!body?.membership_id || !body?.subteam_id) {
    return NextResponse.json(
      { error: 'membership_id and subteam_id required' },
      { status: 400 }
    )
  }

  const service = getServiceSupabase()
  const { error } = await service
    .from('membership_subteams')
    .delete()
    .eq('membership_id', body.membership_id)
    .eq('subteam_id', body.subteam_id)
    .eq('team_id', params.teamId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'membership_subteam.remove',
    details: {
      team_id: params.teamId,
      membership_id: body.membership_id,
      subteam_id: body.subteam_id,
    },
  })
  return NextResponse.json({ ok: true })
}

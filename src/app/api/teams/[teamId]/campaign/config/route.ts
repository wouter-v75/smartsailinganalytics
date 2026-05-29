// Campaign config for the active team.
//
// GET   → { campaignOn, subteams[], mySubteamIds[], targetDate, startDate }
//         Reads under the caller's RLS. Used by the SPA to decide whether to
//         show the Campaign tab and to seed sub-team filters.
// PATCH → set the campaign target/start dates (stored in teams.features).
//         Manager/admin only.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server'
import { requireTeamManager } from '@/lib/supabase/admin-guard'

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data: team } = await supabase
    .from('teams')
    .select('features')
    .eq('id', params.teamId)
    .maybeSingle()
  const features = (team?.features as Record<string, unknown>) || {}
  const campaignOn = features.campaign_engine === true

  if (!campaignOn) {
    return NextResponse.json({ campaignOn: false })
  }

  const [{ data: subteams }, { data: myMemberships }] = await Promise.all([
    supabase
      .from('subteams')
      .select('id, category, key, label, seq, active')
      .eq('team_id', params.teamId)
      .order('seq', { ascending: true }),
    supabase
      .from('memberships')
      .select('id')
      .eq('team_id', params.teamId)
      .eq('user_id', user.id),
  ])

  const membershipIds = (myMemberships || []).map((m) => m.id)
  let mySubteamIds: string[] = []
  if (membershipIds.length) {
    const { data: links } = await supabase
      .from('membership_subteams')
      .select('subteam_id')
      .eq('team_id', params.teamId)
      .in('membership_id', membershipIds)
    mySubteamIds = (links || []).map((l) => l.subteam_id)
  }

  return NextResponse.json({
    campaignOn: true,
    subteams: subteams || [],
    mySubteamIds,
    targetDate: (features.campaign_target_date as string) || null,
    startDate: (features.campaign_start_date as string) || null,
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as
    | { target_date?: string | null; start_date?: string | null }
    | null
  if (!body) return NextResponse.json({ error: 'bad body' }, { status: 400 })

  const service = getServiceSupabase()
  const { data: team } = await service
    .from('teams')
    .select('features')
    .eq('id', params.teamId)
    .maybeSingle()
  const features = { ...((team?.features as Record<string, unknown>) || {}) }
  if ('target_date' in body) features.campaign_target_date = body.target_date || null
  if ('start_date' in body) features.campaign_start_date = body.start_date || null

  const { error } = await service
    .from('teams')
    .update({ features })
    .eq('id', params.teamId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'campaign.config.update',
    details: { team_id: params.teamId, ...body },
  })
  return NextResponse.json({
    ok: true,
    targetDate: (features.campaign_target_date as string) || null,
    startDate: (features.campaign_start_date as string) || null,
  })
}

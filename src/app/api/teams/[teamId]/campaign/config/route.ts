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
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  // Campaign is generic — every team gets it. Per-team isolation is handled
  // by RLS on team_id + boat_id (a team only ever sees its own data).
  // We still read teams.features here for targetDate/startDate, but the
  // campaign_engine flag is no longer required.
  const { data: team } = await supabase
    .from('teams')
    .select('features')
    .eq('id', params.teamId)
    .maybeSingle()
  const features = (team?.features as Record<string, unknown>) || {}

  const [{ data: subteams }, { data: myMemberships }, { data: meRow }] = await Promise.all([
    supabase
      .from('subteams')
      .select('id, category, key, label, seq, active')
      .eq('team_id', params.teamId)
      .order('seq', { ascending: true }),
    supabase
      .from('memberships')
      .select('id, role')
      .eq('team_id', params.teamId)
      .eq('user_id', user.id),
    supabase
      .from('users')
      .select('global_role')
      .eq('id', user.id)
      .maybeSingle(),
  ])

  // Compute "my sub-teams" — drives the Backlog "My sub-teams" chip and the
  // ItemForm sub-team picker. Senior roles (admin, team_manager, coach, tl3)
  // are implicitly members of every active sub-team on the team, so they
  // can both view and triage everything without having to be assigned to
  // each one manually.
  const SENIOR_ROLES = new Set(['team_manager', 'coach', 'tl3'])
  const isAdmin = meRow?.global_role === 'admin'
  const isSenior = (myMemberships || []).some((m) => SENIOR_ROLES.has(m.role))
  const membershipIds = (myMemberships || []).map((m) => m.id)
  let mySubteamIds: string[] = []
  if (isAdmin || isSenior) {
    mySubteamIds = ((subteams as Array<{ id: string; active: boolean }> | null) || [])
      .filter((s) => s.active !== false)
      .map((s) => s.id)
  } else if (membershipIds.length) {
    const { data: links } = await supabase
      .from('membership_subteams')
      .select('subteam_id')
      .eq('team_id', params.teamId)
      .in('membership_id', membershipIds)
    mySubteamIds = (links || []).map((l) => l.subteam_id)
  }

  // Team members (id + name) for owner pickers. Scoped to the active boat
  // (this boat's memberships + team-wide null-boat memberships) when a boat_id
  // is given. Read via service so the roster is complete regardless of
  // per-row membership RLS visibility.
  const boatId = req.nextUrl.searchParams.get('boat_id')
  const service = getServiceSupabase()
  let memberQ = service
    .from('memberships')
    .select('user_id, boat_id, users:users(id, name)')
    .eq('team_id', params.teamId)
  if (boatId) memberQ = memberQ.or(`boat_id.eq.${boatId},boat_id.is.null`)
  const { data: memberRows } = await memberQ
  const memberMap = new Map<string, { id: string; name: string }>()
  for (const m of memberRows || []) {
    const u = (Array.isArray(m.users) ? m.users[0] : m.users) as
      | { id: string; name: string }
      | null
    if (u && !memberMap.has(u.id)) memberMap.set(u.id, { id: u.id, name: u.name })
  }

  return NextResponse.json({
    campaignOn: true,
    subteams: subteams || [],
    mySubteamIds,
    meId: user.id,
    members: Array.from(memberMap.values()).sort((a, b) =>
      (a.name || '').localeCompare(b.name || '')
    ),
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

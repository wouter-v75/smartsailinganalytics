// Campaign config for the active team.
//
// GET   → { campaignOn, boatName, event, meId, members[], targetDate, startDate }
//         Reads under the caller's RLS. Used by the SPA to decide whether to
//         show the Campaign tab and to seed owner pickers.
// PATCH → set the campaign target/start dates (stored in teams.features).
//         Manager/admin only.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server'
import { requireTeamManager } from '@/lib/supabase/admin-guard'
import { pickCampaignEvent } from '@/lib/campaignEvent'

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

  // Boat name + current event (for the forecast deck's title slide). "Current"
  // means the regatta we are AT or heading to — see pickCampaignEvent. Both
  // optional.
  let boatName: string | null = null
  let event: string | null = null
  if (boatId) {
    const today = new Date().toISOString().slice(0, 10)
    // Window from ~4 months back forwards, ASCENDING, so the row set always holds
    // both the recent past and everything upcoming. The previous query sorted
    // DESCENDING and took row 0, which is the furthest-FUTURE event on the
    // calendar — so a regatta months away outranked the one being sailed.
    const since = new Date(Date.now() - 120 * 86400e3).toISOString().slice(0, 10)
    const [{ data: boatRow }, { data: evRows }] = await Promise.all([
      service.from('boats').select('name').eq('id', boatId).maybeSingle(),
      service.from('sessions').select('date, event').eq('team_id', params.teamId).eq('boat_id', boatId)
        .not('event', 'is', null).gte('date', since).order('date', { ascending: true }).limit(400),
    ])
    boatName = (boatRow?.name as string) || null
    event = pickCampaignEvent(evRows as Array<{ date: string; event: string | null }>, today)
  }

  return NextResponse.json({
    campaignOn: true,
    boatName,
    event,
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

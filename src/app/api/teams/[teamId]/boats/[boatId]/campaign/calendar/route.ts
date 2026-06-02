// Campaign calendar.
//
// GET → { sessions: [{ id, date, title, objective, tz_offset_minutes,
//                       boat_id, boat_name, blocks: [{...}] }],
//          targetDate, startDate }
//
// By default scoped to the boat in the URL (RLS enforces boat access).
// Pass `?scope=team` to get every session across every boat on the team the
// caller can access — used by the Plan view, since the Campaign now belongs
// to the team rather than a single boat. RLS still trims the boat set.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'

export async function GET(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const teamScope = req.nextUrl.searchParams.get('scope') === 'team'

  let q = supabase
    .from('sessions')
    .select(
      'id, date, title, objective, event, location, tz_offset_minutes, boat_id, ' +
        'boats(name), ' +
        'session_blocks(id, block_type, label, seq, start_min, end_min, objective, venue)'
    )
    .eq('team_id', params.teamId)
    .order('date', { ascending: true })
  if (!teamScope) q = q.eq('boat_id', params.boatId)

  const [{ data: rows, error }, { data: team }] = await Promise.all([
    q,
    supabase.from('teams').select('features').eq('id', params.teamId).maybeSingle(),
  ])

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const features = (team?.features as Record<string, unknown>) || {}
  const sessions = ((rows || []) as unknown as Array<Record<string, unknown>>).map((row) => {
    const { session_blocks, boats, ...rest } = row
    const blocks = ((session_blocks as Array<{ seq?: number }>) || []).sort(
      (a, b) => (a.seq ?? 0) - (b.seq ?? 0)
    )
    return {
      ...rest,
      boat_name: ((boats as { name?: string } | null)?.name) || null,
      blocks,
    }
  })

  return NextResponse.json({
    sessions,
    targetDate: (features.campaign_target_date as string) || null,
    startDate: (features.campaign_start_date as string) || null,
  })
}

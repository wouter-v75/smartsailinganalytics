// Campaign calendar for the active boat.
//
// GET → { sessions: [{ id, date, title, objective, tz_offset_minutes,
//                       blocks: [{...}] }], targetDate, startDate }
// Sessions ordered by date ASC (the work-up reads forward in time). RLS
// enforces boat access.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const [{ data: rows, error }, { data: team }] = await Promise.all([
    supabase
      .from('sessions')
      .select(
        'id, date, title, objective, tz_offset_minutes, ' +
          'session_blocks(id, block_type, label, seq, start_min, end_min, objective)'
      )
      .eq('team_id', params.teamId)
      .eq('boat_id', params.boatId)
      .order('date', { ascending: true }),
    supabase.from('teams').select('features').eq('id', params.teamId).maybeSingle(),
  ])

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const features = (team?.features as Record<string, unknown>) || {}
  const sessions = ((rows || []) as unknown as Array<Record<string, unknown>>).map((row) => {
    const { session_blocks, ...rest } = row
    const blocks = ((session_blocks as Array<{ seq?: number }>) || []).sort(
      (a, b) => (a.seq ?? 0) - (b.seq ?? 0)
    )
    return { ...rest, blocks }
  })

  return NextResponse.json({
    sessions,
    targetDate: (features.campaign_target_date as string) || null,
    startDate: (features.campaign_start_date as string) || null,
  })
}

// List sessions for the active boat. Used by the sessions sidebar in
// SmartSailingAnalytics_UI.
//
// Returns recent sessions (limit 200) ordered by date DESC. RLS enforces
// the user has boat access — anonymous / non-member calls fail with 403.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../../../lib/supabase/server'

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  // `videos(count)` is a PostgREST aggregate embed — returns the number
  // of related videos per session so the UI can show "N clips" in the
  // session picker without a second round-trip.
  const { data, error } = await supabase
    .from('sessions')
    .select(
      'id, date, title, tz_offset_minutes, created_at, updated_at, created_by_user_id, videos(count)'
    )
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .order('date', { ascending: false })
    .limit(200)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Flatten the embedded aggregate into a plain `video_count` integer.
  const sessions = (data || []).map((s) => {
    const { videos, ...rest } = s as typeof s & {
      videos?: { count: number }[]
    }
    return { ...rest, video_count: videos?.[0]?.count ?? 0 }
  })

  return NextResponse.json({ sessions })
}

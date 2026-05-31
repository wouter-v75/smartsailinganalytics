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

  // PostgREST aggregate embeds — counts of related videos AND photos per
  // session so the sidebar can hide empty folders without a second round-trip.
  const { data, error } = await supabase
    .from('sessions')
    .select(
      'id, date, title, tz_offset_minutes, created_at, updated_at, created_by_user_id, videos(count), photos(count)'
    )
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .order('date', { ascending: false })
    .limit(200)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Flatten the embedded aggregates into plain integers.
  const sessions = ((data || []) as unknown as Array<Record<string, unknown>>).map((row) => {
    const { videos, photos, ...rest } = row
    return {
      ...rest,
      video_count: (videos as { count: number }[] | undefined)?.[0]?.count ?? 0,
      photo_count: (photos as { count: number }[] | undefined)?.[0]?.count ?? 0,
    }
  })

  return NextResponse.json({ sessions })
}

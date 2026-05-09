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

  const { data, error } = await supabase
    .from('sessions')
    .select(
      'id, date, title, tz_offset_minutes, created_at, updated_at, created_by_user_id'
    )
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .order('date', { ascending: false })
    .limit(200)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ sessions: data || [] })
}

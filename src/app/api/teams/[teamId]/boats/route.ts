// List the boats on this team the caller can see. RLS does the filtering —
// `boats_select` already gates by `has_boat_access(team_id, id)` so this
// route just selects everything for the team and lets the policy trim it.
//
// Used by the Campaign tab to render the boat selector and tag rows with
// boat names when viewing in "both boats" mode.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('boats')
    .select('id, name, sail_number')
    .eq('team_id', params.teamId)
    .order('name', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ boats: data || [] })
}

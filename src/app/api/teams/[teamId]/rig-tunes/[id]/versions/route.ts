// History of the editable rig settings table for one rig baseline.
//
//   GET /api/teams/:teamId/rig-tunes/:id/versions
//     → { versions: [{ id, settings, notes, saved_at, saved_by }] }  newest first
//
// Append-only: there is no POST/DELETE here. Versions are written by the PATCH on
// the parent route as a side-effect of saving, so a version can never disagree
// with what was actually saved. RLS gates the read to people with boat access.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../../../lib/supabase/server'

const LIMIT = 50

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string; id: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('rig_settings_versions')
    .select('id,settings,notes,saved_at,saved_by_user_id,users:saved_by_user_id(name)')
    .eq('team_id', params.teamId)
    .eq('rig_tune_id', params.id)
    .order('saved_at', { ascending: false })
    .limit(LIMIT)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const versions = (data || []).map((v: any) => ({
    id: v.id,
    settings: v.settings,
    notes: v.notes,
    saved_at: v.saved_at,
    saved_by: v.users?.name || null,
  }))
  return NextResponse.json({ versions })
}

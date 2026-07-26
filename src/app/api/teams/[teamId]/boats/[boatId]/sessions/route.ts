// List sessions for the active boat. Used by the sessions sidebar in
// SmartSailingAnalytics_UI.
//
// Returns recent sessions (limit 200) ordered by date DESC. RLS enforces
// the user has boat access — anonymous / non-member calls fail with 403.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '../../../../../../../lib/supabase/server'

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  // Local JWKS verification instead of a getUser() round-trip (see authedUserId).
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  // PostgREST aggregate embeds — counts of related videos AND photos per
  // session so the sidebar can hide empty folders without a second round-trip.
  const { data, error } = await supabase
    .from('sessions')
    .select(
      'id, date, title, event, tz_offset_minutes, created_at, updated_at, created_by_user_id, videos(count), photos(count)'
    )
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .order('date', { ascending: false })
    .limit(200)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Sail-scan counts by CAPTURE DATE. Scans aren't reliably linked to a
  // session_id (matched by date elsewhere), so the FK count under-reports —
  // count by captured_at day instead. RLS gates the read.
  const { data: scanRows } = await supabase
    .from('sail_scans')
    .select('captured_at')
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .not('captured_at', 'is', null)
  const scansByDate: Record<string, number> = {}
  for (const sr of (scanRows || []) as Array<{ captured_at: string | null }>) {
    const d = String(sr.captured_at || '').slice(0, 10)
    if (d) scansByDate[d] = (scansByDate[d] || 0) + 1
  }

  // Flatten the embedded aggregates into plain integers.
  const sessions = ((data || []) as unknown as Array<Record<string, unknown>>).map((row) => {
    const { videos, photos, ...rest } = row
    return {
      ...rest,
      video_count: (videos as { count: number }[] | undefined)?.[0]?.count ?? 0,
      photo_count: (photos as { count: number }[] | undefined)?.[0]?.count ?? 0,
      scan_count: scansByDate[String((rest as { date?: string }).date || '')] ?? 0,
    }
  })

  return NextResponse.json({ sessions })
}

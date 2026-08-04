// Insert a MANUALLY-marked SailScan (from the in-app marking tool) into sail_scans.
// The sibling route.ts is report-only (multipart PDF/text -> parser); this JSON
// endpoint files a row directly from client-supplied stripe metrics. RLS gates via
// the user session, same as the report route.
import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../../lib/supabase/server'

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'expected JSON' }, { status: 400 }) }

  const boatId = body?.boat_id || null
  if (!boatId) return NextResponse.json({ error: 'boat_id required' }, { status: 400 })
  const stripes = Array.isArray(body?.stripes) ? body.stripes : []
  if (!stripes.length) return NextResponse.json({ error: 'no stripes to save' }, { status: 400 })

  const row = {
    team_id: params.teamId,
    boat_id: boatId,
    sail_id: body?.sail_id || null,
    session_id: body?.session_id || null,
    source: body?.source || 'manual',
    captured_at: body?.captured_at || null,
    tws_kn: body?.tws_kn ?? null,
    twa_deg: body?.twa_deg ?? null,
    conditions: body?.conditions || {},
    stripes,
    summary: body?.summary || null,
    report_ref: body?.report_ref || null,
    created_by_user_id: user.id,
  }

  const { data, error } = await supabase.from('sail_scans').insert(row).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ scan: data })
}

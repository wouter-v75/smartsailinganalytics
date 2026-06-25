// Short-lived signed download URL for a rig_tune's original PDF (admin only).
//
//   GET → { url, expires } | { error }
//
// The PDF lives in Bunny Storage at rig_tunes.report_key; we hand back a signed,
// expiring CDN URL. Restricted to admins — the parsed table is visible to TL2+,
// but the source document download is admin-only.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../../../lib/supabase/server'
import { signBunnyUrl, bunnyConfigured } from '../../../../../../../lib/bunny-signed-url'

export async function GET(
  req: NextRequest,
  { params }: { params: { teamId: string; id: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  // Admin gate (mirrors the RLS is_admin() helper).
  const { data: isAdmin } = await supabase.rpc('is_admin')
  if (!isAdmin) return NextResponse.json({ error: 'admin only' }, { status: 403 })

  const { data: row, error } = await supabase
    .from('rig_tunes')
    .select('report_key')
    .eq('team_id', params.teamId)
    .eq('id', params.id)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  if (!row?.report_key) return NextResponse.json({ error: 'no source PDF stored for this baseline' }, { status: 404 })
  if (!bunnyConfigured()) return NextResponse.json({ error: 'storage not configured' }, { status: 500 })

  const signed = signBunnyUrl({ path: row.report_key, ttlSec: 600 })
  if (!signed) return NextResponse.json({ error: 'could not sign url' }, { status: 500 })
  return NextResponse.json(signed)
}

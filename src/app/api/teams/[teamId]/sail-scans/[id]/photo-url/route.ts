// Short-lived signed URL for a SailScan's sail photo (extracted from the North
// PDF at import and stored in Bunny under conditions.photo_key). Visible to
// anyone with boat access (RLS on the select), unlike the admin-only rig PDF.
//
//   GET → { url, expires } | { error }

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../../../lib/supabase/server'
import { signBunnyUrl, bunnyConfigured } from '../../../../../../../lib/bunny-signed-url'

export async function GET(_req: NextRequest, { params }: { params: { teamId: string; id: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data: scan, error } = await supabase
    .from('sail_scans')
    .select('conditions')
    .eq('team_id', params.teamId)
    .eq('id', params.id)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  const key = (scan?.conditions as any)?.photo_key
  if (!key) return NextResponse.json({ error: 'no photo for this scan' }, { status: 404 })
  if (!bunnyConfigured()) return NextResponse.json({ error: 'storage not configured' }, { status: 500 })

  const signed = signBunnyUrl({ path: key, ttlSec: 3600 })
  if (!signed) return NextResponse.json({ error: 'could not sign url' }, { status: 500 })
  return NextResponse.json(signed)
}

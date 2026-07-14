// Share links for one clip.
//
//   GET    → list this clip's links (team members)
//   POST   { days?, includeOverlay? } → mint a link. TL3+ (RLS enforces).
//   DELETE ?id=<share-id>            → revoke a link.
//
// The token is a capability: whoever holds it can watch this ONE clip (and, if
// includeOverlay, the slice of log data covering it). Nothing else is reachable.
// It expires, and it can be killed at any time.

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getServerSupabase } from '../../../../../lib/supabase/server'

const SELECT = 'id,token,video_id,include_overlay,expires_at,revoked_at,view_count,last_viewed_at,created_at'
const MAX_DAYS = 90

export async function GET(
  _req: NextRequest,
  { params }: { params: { videoId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('video_shares')
    .select(SELECT)
    .eq('video_id', params.videoId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ shares: data || [] })
}

export async function POST(
  req: NextRequest,
  { params }: { params: { videoId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    days?: number
    includeOverlay?: boolean
  }
  const days = Math.min(Math.max(Number(body.days) || 14, 1), MAX_DAYS)
  const includeOverlay = body.includeOverlay !== false

  // The clip tells us its team/boat — we never take those from the caller.
  const { data: video, error: vErr } = await supabase
    .from('videos')
    .select('id,team_id,boat_id')
    .eq('id', params.videoId)
    .maybeSingle()
  if (vErr) return NextResponse.json({ error: vErr.message }, { status: 500 })
  if (!video) return NextResponse.json({ error: 'video not found' }, { status: 404 })

  // 32 bytes of entropy, URL-safe. Long enough that guessing is not a threat model.
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + days * 86400_000).toISOString()

  const { data, error } = await supabase
    .from('video_shares')
    .insert({
      token,
      video_id: video.id,
      team_id: video.team_id,
      boat_id: video.boat_id,
      include_overlay: includeOverlay,
      expires_at: expiresAt,
      created_by_user_id: user.id,
    })
    .select(SELECT)
    .single()

  if (error) {
    // RLS refusal is the common case here — say so plainly rather than "500".
    const denied = /row-level security/i.test(error.message)
    return NextResponse.json(
      { error: denied ? 'you do not have permission to share clips (TL3 and above)' : error.message },
      { status: denied ? 403 : 500 }
    )
  }
  return NextResponse.json({ share: data })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { videoId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  // Revoke rather than delete: the row is the audit trail (who shared what, when, how
  // often it was viewed). A revoked link is dead immediately, regardless of its expiry.
  const { data, error } = await supabase
    .from('video_shares')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('video_id', params.videoId)
    .select(SELECT)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ share: data })
}

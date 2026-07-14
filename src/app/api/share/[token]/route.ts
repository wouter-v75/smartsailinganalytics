// PUBLIC — no login. Serves one shared clip + (optionally) its instrument overlay.
//
//   GET /api/share/:token
//     → { title, startUtc, durationMs, rotation, playback: {url, kind}, rows?: [...] }
//
// SECURITY. The viewer has no Supabase identity, so RLS cannot protect anything here:
// we read with the SERVICE ROLE, which bypasses it entirely. That makes the token the
// one and only authorisation, and this route the one and only place it is checked. So:
//
//   • the token must exist, not be revoked, and not have expired — checked FIRST;
//   • we return exactly ONE clip, looked up BY THE SHARE ROW, never by a caller-supplied
//     id, so a token cannot be pointed at another video;
//   • the log rows are trimmed to the clip's own time window, so the share leaks the
//     data over that clip and nothing else from the session;
//   • no team, boat, session, user or sibling-clip identifiers are returned;
//   • the Bunny URL we hand out is itself short-lived and signed.
//
// A revoked or expired token returns 404 — the same as a token that never existed, so a
// probe can't distinguish "wrong" from "withdrawn".

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../lib/supabase/server'
import { bunnyConfigured, signBunnyUrl } from '../../../../lib/bunny-signed-url'

const CDN_HOST = process.env.BUNNY_CDN_HOSTNAME || ''
const STREAM_LIB = process.env.BUNNY_STREAM_LIBRARY_ID || ''
const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY || ''

// Bunny Stream HLS playlist, once the encode has finished (status 4).
async function streamHlsUrl(guid: string): Promise<string | null> {
  if (!CDN_HOST || !STREAM_LIB || !STREAM_KEY) return null
  try {
    const res = await fetch(
      `https://video.bunnycdn.com/library/${STREAM_LIB}/videos/${guid}`,
      { headers: { AccessKey: STREAM_KEY } }
    )
    if (!res.ok) return null
    const v = (await res.json()) as { status?: number }
    if (v?.status === 4) return `https://${CDN_HOST}/${guid}/playlist.m3u8`
    return null
  } catch {
    return null
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  const notFound = () => NextResponse.json({ error: 'not found' }, { status: 404 })

  const token = params.token
  if (!token || token.length < 20) return notFound()

  const db = getServiceSupabase()

  const { data: share } = await db
    .from('video_shares')
    .select('id,video_id,include_overlay,expires_at,revoked_at,view_count')
    .eq('token', token)
    .maybeSingle()

  // Dead link ⇒ indistinguishable from a bad one.
  if (!share) return notFound()
  if (share.revoked_at) return notFound()
  if (new Date(share.expires_at).getTime() < Date.now()) return notFound()

  // The clip is resolved from the SHARE ROW, never from the request.
  const { data: v } = await db
    .from('videos')
    .select('id,title,start_utc,duration_ms,rotation_deg,session_id,has_proxy,has_original,bunny_proxy_path,bunny_proxy_stream_id,bunny_original_path,bunny_original_stream_id,bunny_storage_path')
    .eq('id', share.video_id)
    .maybeSingle()
  if (!v) return notFound()

  // ── playback URL (prefer the proxy: lighter for an outside viewer) ──────────
  let playback: { url: string; kind: 'hls' | 'mp4' } | null = null
  if (v.bunny_proxy_stream_id) {
    const hls = await streamHlsUrl(v.bunny_proxy_stream_id)
    if (hls) playback = { url: hls, kind: 'hls' }
  }
  if (!playback && v.bunny_original_stream_id) {
    const hls = await streamHlsUrl(v.bunny_original_stream_id)
    if (hls) playback = { url: hls, kind: 'hls' }
  }
  if (!playback && bunnyConfigured()) {
    const path = v.bunny_proxy_path || v.bunny_original_path || v.bunny_storage_path
    if (path) {
      const signed = signBunnyUrl({ path, ttlSec: 6 * 3600 })
      if (signed?.url) playback = { url: signed.url, kind: 'mp4' }
    }
  }
  if (!playback) return NextResponse.json({ error: 'this clip is not available for playback' }, { status: 409 })

  // ── overlay data, trimmed to THIS CLIP's window only ────────────────────────
  let rows: unknown[] = []
  if (share.include_overlay && v.start_utc && v.session_id) {
    const startMs = new Date(v.start_utc).getTime()
    const endMs = startMs + (v.duration_ms || 0)
    const { data: session } = await db
      .from('sessions')
      .select('log_data')
      .eq('id', v.session_id)
      .maybeSingle()
    const ld = session?.log_data as any
    const all: any[] = Array.isArray(ld) ? ld : Array.isArray(ld?.rows) ? ld.rows : []
    // Only the samples this clip actually covers. The rest of the day is not shared.
    rows = all.filter((r) => typeof r?.utc === 'number' && r.utc >= startMs - 2000 && r.utc <= endMs + 2000)
  }

  // Best-effort view accounting; never fail the watch over it.
  db.from('video_shares')
    .update({ view_count: (share.view_count || 0) + 1, last_viewed_at: new Date().toISOString() })
    .eq('id', share.id)
    .then(() => {}, () => {})

  return NextResponse.json({
    title: v.title || 'Clip',
    startUtc: v.start_utc ? new Date(v.start_utc).getTime() : null,
    durationMs: v.duration_ms || null,
    rotation: v.rotation_deg || 0,
    includeOverlay: share.include_overlay,
    expiresAt: share.expires_at,
    playback,
    rows,
  })
}

// GET /api/videos/:videoId/url[?prefer=original|proxy]
//
// Returns a playable URL for the requested rendition of a video.
// RLS does the heavy lifting — the supabase client uses the caller's
// session cookie, so a query for a video they can't see returns nothing.
//
// Two kinds of URL can come back:
//   kind: 'hls' — a Bunny Stream adaptive-bitrate playlist (.m3u8). Since
//                 Phase 2 the full-resolution original is uploaded to Bunny
//                 Stream; Phase 3 serves its adaptive HLS once encoding has
//                 finished. The player streams the rendition that fits the
//                 viewer's connection.
//   kind: 'mp4' — a short-lived signed Bunny Storage URL (the proxy, or a
//                 legacy original / pre-migration row).
//
// Selection rule:
//   prefer=original / auto : original (Stream HLS if encoded, else legacy
//                            Storage original) → else proxy → else legacy.
//   prefer=proxy           : proxy → else original → else legacy.
//
// While a freshly-uploaded original is still encoding on Bunny's side, the
// original isn't playable yet, so the request transparently falls back to the
// proxy — that's the "instant preview, HD when ready" behaviour.
//
// Response: { url, kind, served, expires_at, has_proxy, has_original }
//   served ∈ 'original' | 'proxy' | 'legacy'

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, getServiceSupabase } from '../../../../../lib/supabase/server'
import { bunnyConfigured, signBunnyUrl } from '../../../../../lib/bunny-signed-url'
import { masterPath, masterSecret } from '../../../../../lib/hlsMaster'

type Prefer = 'original' | 'proxy' | 'auto'
type Served = 'original' | 'proxy' | 'legacy'
interface Resolved {
  url: string
  kind: 'hls' | 'mp4'
  served: Served
  expires: number | null
}

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID
const CDN_HOST = process.env.BUNNY_CDN_HOSTNAME || ''

// Ask Bunny whether a Stream video has finished encoding (status 4). Returns its
// adaptive HLS playlist URL when it has, and the status Bunny reported, so the
// caller can persist it — every OTHER device then gets the answer from one list
// query instead of a per-clip round trip.
//
// The status is returned, not stashed: it used to live in a module-level
// variable shared by every request the server instance was handling, so one
// clip's status could be written onto another clip's row.
//
// Bounded at 2.5 s. This call is most of a phone's first load; when Bunny is
// slow the caller falls back to the signed Storage MP4, which plays at once.
async function streamHls(guid: string): Promise<{ url: string | null; status: number | null }> {
  if (!STREAM_KEY || !LIBRARY_ID || !CDN_HOST) return { url: null, status: null }
  try {
    const res = await fetch(
      `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos/${guid}`,
      { headers: { AccessKey: STREAM_KEY }, cache: 'no-store', signal: AbortSignal.timeout(2500) }
    )
    if (!res.ok) return { url: null, status: null }
    const v = (await res.json()) as { status?: number }
    const status = typeof v?.status === 'number' ? v.status : null
    // status 4 = finished encoding → adaptive renditions exist.
    return { url: status === 4 ? `https://${CDN_HOST}/${guid}/playlist.m3u8` : null, status }
  } catch {
    return { url: null, status: null }
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { videoId: string } }
) {
  const ssr = getServerSupabase()
  const {
    data: { user },
  } = await ssr.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  if (!bunnyConfigured()) {
    return NextResponse.json(
      { error: 'Bunny token auth not configured (BUNNY_PULL_HOST / BUNNY_TOKEN_AUTH_KEY)' },
      { status: 503 }
    )
  }

  const preferRaw = (req.nextUrl.searchParams.get('prefer') || 'auto').toLowerCase()
  const prefer: Prefer =
    preferRaw === 'original' ? 'original'
    : preferRaw === 'proxy'   ? 'proxy'
    : 'auto'

  // RLS-gated SELECT — returns null if user can't read this row.
  const { data: v, error } = await ssr
    .from('videos')
    .select(
      'id, has_proxy, has_original, bunny_proxy_path, bunny_proxy_stream_id, proxy_stream_status, bunny_original_path, bunny_original_stream_id, original_stream_status, bunny_storage_path, thumbnail_url, title'
    )
    .eq('id', params.videoId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!v) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // ── Rendition resolvers ────────────────────────────────────────────────────
  // What Bunny said about the original during THIS request (see streamHls).
  let originalStatus: number | null = null

  const resolveOriginal = async (): Promise<Resolved | null> => {
    // Phase 2/3 — original lives in Bunny Stream as adaptive HLS.
    if (v.bunny_original_stream_id) {
      // Fast path, as the proxy already had: the row says this encode finished,
      // so skip the Bunny round trip.
      if (v.original_stream_status === 4 && CDN_HOST) {
        return {
          url: `https://${CDN_HOST}/${v.bunny_original_stream_id}/playlist.m3u8`,
          kind: 'hls',
          served: 'original',
          expires: null,
        }
      }
      const s = await streamHls(v.bunny_original_stream_id)
      originalStatus = s.status
      if (s.url) return { url: s.url, kind: 'hls', served: 'original', expires: null }
      // Stream video exists but hasn't finished encoding — not playable yet.
    }
    // Legacy — original as a signed Bunny Storage MP4.
    if (v.has_original && v.bunny_original_path) {
      const signed = signBunnyUrl({ path: v.bunny_original_path })
      if (signed) {
        return { url: signed.url, kind: 'mp4', served: 'original', expires: signed.expires }
      }
    }
    return null
  }

  const resolveProxy = async (): Promise<Resolved | null> => {
    // Genuine ABR — the proxy is encoded as an adaptive HLS ladder on Bunny
    // Stream. Prefer it over the single-bitrate Storage MP4.
    if (v.bunny_proxy_stream_id) {
      // Fast path: we've already recorded that this Stream video finished
      // encoding, so skip the Bunny round-trip.
      if (v.proxy_stream_status === 4 && CDN_HOST) {
        return {
          url: `https://${CDN_HOST}/${v.bunny_proxy_stream_id}/playlist.m3u8`,
          kind: 'hls',
          served: 'proxy',
          expires: null,
        }
      }
      const { url: hls } = await streamHls(v.bunny_proxy_stream_id)
      if (hls) {
        // Cache the finished status so future loads skip the round-trip.
        // RLS-gated; a no-op for callers who can't UPDATE — harmless.
        await ssr
          .from('videos')
          .update({ proxy_stream_status: 4 })
          .eq('id', params.videoId)
        return { url: hls, kind: 'hls', served: 'proxy', expires: null }
      }
      // Stream video exists but isn't finished encoding — falls through to
      // the Storage MP4 if there is one, else the `processing` state below.
    }
    // Legacy / fallback — proxy as a single-bitrate signed Storage MP4.
    if (v.has_proxy && v.bunny_proxy_path) {
      const signed = signBunnyUrl({ path: v.bunny_proxy_path })
      if (signed) {
        return { url: signed.url, kind: 'mp4', served: 'proxy', expires: signed.expires }
      }
    }
    return null
  }

  const resolveLegacy = (): Resolved | null => {
    // Rows that pre-date the proxy migration — only bunny_storage_path.
    if (v.bunny_storage_path) {
      const signed = signBunnyUrl({ path: v.bunny_storage_path })
      if (signed) {
        return { url: signed.url, kind: 'mp4', served: 'legacy', expires: signed.expires }
      }
    }
    return null
  }

  let result: Resolved | null = null
  if (prefer === 'proxy') {
    result = (await resolveProxy()) || (await resolveOriginal()) || resolveLegacy()
  } else {
    // 'original' and 'auto' both prefer the original first.
    result = (await resolveOriginal()) || (await resolveProxy()) || resolveLegacy()
  }

  // Bunny Stream auto-generates a poster thumbnail for every uploaded video.
  // Hand it back so cloud clips get a card image + a player poster instead
  // of a black frame. Available once the clip has any rendition on Stream.
  const thumbStreamId = v.bunny_original_stream_id || v.bunny_proxy_stream_id
  const thumbnail =
    thumbStreamId && CDN_HOST
      ? `https://${CDN_HOST}/${thumbStreamId}/thumbnail.jpg`
      : null

  // ── Record what we just learned ────────────────────────────────────────────
  // This request already asked Bunny and already built the poster URL. Writing
  // both back means the next device does not have to: the list query alone can
  // render an accurate badge and a real thumbnail. Without it, readiness lived
  // only in the uploading browser's React state — lost on reload, absent
  // everywhere else — and thumbnail_url stayed null on 15 of 16 rows, so every
  // other device drew black cards for clips that had finished long ago.
  //
  // Read was RLS-gated above, so the caller is entitled to this row; the write
  // uses the service client because it is derived metadata, not a user edit.
  // Best-effort: a failure here must never break playback.
  const patch: Record<string, unknown> = {}
  if (thumbnail && !v.thumbnail_url) patch.thumbnail_url = thumbnail
  if (originalStatus != null && v.original_stream_status !== originalStatus && v.bunny_original_stream_id) {
    patch.original_stream_status = originalStatus
  }
  if (Object.keys(patch).length) {
    try { await getServiceSupabase().from('videos').update(patch).eq('id', params.videoId) }
    catch { /* derived metadata — never fail the request over it */ }
  }

  if (!result) {
    // A Stream rendition exists but hasn't finished encoding yet — tell the
    // UI to show the "processing" state and poll, rather than erroring.
    if (v.bunny_proxy_stream_id || v.bunny_original_stream_id) {
      return NextResponse.json({
        url: null,
        kind: 'processing',
        served: 'processing',
        thumbnail,
        expires_at: null,
        has_proxy: Boolean(v.has_proxy),
        has_original: Boolean(v.has_original),
      })
    }
    return NextResponse.json({ error: 'no rendition available' }, { status: 404 })
  }

  // iPhones get a start-light copy of the HLS playlist (lib/hlsMaster): their
  // native player starts on the first rung listed, which on Bunny is 720p. Every
  // other client ignores start_url and plays Bunny's playlist directly.
  const hlsGuid = result.kind === 'hls'
    ? result.url.match(/\/([0-9a-f-]{36})\/playlist\.m3u8$/i)?.[1] ?? null
    : null
  const hlsSecret = hlsGuid ? masterSecret() : null
  const start = hlsGuid && hlsSecret ? masterPath(hlsGuid, hlsSecret) : null

  return NextResponse.json({
    url: result.url,
    kind: result.kind,
    served: result.served,
    thumbnail,
    expires_at: result.expires,
    start_url: start?.path ?? null,
    start_expires_at: start?.expires ?? null,
    has_proxy: Boolean(v.has_proxy),
    has_original: Boolean(v.has_original),
  })
}

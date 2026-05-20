// GET /api/videos/:videoId/url[?prefer=original|proxy]
//
// Returns a short-lived signed Bunny URL for the requested rendition.
// RLS does the heavy lifting — the supabase client uses the caller's
// session cookie, so a query for a video they can't see returns nothing.
//
// Selection rule:
//   prefer=original:    serve original if has_original, else proxy.
//   prefer=proxy:       serve proxy if has_proxy, else original (fallback).
//   (no prefer / 'auto'): original if available, else proxy.
//
// Response: { url, expires_at, served: 'original' | 'proxy' | 'legacy',
//             has_proxy, has_original }
//
// The 'legacy' served value covers rows that pre-date the proxy migration —
// they only have bunny_storage_path. Returned URL still signs that path.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../lib/supabase/server'
import { bunnyConfigured, signBunnyUrl } from '../../../../../lib/bunny-signed-url'

type Prefer = 'original' | 'proxy' | 'auto'

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
      'id, has_proxy, has_original, bunny_proxy_path, bunny_original_path, bunny_storage_path, title'
    )
    .eq('id', params.videoId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!v) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // Resolve path + served rendition.
  let path: string | null = null
  let served: 'original' | 'proxy' | 'legacy' = 'legacy'

  if (prefer === 'proxy') {
    if (v.has_proxy && v.bunny_proxy_path) {
      path = v.bunny_proxy_path
      served = 'proxy'
    } else if (v.has_original && v.bunny_original_path) {
      path = v.bunny_original_path
      served = 'original'
    }
  } else {
    // 'original' or 'auto' — both prefer original first.
    if (v.has_original && v.bunny_original_path) {
      path = v.bunny_original_path
      served = 'original'
    } else if (v.has_proxy && v.bunny_proxy_path) {
      path = v.bunny_proxy_path
      served = 'proxy'
    }
  }

  // Legacy fallback: rows that pre-date this migration.
  if (!path && v.bunny_storage_path) {
    path = v.bunny_storage_path
    served = 'legacy'
  }

  if (!path) {
    return NextResponse.json(
      { error: 'no rendition available' },
      { status: 404 }
    )
  }

  const signed = signBunnyUrl({ path })
  if (!signed) {
    return NextResponse.json(
      { error: 'failed to sign URL' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    url: signed.url,
    expires_at: signed.expires,
    served,
    has_proxy: Boolean(v.has_proxy),
    has_original: Boolean(v.has_original),
  })
}

// PATCH /api/videos/:videoId/renditions
//
// Marks a video as having a proxy or original rendition uploaded to the
// Bunny Storage Zone. Called by the browser AFTER it has finished the
// direct PUT to Bunny — this is just the metadata update, not the byte
// transfer.
//
// Body shape (all optional, server only applies provided fields):
//   {
//     proxy?:    { path: string, bytes?: number },
//     original?: { path: string, bytes?: number }
//   }
//
// On success:
//   { ok: true, has_proxy, has_original, proxy_path, original_path }
//
// RLS:
//   Uses the caller's session — only members of the video's team can
//   PATCH it. Anonymous/unauthenticated callers get 401.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../lib/supabase/server'

interface RenditionPatchBody {
  proxy?: { path: string; bytes?: number | null }
  original?: { path: string; bytes?: number | null }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { videoId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as RenditionPatchBody | null
  if (!body || (!body.proxy && !body.original)) {
    return NextResponse.json(
      { error: 'expected { proxy?, original? }' },
      { status: 400 }
    )
  }

  // Build a sparse update — only touch the columns the caller actually
  // sent. Avoids accidentally nulling out the other rendition on a
  // partial PATCH.
  const update: Record<string, unknown> = {}
  if (body.proxy) {
    if (typeof body.proxy.path !== 'string' || !body.proxy.path) {
      return NextResponse.json(
        { error: 'proxy.path must be a non-empty string' },
        { status: 400 }
      )
    }
    update.bunny_proxy_path = body.proxy.path
    update.has_proxy = true
    update.proxy_uploaded_at = new Date().toISOString()
    if (typeof body.proxy.bytes === 'number') {
      update.proxy_bytes = body.proxy.bytes
    }
  }
  if (body.original) {
    if (typeof body.original.path !== 'string' || !body.original.path) {
      return NextResponse.json(
        { error: 'original.path must be a non-empty string' },
        { status: 400 }
      )
    }
    update.bunny_original_path = body.original.path
    update.has_original = true
    update.original_uploaded_at = new Date().toISOString()
  }

  // RLS-gated UPDATE — returns no rows if the caller can't see this video,
  // which we treat as 404 rather than 500.
  const { data, error } = await supabase
    .from('videos')
    .update(update)
    .eq('id', params.videoId)
    .select(
      'id, has_proxy, has_original, bunny_proxy_path, bunny_original_path'
    )
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 })

  return NextResponse.json({
    ok: true,
    has_proxy: Boolean(data.has_proxy),
    has_original: Boolean(data.has_original),
    proxy_path: data.bunny_proxy_path,
    original_path: data.bunny_original_path,
  })
}

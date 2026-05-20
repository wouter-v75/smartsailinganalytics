// Video metadata per (team, boat). Auto-creates the parent session row by
// (boat_id, session_date) so callers don't have to two-step.
//
//   GET    ?date=YYYY-MM-DD  → list videos. date filter optional.
//   POST   → upsert one video. Body shape:
//            {
//              session_date: 'YYYY-MM-DD',
//              title?, start_utc?, duration_ms?, tags?: string[],
//              sync_offset_secs?, thumbnail_url?, bytes?,
//              bunny_stream_id?, bunny_storage_path?,
//              external_id?  // your local IDB id; we use it to dedupe
//            }
//
// Uniqueness: we dedupe by (boat_id, bunny_stream_id) when present, else
// by (boat_id, external_id). Re-importing the same local row is safe.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../../../lib/supabase/server'
import { getQuota, addToQuota } from '../../../../../../../lib/quota'

export async function GET(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const date = req.nextUrl.searchParams.get('date')

  // If a date filter is requested, resolve it to a session_id first.
  // Filtering directly on the joined sessions.date column doesn't filter
  // the parent rows (PostgREST quirk) — it only constrains the embedded
  // resource, so videos from every date come back.
  let sessionIdForDate: string | null | undefined = undefined
  if (date) {
    const { data: ses } = await supabase
      .from('sessions')
      .select('id')
      .eq('team_id', params.teamId)
      .eq('boat_id', params.boatId)
      .eq('date', date)
      .maybeSingle()
    sessionIdForDate = ses?.id ?? null
    if (sessionIdForDate === null) {
      // No session for that date → no videos.
      return NextResponse.json({ videos: [] })
    }
  }

  let q = supabase
    .from('videos')
    .select(
      // Phase B added has_proxy/has_original/bunny_*_path so the UI can
      // show per-rendition status and the player can ask the signed-URL
      // endpoint for the right one.
      'id, session_id, title, start_utc, duration_ms, tags, sync_offset_secs, thumbnail_url, bunny_stream_id, bunny_storage_path, bunny_proxy_path, bunny_original_path, has_proxy, has_original, proxy_uploaded_at, original_uploaded_at, proxy_bytes, bytes, created_at, created_by_user_id, sessions:sessions(date)'
    )
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .order('start_utc', { ascending: false })
    .limit(500)

  if (sessionIdForDate) {
    q = q.eq('session_id', sessionIdForDate)
  }

  const { data, error } = await q
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ videos: data || [] })
}

interface PostBody {
  session_date: string
  title?: string | null
  start_utc?: string | null
  duration_ms?: number | null
  tags?: string[]
  sync_offset_secs?: number
  thumbnail_url?: string | null
  bytes?: number | null
  bunny_stream_id?: string | null
  bunny_storage_path?: string | null
  // Optional client-side ID (IDB key) used purely for dedupe on backfill.
  external_id?: string | null
}

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as PostBody | null
  if (!body || !body.session_date) {
    return NextResponse.json({ error: 'session_date required' }, { status: 400 })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.session_date)) {
    return NextResponse.json({ error: 'session_date must be YYYY-MM-DD' }, { status: 400 })
  }

  // Quota gate — block uploads when over 100%. Backfill / re-uploads of
  // existing videos won't count twice (dedupe by bunny_stream_id below).
  const quota = await getQuota(user.id)
  if (quota?.blocked) {
    return NextResponse.json(
      { error: 'quota exceeded', quota },
      { status: 413 }
    )
  }

  // Step 1 — ensure session row exists.
  const { data: session, error: sErr } = await supabase
    .from('sessions')
    .upsert(
      {
        team_id: params.teamId,
        boat_id: params.boatId,
        date: body.session_date,
        created_by_user_id: user.id,
      },
      { onConflict: 'boat_id,date', ignoreDuplicates: false }
    )
    .select('id')
    .single()
  if (sErr || !session) {
    return NextResponse.json(
      { error: sErr?.message || 'session upsert failed' },
      { status: 500 }
    )
  }

  // Step 2 — dedupe lookup. Prefer bunny_stream_id (legacy Stream flow),
  // fall back to external_id (Phase B proxy-first flow that has no stream
  // id yet). Either match means "update this row" rather than insert a
  // duplicate.
  let existing: { id: string } | null = null
  if (body.bunny_stream_id) {
    const { data } = await supabase
      .from('videos')
      .select('id')
      .eq('boat_id', params.boatId)
      .eq('bunny_stream_id', body.bunny_stream_id)
      .maybeSingle()
    existing = data
  }
  if (!existing && body.external_id) {
    const { data } = await supabase
      .from('videos')
      .select('id')
      .eq('boat_id', params.boatId)
      .eq('external_id', body.external_id)
      .maybeSingle()
    existing = data
  }

  const videoRow: Record<string, unknown> = {
    session_id: session.id,
    team_id: params.teamId,
    boat_id: params.boatId,
    title: body.title ?? null,
    start_utc: body.start_utc ?? null,
    duration_ms: body.duration_ms ?? null,
    tags: body.tags ?? [],
    sync_offset_secs: body.sync_offset_secs ?? 0,
    thumbnail_url: body.thumbnail_url ?? null,
    bytes: body.bytes ?? null,
    bunny_stream_id: body.bunny_stream_id ?? null,
    bunny_storage_path: body.bunny_storage_path ?? null,
    external_id: body.external_id ?? null,
    created_by_user_id: user.id,
  }

  if (existing) {
    const { data, error } = await supabase
      .from('videos')
      .update(videoRow)
      .eq('id', existing.id)
      .select('id')
      .single()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ video: data, session_id: session.id, action: 'updated' })
  }

  const { data, error } = await supabase
    .from('videos')
    .insert(videoRow)
    .select('id')
    .single()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Bump quota only on fresh inserts (existing rows update via the path
  // above and don't double-count).
  if (typeof body.bytes === 'number' && body.bytes > 0) {
    await addToQuota(user.id, body.bytes)
  }

  return NextResponse.json({ video: data, session_id: session.id, action: 'created' })
}

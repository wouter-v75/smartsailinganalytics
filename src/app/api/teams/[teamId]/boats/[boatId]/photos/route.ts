// Photo metadata per (team, boat). Mirror of the videos endpoint — same
// auto-create-session behaviour, same dedupe rule (bunny_storage_path here
// since photos don't use Bunny Stream).

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
      return NextResponse.json({ photos: [] })
    }
  }

  let q = supabase
    .from('photos')
    .select(
      'id, session_id, taken_utc, exif_data, thumbnail_url, bunny_storage_path, bytes, analysis_data, created_at, created_by_user_id, sessions:sessions(date)'
    )
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .order('taken_utc', { ascending: false })
    .limit(1000)
  if (sessionIdForDate) q = q.eq('session_id', sessionIdForDate)

  const { data, error } = await q
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ photos: data || [] })
}

interface PostBody {
  session_date: string
  taken_utc?: string | null
  exif_data?: unknown
  thumbnail_url?: string | null
  bunny_storage_path?: string | null
  bytes?: number | null
  analysis_data?: unknown
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

  // Quota gate.
  const quota = await getQuota(user.id)
  if (quota?.blocked) {
    return NextResponse.json(
      { error: 'quota exceeded', quota },
      { status: 413 }
    )
  }

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

  // Dedupe by bunny_storage_path within boat.
  let existing: { id: string } | null = null
  if (body.bunny_storage_path) {
    const { data } = await supabase
      .from('photos')
      .select('id')
      .eq('boat_id', params.boatId)
      .eq('bunny_storage_path', body.bunny_storage_path)
      .maybeSingle()
    existing = data
  }

  const row: Record<string, unknown> = {
    session_id: session.id,
    team_id: params.teamId,
    boat_id: params.boatId,
    taken_utc: body.taken_utc ?? null,
    exif_data: body.exif_data ?? null,
    thumbnail_url: body.thumbnail_url ?? null,
    bunny_storage_path: body.bunny_storage_path ?? null,
    bytes: body.bytes ?? null,
    analysis_data: body.analysis_data ?? null,
    created_by_user_id: user.id,
  }

  if (existing) {
    const { data, error } = await supabase
      .from('photos')
      .update(row)
      .eq('id', existing.id)
      .select('id')
      .single()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ photo: data, session_id: session.id, action: 'updated' })
  }

  const { data, error } = await supabase
    .from('photos')
    .insert(row)
    .select('id')
    .single()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (typeof body.bytes === 'number' && body.bytes > 0) {
    await addToQuota(user.id, body.bytes)
  }
  return NextResponse.json({ photo: data, session_id: session.id, action: 'created' })
}

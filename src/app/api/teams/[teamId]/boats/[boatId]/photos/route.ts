// Photo metadata per (team, boat). Mirror of the videos endpoint — same
// auto-create-session behaviour, same dedupe rule (bunny_storage_path here
// since photos don't use Bunny Stream).

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, getServiceSupabase } from '../../../../../../../lib/supabase/server'
import { getQuota, addToQuota } from '../../../../../../../lib/quota'
import { signBunnyUrl, bunnyConfigured } from '../../../../../../../lib/bunny-signed-url'

// Serve thumbnails over the Bunny CDN (signed) instead of the slow per-request
// Vercel image proxy — the thumb key is deterministic from the original key.
function fastThumb(bunnyOriginalPath: string | null): string | null {
  if (!bunnyOriginalPath || !bunnyConfigured()) return null
  const thumbKey = bunnyOriginalPath.replace(/\.jpe?g$/i, '_thumb.jpg')
  const signed = signBunnyUrl({ path: thumbKey, ttlSec: 6 * 3600 })
  return signed?.url || null
}

// ── Bunny Storage helpers (for the wipe) ──────────────────────────────────────
const B_KEY = process.env.BUNNY_STORAGE_API_KEY
const B_ZONE = process.env.BUNNY_STORAGE_ZONE
const B_REGION = process.env.BUNNY_STORAGE_REGION || 'de'
const bBase = () => (B_REGION === 'de' ? 'https://storage.bunnycdn.com' : `https://${B_REGION}.storage.bunnycdn.com`)

// Delete every object under a Bunny Storage prefix (e.g. sessions/<date>/photos/).
async function deleteBunnyPrefix(prefix: string): Promise<{ deleted: number; errors: number }> {
  if (!B_KEY || !B_ZONE) return { deleted: 0, errors: 0 }
  let deleted = 0, errors = 0
  try {
    const listRes = await fetch(`${bBase()}/${B_ZONE}/${prefix}`, { headers: { AccessKey: B_KEY } })
    if (!listRes.ok) return { deleted: 0, errors: listRes.status === 404 ? 0 : 1 }
    const items = (await listRes.json()) as Array<{ ObjectName: string; IsDirectory: boolean }>
    for (const it of items) {
      if (it.IsDirectory) continue
      try {
        const d = await fetch(`${bBase()}/${B_ZONE}/${prefix}${it.ObjectName}`, { method: 'DELETE', headers: { AccessKey: B_KEY } })
        if (d.ok) deleted++; else errors++
      } catch { errors++ }
    }
  } catch { errors++ }
  return { deleted, errors }
}

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
  // Prefer a fast CDN thumbnail URL; keep the stored value as fallback.
  const photos = (data || []).map((p) => {
    const cdn = fastThumb(p.bunny_storage_path)
    return cdn ? { ...p, thumbnail_url: cdn } : p
  })
  return NextResponse.json({ photos })
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

// ── DELETE: wipe all photos for a date (Supabase rows + Bunny objects) ─────────
// DELETE /api/teams/<team>/boats/<boat>/photos?date=YYYY-MM-DD
// Used to clear a day and start afresh. Bunny objects are only removed once the
// session is resolved through RLS (so the caller is verified to own the date).
export async function DELETE(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  // Gate to Coach+ (coach / team-manager / global admin) — this is destructive.
  const [{ data: mems }, { data: meRow }] = await Promise.all([
    supabase.from('memberships').select('role').eq('team_id', params.teamId).eq('user_id', user.id),
    supabase.from('users').select('global_role').eq('id', user.id).maybeSingle(),
  ])
  const COACH_PLUS = new Set(['admin', 'team_manager', 'coach'])
  const allowed = meRow?.global_role === 'admin' || (mems || []).some((m) => COACH_PLUS.has(m.role))
  if (!allowed) return NextResponse.json({ error: 'forbidden — Coach or above required' }, { status: 403 })

  const date = req.nextUrl.searchParams.get('date')
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date=YYYY-MM-DD required' }, { status: 400 })
  }

  // The caller is verified Coach+ on this team → use the service client so the
  // delete isn't silently filtered by row-level security (the bug that left the
  // cloud rows behind and made re-uploads pile up duplicates).
  const service = getServiceSupabase()
  const { data: sessions } = await service
    .from('sessions')
    .select('id')
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .eq('date', date)
  const sessionIds = (sessions || []).map((s) => s.id)

  let deletedRows = 0
  if (sessionIds.length) {
    const { data: del, error } = await service
      .from('photos')
      .delete()
      .eq('team_id', params.teamId)
      .eq('boat_id', params.boatId)
      .in('session_id', sessionIds)
      .select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    deletedRows = del?.length || 0
  }

  // Remove every Bunny object under the day's photo prefix (catches duplicates
  // and orphaned objects from earlier broken runs too).
  const bunny = await deleteBunnyPrefix(`sessions/${date}/photos/`)

  return NextResponse.json({ ok: true, date, deletedRows, bunnyDeleted: bunny.deleted, bunnyErrors: bunny.errors, hadSession: sessionIds.length > 0 })
}

// Photo metadata per (team, boat). Mirror of the videos endpoint — same
// auto-create-session behaviour, same dedupe rule (bunny_storage_path here
// since photos don't use Bunny Stream).

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, getServiceSupabase } from '../../../../../../../lib/supabase/server'
import { getQuota, addToQuota } from '../../../../../../../lib/quota'
import { signBunnyUrl, bunnyConfigured } from '../../../../../../../lib/bunny-signed-url'
import { scopedPhotoPrefix, legacySessionPrefix, photoThumbKey } from '@/lib/storageKeys'
import { storageHost } from '@/lib/bunnyStorageHost'

// Serve thumbnails over the Bunny CDN (signed) instead of the slow per-request
// Vercel image proxy — the thumb key is deterministic from the original key.
function fastThumb(bunnyOriginalPath: string | null): string | null {
  if (!bunnyConfigured()) return null
  const thumbKey = photoThumbKey(bunnyOriginalPath)
  if (!thumbKey) return null
  return signBunnyUrl({ path: thumbKey, ttlSec: 6 * 3600 })?.url || null
}

// ── Bunny Storage helpers (for the wipe) ──────────────────────────────────────
const B_KEY = process.env.BUNNY_STORAGE_API_KEY
const B_ZONE = process.env.BUNNY_STORAGE_ZONE
const B_REGION = process.env.BUNNY_STORAGE_REGION || 'de'
const bBase = () => storageHost(B_REGION)

/** How many objects sit under a prefix. Used to report what a wipe could not touch. */
async function countBunnyPrefix(prefix: string): Promise<number> {
  if (!B_KEY || !B_ZONE) return 0
  try {
    const res = await fetch(`${bBase()}/${B_ZONE}/${prefix}`, { headers: { AccessKey: B_KEY } })
    if (!res.ok) return 0
    const items = (await res.json()) as Array<{ IsDirectory: boolean }>
    return Array.isArray(items) ? items.filter((i) => !i.IsDirectory).length : 0
  } catch { return 0 }
}

/** Delete every object under a Bunny Storage prefix. Caller supplies a SCOPED one. */
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
      'id, session_id, taken_utc, exif_data, thumbnail_url, bunny_storage_path, bytes, analysis_data, subject_boat_ids, created_at, created_by_user_id, sessions:sessions(date)'
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
  // Prefer a fast CDN thumbnail URL; keep the stored value as fallback. Also
  // hand back a signed URL for the FULL-RESOLUTION original so viewers (e.g. the
  // timeline lightbox) can show full res instead of the thumbnail.
  const photos = (data || []).map((p) => {
    const cdn = fastThumb(p.bunny_storage_path)
    const original_url = p.bunny_storage_path && bunnyConfigured()
      ? (signBunnyUrl({ path: p.bunny_storage_path, ttlSec: 6 * 3600 })?.url || null)
      : null
    return { ...(cdn ? { ...p, thumbnail_url: cdn } : p), original_url }
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

  // Dedupe by bunny_storage_path within boat. `analysis_data` comes back too,
  // because an UPDATE has to MERGE into it rather than replace it — see below.
  let existing: { id: string; analysis_data: Record<string, unknown> | null } | null = null
  if (body.bunny_storage_path) {
    const { data } = await supabase
      .from('photos')
      .select('id, analysis_data')
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
    bytes: body.bytes ?? null,
    created_by_user_id: user.id,
  }
  // The locator, written only when supplied — never nulled by its absence. It
  // is also the dedupe key above, so an UPDATE always has one; this guards the
  // insert path and anything added later. Same rule as the videos route.
  if (typeof body.bunny_storage_path === 'string' && body.bunny_storage_path) {
    row.bunny_storage_path = body.bunny_storage_path
  }

  if (existing) {
    // ── analysis_data is MERGED, not replaced ─────────────────────────────
    // It is one JSON blob holding several independent things: `inst` (the
    // instrument snapshot, written at import), `sails` / `raceTags` / `boat` /
    // `location`, and `sailTrim` — the hand-marked sail geometry, which is the
    // most expensive data in the app and the only one nothing can regenerate.
    //
    // Every client writer already SENDS a merge: `{ ...photo.analysis, sailTrim }`.
    // But each merges into ITS OWN idea of what is stored, and that is where it
    // broke. `savePhotoSailTrim` (the timeline) writes the shared row and
    // nothing local; `photoStore.mirror()` — fired by a deferred original
    // finally uploading on Wi-Fi — sends the IMPORTING DEVICE's `analysis`,
    // which never heard about that measurement. The handler replaced the whole
    // column, so the second write silently deleted the geometry. PhotosTab is
    // safe only because `mergeCloudIntoLocal` folds the cloud's copy in first,
    // and that function has exactly one caller.
    //
    // Per-caller workarounds are what `savePhotoSailTrim`'s own header warns
    // about ("anything omitted is nulled… that is the trap here"). One caller
    // eventually forgets. Merging here means none of them has to be careful.
    //
    // Shallow by design: the keys are independent blobs. Nothing in the app
    // removes a key — every writer adds or replaces one — so a merge cannot
    // lose an intended deletion today. A deliberate removal would need its own
    // mechanism, and should not be smuggled in as an absence.
    const incoming = (body.analysis_data ?? null) as Record<string, unknown> | null
    if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
      row.analysis_data = { ...(existing.analysis_data || {}), ...incoming }
    }
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

  // Insert: there is nothing to merge into, so the blob goes in as given.
  if (body.analysis_data != null) row.analysis_data = body.analysis_data
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

  // Remove every Bunny object under THIS BOAT'S photo prefix for the day.
  //
  // It used to be `sessions/${date}/photos/` — the date and nothing else. The zone
  // is shared by every tenant, so a coach clearing their own day deleted every
  // other team's photos for that date as well. The Coach+ check above was on this
  // team; the key it then used belonged to all of them.
  //
  // scopedPhotoPrefix returns null rather than ever naming the flat prefix, so
  // there is no path through here that can reach another team's bytes.
  //
  // WHAT THIS MEANS FOR OLD DATA: photos uploaded before scoping still live under
  // the flat prefix, and are no longer deleted by a day-wipe. That is deliberate —
  // deleting them is the cross-tenant reach being removed, and it cannot be done
  // safely until each object's owner is known. They are reported separately below
  // so the caller can see the day was not fully cleared.
  const prefix = scopedPhotoPrefix({ teamId: params.teamId, boatId: params.boatId }, date)
  const bunny = prefix
    ? await deleteBunnyPrefix(prefix)
    : { deleted: 0, errors: 0 }

  const legacyPrefix = legacySessionPrefix(date)
  const legacyRemaining = legacyPrefix
    ? await countBunnyPrefix(`${legacyPrefix}photos/`)
    : 0

  return NextResponse.json({
    ok: true, date, deletedRows,
    bunnyDeleted: bunny.deleted, bunnyErrors: bunny.errors,
    hadSession: sessionIds.length > 0,
    // Objects from before storage was tenant-scoped. Not ours to delete from here.
    legacyObjectsLeft: legacyRemaining || undefined,
  })
}

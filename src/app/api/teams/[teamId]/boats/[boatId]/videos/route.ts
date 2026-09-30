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
import { PURGE_COLUMNS, planPurge, type DeletedVideoRow } from '../../../../../../../lib/videoPurge'

// Bunny Stream auto-generates a poster thumbnail for every uploaded video.
// We hand it back inline in the list response (derived from the original's
// GUID — no extra round-trip) so the library can render every card from
// this one call instead of a per-clip signed-URL request.
const CDN_HOST = process.env.BUNNY_CDN_HOSTNAME || ''

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
      'id, external_id, session_id, title, start_utc, duration_ms, tags, sync_offset_secs, thumbnail_url, bunny_stream_id, bunny_storage_path, bunny_proxy_path, bunny_original_path, bunny_original_stream_id, bunny_proxy_stream_id, original_stream_status, proxy_stream_status, has_proxy, has_original, proxy_uploaded_at, original_uploaded_at, proxy_bytes, bytes, created_at, created_by_user_id, sessions:sessions(date)'
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
  // Attach the Bunny Stream poster thumbnail URL inline (no per-clip call).
  //
  // ANY Stream rendition has a poster, not just an original. This looked only at
  // bunny_original_stream_id, so a clip uploaded as a proxy — which is most of them
  // — came back with thumbnail: null and drew a black card. It went unnoticed on the
  // machine that did the uploading, because there the card falls back to the local
  // blob; every OTHER device had nothing to fall back to. Same precedence the player
  // route uses, so the card and the poster agree: original first, else the proxy.
  const posterFor = (v: { bunny_original_stream_id?: string | null; bunny_proxy_stream_id?: string | null; bunny_stream_id?: string | null }) => {
    const id = v.bunny_original_stream_id || v.bunny_proxy_stream_id || v.bunny_stream_id
    return id && CDN_HOST ? `https://${CDN_HOST}/${id}/thumbnail.jpg` : null
  }
  // Is this clip PLAYABLE, as opposed to merely present in the cloud? Bunny's 4
  // means finished. NULL means nobody has asked yet, which is not the same as "not
  // ready" — an older clip predating this column would otherwise start claiming it
  // was still encoding, so only a known non-4 counts as encoding.
  const encoding = (v: { original_stream_status?: number | null; proxy_stream_status?: number | null; has_original?: boolean; has_proxy?: boolean }) => {
    const st = v.has_original ? v.original_stream_status : v.has_proxy ? v.proxy_stream_status : null
    return st == null ? null : st !== 4
  }
  const videos = (data || []).map((v) => ({
    ...v,
    stream_encoding: encoding(v),
    thumbnail: posterFor(v),
    // Fill the stored column too when it is empty, so consumers reading
    // thumbnail_url (the timeline) see a poster without each learning this rule.
    thumbnail_url: v.thumbnail_url || posterFor(v),
  }))
  return NextResponse.json({ videos })
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

  // Step 1 — ensure the session row exists. FIND-then-INSERT, deliberately NOT an
  // upsert. The upsert was wrong twice over:
  //
  //  1. On conflict it ran an UPDATE, which is gated by `sessions_update` — and that
  //     policy is `own_or_coach(...)`, so a crew member who didn't create the session
  //     and isn't a coach was refused: "new row violates row-level security policy
  //     (USING expression) for table sessions". Adding a video should never require
  //     permission to MODIFY the day's session row.
  //  2. It set created_by_user_id on conflict too, so whoever uploaded a clip last
  //     silently took ownership of a session someone else had created.
  //
  // Reading first needs only SELECT (everyone on the boat has it), and we insert only
  // when the day genuinely has no session yet.
  let session: { id: string } | null = null
  const { data: existingSession } = await supabase
    .from('sessions')
    .select('id')
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .eq('date', body.session_date)
    .maybeSingle()
  session = existingSession ?? null

  if (!session) {
    const { data: created, error: sErr } = await supabase
      .from('sessions')
      .insert({
        team_id: params.teamId,
        boat_id: params.boatId,
        date: body.session_date,
        created_by_user_id: user.id,
      })
      .select('id')
      .single()
    if (sErr || !created) {
      // A concurrent upload may have created it between our SELECT and INSERT —
      // re-read rather than fail the upload.
      const { data: raced } = await supabase
        .from('sessions')
        .select('id')
        .eq('team_id', params.teamId)
        .eq('boat_id', params.boatId)
        .eq('date', body.session_date)
        .maybeSingle()
      if (!raced) {
        return NextResponse.json(
          { error: sErr?.message || 'could not create the session for this date' },
          { status: 500 }
        )
      }
      session = raced
    } else {
      session = created
    }
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── purging the blobs a deleted row leaves in Bunny ──────────────────────────
// Storage is written with BUNNY_STORAGE_WRITE_KEY; the read-only key returns 401
// on a DELETE, so a deployment without the write key must SAY it skipped rather
// than report a purge it did not do. See the note in CLAUDE.md: leaving the
// write key out is a deliberate read-only posture, not a misconfiguration.
const STORAGE_WRITE_KEY = process.env.BUNNY_STORAGE_WRITE_KEY
const STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE
const STORAGE_REGION = process.env.BUNNY_STORAGE_REGION || 'de'
const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY
const STREAM_LIBRARY = process.env.BUNNY_STREAM_LIBRARY_ID

const storageBase = () =>
  STORAGE_REGION === 'de'
    ? 'https://storage.bunnycdn.com'
    : `https://${STORAGE_REGION}.storage.bunnycdn.com`

interface PurgeReport {
  /** Objects and stream videos actually removed. */
  ok: string[]
  /** Things we tried and could not remove — named, so the row being gone while
   *  the file survives is visible instead of silent. */
  failed: string[]
  /** Not attempted, because Bunny is not configured for writes here. */
  skipped: string[]
}

const emptyPurge = (): PurgeReport => ({ ok: [], failed: [], skipped: [] })

// A 404 counts as purged: the object is not there, which is the state we wanted.
const gone = (status: number) => status === 404 || (status >= 200 && status < 300)

async function purgeBunny(rows: readonly DeletedVideoRow[]): Promise<PurgeReport> {
  const plan = planPurge(rows)
  const report = emptyPurge()

  for (const key of plan.storageKeys) {
    if (!STORAGE_WRITE_KEY || !STORAGE_ZONE) { report.skipped.push(key); continue }
    try {
      const res = await fetch(`${storageBase()}/${STORAGE_ZONE}/${key}`, {
        method: 'DELETE',
        headers: { AccessKey: STORAGE_WRITE_KEY },
      })
      ;(gone(res.status) ? report.ok : report.failed).push(key)
    } catch { report.failed.push(key) }
  }

  for (const streamId of plan.streamIds) {
    if (!STREAM_KEY || !STREAM_LIBRARY) { report.skipped.push(streamId); continue }
    try {
      const res = await fetch(
        `https://video.bunnycdn.com/library/${STREAM_LIBRARY}/videos/${streamId}`,
        { method: 'DELETE', headers: { AccessKey: STREAM_KEY } }
      )
      ;(gone(res.status) ? report.ok : report.failed).push(streamId)
    } catch { report.failed.push(streamId) }
  }

  return report
}

// DELETE ?id=<uuid>            → remove ONE video row
//        ?external_id=<local id> → the same row, found by the IDB key it was
//                                  mirrored from, for a client whose merge has
//                                  not run and so has no UUID to send. Without
//                                  it the client sent `v_1779…` as `id`, the
//                                  UUID comparison errored, and the 500 came
//                                  back through deleteVideosCloud as a silent
//                                  `{deleted: 0}` that looked like success.
//        ?date=YYYY-MM-DD        → every video row for that session day
//
// Why this exists: the client's DeleteButton removed the clip from IndexedDB and
// from Bunny Stream but never deleted the Supabase row, so every delete left an
// orphan that merged back in on the next load as a phantom cloud-only clip. A
// delete has to hit all three stores or the row resurrects.
//
// The Bunny objects go HERE, not in the caller. They used to be handed back for
// the caller to purge and no caller ever did, which left two things behind: paid
// storage for files nothing points at, and — the part that bites — objects that
// `backfill-from-bunny` turns back into rows. Purging needs the write key, which
// only the server has, so the caller could not have done it anyway.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const id = req.nextUrl.searchParams.get('id')
  const externalId = req.nextUrl.searchParams.get('external_id')
  const date = req.nextUrl.searchParams.get('date')
  if (!id && !externalId && !date) {
    return NextResponse.json({ error: 'id, external_id or date required' }, { status: 400 })
  }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 })
  }
  // A non-UUID `id` is the caller sending an IDB key where a row id belongs.
  // Postgres rejects it and the 500 used to reach the user as a tick. Say what
  // it should have sent instead.
  if (id && !UUID_RE.test(id)) {
    return NextResponse.json(
      { error: `id must be a UUID — pass a local IDB key as external_id instead (got ${id})` },
      { status: 400 }
    )
  }

  // Scope every delete to (team, boat) as well as the id/date, so a stray id from
  // another boat can never be removed. RLS gates this again server-side.
  let q = supabase
    .from('videos')
    .delete()
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)

  if (id) {
    q = q.eq('id', id)
  } else if (externalId) {
    // (boat_id, external_id) is uniquely indexed, and boat_id is already pinned
    // above, so this names exactly one row.
    q = q.eq('external_id', externalId)
  } else {
    const { data: session } = await supabase
      .from('sessions')
      .select('id')
      .eq('team_id', params.teamId)
      .eq('boat_id', params.boatId)
      .eq('date', date as string)
      .maybeSingle()
    if (!session) return NextResponse.json({ deleted: 0, videos: [], purged: emptyPurge() })
    q = q.eq('session_id', session.id)
  }

  const { data, error } = await q.select(PURGE_COLUMNS)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (data || []) as DeletedVideoRow[]
  const purged = await purgeBunny(rows)
  return NextResponse.json({ deleted: rows.length, videos: rows, purged })
}

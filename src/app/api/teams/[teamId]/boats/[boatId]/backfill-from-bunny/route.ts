// Server-side backfill from Bunny Storage. Lists every session date in
// the Bunny `sessions/<date>/` tree, downloads each session's meta.json
// and photos.json, and upserts the corresponding rows into Supabase
// (sessions / videos / photos) tagged with the (team, boat) the caller
// chose.
//
// Idempotent — dedupes videos by bunny_stream_id, photos by storage path.
//
// Caller must be admin or team_manager of the target team.
//
// POST /api/teams/[teamId]/boats/[boatId]/backfill-from-bunny

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../../lib/supabase/admin-guard'

const API_KEY = process.env.BUNNY_STORAGE_API_KEY!
const ZONE = process.env.BUNNY_STORAGE_ZONE!
const REGION = process.env.BUNNY_STORAGE_REGION || 'de'

function bunnyBase(): string {
  return REGION === 'de'
    ? 'https://storage.bunnycdn.com'
    : `https://${REGION}.storage.bunnycdn.com`
}

async function bunnyList(prefix: string): Promise<{
  ObjectName: string
  IsDirectory: boolean
}[]> {
  const res = await fetch(`${bunnyBase()}/${ZONE}/${prefix}`, {
    headers: { AccessKey: API_KEY },
  })
  if (!res.ok) return []
  return (await res.json()) as { ObjectName: string; IsDirectory: boolean }[]
}

async function bunnyJson<T>(key: string): Promise<T | null> {
  try {
    const res = await fetch(`${bunnyBase()}/${ZONE}/${key}`, {
      headers: { AccessKey: API_KEY },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

interface VideoMeta {
  id?: string
  title?: string
  name?: string
  startUtc?: number | string
  duration?: number
  tags?: string[]
  size?: number
  streamId?: string
}

interface PhotoMeta {
  id?: string
  utc?: number
  title?: string
  bunnyPath?: string
  url?: string
  thumbnailUrl?: string
  size?: number
  exif?: unknown
  analysis?: unknown
}

interface SessionMeta {
  videos?: VideoMeta[]
}

interface PhotoIndex {
  photos?: PhotoMeta[]
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  if (!API_KEY || !ZONE) {
    return NextResponse.json(
      { error: 'Bunny Storage not configured' },
      { status: 503 }
    )
  }

  const service = getServiceSupabase()

  // Step 1 — list session dates.
  const items = await bunnyList('sessions/')
  const dates = items
    .filter(
      (i) =>
        i.IsDirectory &&
        /^\d{4}-\d{2}-\d{2}$/.test(i.ObjectName) &&
        Number(i.ObjectName.slice(0, 4)) >= 2000 &&
        Number(i.ObjectName.slice(0, 4)) <= 2100
    )
    .map((i) => i.ObjectName)
    .sort()

  let sessions_seen = 0
  let videos_imported = 0
  let videos_skipped = 0
  let photos_imported = 0
  let photos_skipped = 0
  const log: string[] = []

  for (const date of dates) {
    sessions_seen++

    // Pull log + xml first so we can store them on the session row.
    const [logFile, xmlFile] = await Promise.all([
      bunnyJson<unknown>(`sessions/${date}/log.json`),
      bunnyJson<unknown>(`sessions/${date}/events.json`),
    ])

    // Ensure session row exists, including log + xml when present.
    const sessionRow: Record<string, unknown> = {
      team_id: params.teamId,
      boat_id: params.boatId,
      date,
      created_by_user_id: guard.userId,
    }
    if (logFile) sessionRow.log_data = logFile
    if (xmlFile) sessionRow.xml_data = xmlFile

    const { data: session, error: sErr } = await service
      .from('sessions')
      .upsert(sessionRow, { onConflict: 'boat_id,date', ignoreDuplicates: false })
      .select('id')
      .single()
    if (sErr || !session) {
      log.push(`✗ session ${date}: ${sErr?.message || 'upsert failed'}`)
      continue
    }

    // Step 2 — videos from sessions/<date>/meta.json.
    const meta = await bunnyJson<SessionMeta>(`sessions/${date}/meta.json`)
    if (meta?.videos?.length) {
      for (const v of meta.videos) {
        // Dedupe.
        let existingId: string | null = null
        if (v.streamId) {
          const { data } = await service
            .from('videos')
            .select('id')
            .eq('boat_id', params.boatId)
            .eq('bunny_stream_id', v.streamId)
            .maybeSingle()
          existingId = data?.id ?? null
        }

        // Resolve start time. Prefer meta.json's startUtc; fall back to
        // parsing the DJI / Android-style YYYYMMDDHHMMSS timestamp out of
        // the title or name (treated as the boat's local time, but storing
        // as UTC iso string is fine because the per-session tz_offset is
        // applied at render time).
        let startUtc: string | null = null
        if (typeof v.startUtc === 'number') {
          startUtc = new Date(v.startUtc).toISOString()
        } else if (typeof v.startUtc === 'string' && v.startUtc) {
          startUtc = v.startUtc
        } else {
          const candidate = (v.title || v.name || '') as string
          const re = /(\d{4})(\d{2})(\d{2})[_\-T ]?(\d{2})(\d{2})(\d{2})/
          const m = candidate.match(re)
          if (m) {
            const [, y, mo, d, h, mi, s] = m.map(Number)
            if (y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 && s <= 59) {
              startUtc = new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString()
            }
          }
        }
        const duration_ms =
          typeof v.duration === 'number' ? Math.round(v.duration * 1000) : null

        const row: Record<string, unknown> = {
          session_id: session.id,
          team_id: params.teamId,
          boat_id: params.boatId,
          title: v.title || v.name || null,
          start_utc: startUtc,
          duration_ms,
          tags: Array.isArray(v.tags) ? v.tags : [],
          bytes: v.size ?? null,
          bunny_stream_id: v.streamId || null,
          bunny_storage_path: `sessions/${date}/videos/${v.id || ''}/original`,
          created_by_user_id: guard.userId,
        }

        if (existingId) {
          const { error } = await service
            .from('videos')
            .update(row)
            .eq('id', existingId)
          if (error) {
            videos_skipped++
            log.push(`✗ video ${v.title || v.id}: ${error.message}`)
          } else {
            videos_imported++
          }
        } else {
          const { error } = await service.from('videos').insert(row)
          if (error) {
            videos_skipped++
            log.push(`✗ video ${v.title || v.id}: ${error.message}`)
          } else {
            videos_imported++
          }
        }
      }
    }

    // Step 3 — photos from sessions/<date>/photos.json (index) +
    // sessions/<date>/photos/<id>_meta.json (per-photo).
    const photoIndex = await bunnyJson<PhotoIndex>(
      `sessions/${date}/photos.json`
    )
    const photoList = photoIndex?.photos || []
    for (const p of photoList) {
      const storagePath = p.bunnyPath || p.url || null
      let existingId: string | null = null
      if (storagePath) {
        const { data } = await service
          .from('photos')
          .select('id')
          .eq('boat_id', params.boatId)
          .eq('bunny_storage_path', storagePath)
          .maybeSingle()
        existingId = data?.id ?? null
      }

      // Optional richer metadata file.
      const richer = p.id
        ? await bunnyJson<PhotoMeta>(
            `sessions/${date}/photos/${p.id}_meta.json`
          )
        : null
      const merged: PhotoMeta = { ...p, ...(richer || {}) }

      const row: Record<string, unknown> = {
        session_id: session.id,
        team_id: params.teamId,
        boat_id: params.boatId,
        taken_utc: merged.utc ? new Date(merged.utc).toISOString() : null,
        exif_data: merged.exif ?? null,
        thumbnail_url: merged.thumbnailUrl || null,
        bunny_storage_path: storagePath,
        bytes: merged.size ?? null,
        analysis_data: merged.analysis ?? null,
        created_by_user_id: guard.userId,
      }

      if (existingId) {
        const { error } = await service
          .from('photos')
          .update(row)
          .eq('id', existingId)
        if (error) {
          photos_skipped++
          log.push(`✗ photo ${p.id}: ${error.message}`)
        } else {
          photos_imported++
        }
      } else {
        const { error } = await service.from('photos').insert(row)
        if (error) {
          photos_skipped++
          log.push(`✗ photo ${p.id}: ${error.message}`)
        } else {
          photos_imported++
        }
      }
    }
  }

  // Audit
  await service.from('events').insert({
    user_id: guard.userId,
    action: 'backfill.from_bunny',
    details: {
      team_id: params.teamId,
      boat_id: params.boatId,
      sessions_seen,
      videos_imported,
      videos_skipped,
      photos_imported,
      photos_skipped,
    },
  })

  return NextResponse.json({
    sessions_seen,
    videos_imported,
    videos_skipped,
    photos_imported,
    photos_skipped,
    log: log.slice(0, 100),
  })
}

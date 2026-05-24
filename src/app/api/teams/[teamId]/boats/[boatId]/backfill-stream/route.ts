// Server-side backfill: give every existing proxy a genuine adaptive-bitrate
// HLS ladder by pushing it into Bunny Stream. Bunny FETCHES each proxy MP4
// directly from the Storage Zone — no bytes pass through this function and
// nothing is re-uploaded from the field.
//
// Per video that has bunny_proxy_path set but bunny_proxy_stream_id null:
//   1. POST /videos/fetch — Bunny pulls the proxy from the Storage Zone
//      (authenticated with the Storage AccessKey header). The Bunny video
//      title is set to the SSA video id so we can find it again — the fetch
//      endpoint only returns a status, not the new GUID.
//   2. List the library and map title -> GUID.
//   3. Record the GUID in videos.bunny_proxy_stream_id.
// Bunny encodes asynchronously; playback flips to adaptive HLS once ready.
//
// Idempotent — only touches videos that still lack a bunny_proxy_stream_id.
// Capped per run; the response reports how many remain so the caller can
// run it again.
//
// Caller must be admin or team_manager of the target team.
//
// POST /api/teams/[teamId]/boats/[boatId]/backfill-stream

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../../lib/supabase/admin-guard'

const STORAGE_KEY = process.env.BUNNY_STORAGE_API_KEY!
const ZONE = process.env.BUNNY_STORAGE_ZONE!
const REGION = process.env.BUNNY_STORAGE_REGION || 'de'
const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!

const MAX_PER_RUN = 15

function storageBase(): string {
  return REGION === 'de'
    ? 'https://storage.bunnycdn.com'
    : `https://${REGION}.storage.bunnycdn.com`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface VideoRow {
  id: string
  bunny_proxy_path: string
}

// Paginate the Stream library and map video title -> GUID, retrying a few
// times so freshly-fetched videos (registered asynchronously by Bunny) are
// picked up. `needed` is the set of titles we must resolve.
async function buildTitleMap(needed: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (let attempt = 0; attempt < 3; attempt++) {
    for (let page = 1; page <= 12; page++) {
      const res = await fetch(
        `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos?page=${page}&itemsPerPage=100&orderBy=date`,
        { headers: { AccessKey: STREAM_KEY }, cache: 'no-store' }
      )
      if (!res.ok) break
      const body = (await res.json()) as {
        items?: { guid?: string; title?: string }[]
      }
      const items = body.items || []
      for (const it of items) {
        if (it.title && it.guid && !map.has(it.title)) {
          map.set(it.title, it.guid)
        }
      }
      if (items.length < 100) break
      if (needed.every((id) => map.has(id))) break
    }
    if (needed.every((id) => map.has(id))) break
    await sleep(3000)
  }
  return map
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  if (!STORAGE_KEY || !ZONE || !STREAM_KEY || !LIBRARY_ID) {
    return NextResponse.json(
      { error: 'Bunny Storage / Stream not fully configured' },
      { status: 503 }
    )
  }

  const service = getServiceSupabase()

  // Videos that have a Storage-Zone proxy but no Stream proxy yet.
  const { data: rows, error } = await service
    .from('videos')
    .select('id, bunny_proxy_path')
    .eq('boat_id', params.boatId)
    .not('bunny_proxy_path', 'is', null)
    .is('bunny_proxy_stream_id', null)
    .limit(MAX_PER_RUN)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const videos = (rows || []) as VideoRow[]
  const fetched: string[] = [] // SSA video ids successfully handed to Bunny
  let failed = 0
  const log: string[] = []

  // 1. Ask Bunny to fetch each proxy. Sequential — Bunny rate-limits the
  //    fetch-job queue (HTTP 429).
  for (const v of videos) {
    const sourceUrl = `${storageBase()}/${ZONE}/${v.bunny_proxy_path}`
    try {
      const res = await fetch(
        `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos/fetch`,
        {
          method: 'POST',
          headers: { AccessKey: STREAM_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: sourceUrl,
            title: v.id,
            headers: { AccessKey: STORAGE_KEY },
          }),
        }
      )
      if (res.status === 429) {
        log.push('⏳ Bunny rate-limited the fetch queue — re-run for the rest')
        break
      }
      if (!res.ok) {
        failed++
        log.push(`✗ ${v.id}: fetch HTTP ${res.status}`)
        continue
      }
      fetched.push(v.id)
    } catch (e) {
      failed++
      log.push(`✗ ${v.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 2. Resolve each fetched video's GUID and record it.
  let queued = 0
  if (fetched.length) {
    await sleep(2000)
    const titleToGuid = await buildTitleMap(fetched)
    for (const id of fetched) {
      const guid = titleToGuid.get(id)
      if (!guid) {
        failed++
        log.push(`✗ ${id}: fetched but GUID not yet listable — re-run`)
        continue
      }
      const { error: upErr } = await service
        .from('videos')
        .update({ bunny_proxy_stream_id: guid, proxy_stream_status: null })
        .eq('id', id)
      if (upErr) {
        failed++
        log.push(`✗ ${id}: ${upErr.message}`)
      } else {
        queued++
      }
    }
  }

  // How many still need backfilling after this run.
  const { count: remaining } = await service
    .from('videos')
    .select('id', { count: 'exact', head: true })
    .eq('boat_id', params.boatId)
    .not('bunny_proxy_path', 'is', null)
    .is('bunny_proxy_stream_id', null)

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'backfill.proxy_to_stream',
    details: {
      team_id: params.teamId,
      boat_id: params.boatId,
      queued,
      failed,
      remaining: remaining ?? 0,
    },
  })

  return NextResponse.json({
    queued,
    failed,
    remaining: remaining ?? 0,
    log: log.slice(0, 100),
  })
}

// POST /api/stream/webhook — Bunny Stream tells us when a clip's encode changes.
//
// Until now "is it ready?" was answered by polling: the uploading browser every
// 20–60 s, and /api/videos/:id/url on every open. With this, the row learns the
// moment Bunny knows — every phone's list query shows the truth, and /url takes
// its no-Bunny-call fast path. Polling stays as the fallback.
//
// Setup (Bunny dashboard → Stream → library → API / Webhooks):
//   URL:    https://<app>/api/stream/webhook
//   Secret: set BUNNY_STREAM_WEBHOOK_SECRET in Vercel to the library's
//           READ-ONLY API key (Bunny signs with it; lib/bunnyWebhook.ts).
//
// On "playable" it also warms Bunny's CDN for the two lightest rungs, so the
// first viewer does not pay the cold-cache fetch.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../lib/supabase/server'
import { verifyBunnySignature, cachedStatusFor, lowestVariants } from '../../../../lib/bunnyWebhook'

const SECRET = process.env.BUNNY_STREAM_WEBHOOK_SECRET || ''
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID || ''
const CDN_HOST = process.env.BUNNY_CDN_HOSTNAME || ''
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const COLUMNS = [
  ['bunny_original_stream_id', 'original_stream_status'],
  ['bunny_proxy_stream_id', 'proxy_stream_status'],
] as const

async function warm(guid: string, origin: string): Promise<void> {
  const base = `https://${CDN_HOST}/${guid}`
  const get = (url: string) => fetch(url, { headers: { Referer: `${origin}/` }, cache: 'no-store', signal: AbortSignal.timeout(3000) })
  const master = await get(`${base}/playlist.m3u8`)
  if (!master.ok) return
  for (const uri of lowestVariants(await master.text())) {
    const res = await get(`${base}/${uri}`)
    if (!res.ok) continue
    const first = (await res.text()).split(/\r?\n/).find((l) => l && !l.startsWith('#'))
    const dir = uri.includes('/') ? uri.slice(0, uri.lastIndexOf('/') + 1) : ''
    if (first) await (await get(/^https?:/.test(first) ? first : `${base}/${dir}${first}`)).arrayBuffer()
  }
}

export async function POST(req: NextRequest) {
  if (!SECRET) return NextResponse.json({ error: 'webhook secret not configured' }, { status: 503 })

  const raw = await req.text()   // the RAW body: the signature is over these exact bytes
  if (!verifyBunnySignature(raw, req.headers.get('x-bunnystream-signature'), SECRET)) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 })
  }
  let body: { VideoLibraryId?: unknown; VideoGuid?: unknown; Status?: unknown }
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }

  const guid = String(body.VideoGuid || '')
  if (!GUID_RE.test(guid)) return NextResponse.json({ error: 'bad guid' }, { status: 400 })
  if (LIBRARY_ID && String(body.VideoLibraryId) !== LIBRARY_ID) return NextResponse.json({ ignored: 'other library' })
  const status = cachedStatusFor(Number(body.Status))
  if (status == null) return NextResponse.json({ ignored: 'not a playback event' })

  const sb = getServiceSupabase()
  for (const [idCol, stCol] of COLUMNS) {
    let q = sb.from('videos').update({ [stCol]: status }).eq(idCol, guid)
    // Webhooks can arrive out of order: never let an "encoding" event turn a
    // clip that is already playable back into "encoding".
    if (status !== 4 && status !== 5) q = q.or(`${stCol}.is.null,${stCol}.neq.4`)
    const { error } = await q
    if (error) console.warn('[stream/webhook] update failed:', idCol, error.message)
  }

  if (status === 4 && CDN_HOST) {
    // A poster for cards that never got one.
    await sb.from('videos').update({ thumbnail_url: `https://${CDN_HOST}/${guid}/thumbnail.jpg` })
      .eq('bunny_original_stream_id', guid).is('thumbnail_url', null)
    // Bounded: answer Bunny within a few seconds whatever the CDN does.
    await Promise.race([warm(guid, req.nextUrl.origin).catch(() => {}), new Promise((r) => setTimeout(r, 4000))])
  }
  return NextResponse.json({ ok: true, status })
}

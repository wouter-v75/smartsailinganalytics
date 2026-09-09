// POST /api/stream/fetch
//
// Hands Bunny Stream a URL and lets IT pull the bytes, instead of the browser
// uploading them a second time.
//
// WHY THIS EXISTS. A clip used to go straight to Bunny Stream over TUS, and was
// then unwatchable until Stream finished transcoding — on this library, 60 to
// 120 minutes after the upload landed. The fix is to put the clip in Bunny
// Storage first, where the URL route can serve it immediately as a progressive
// MP4, and have Stream build the adaptive ladder afterwards.
//
// Done naively that means sending every byte twice, once to Storage and once to
// Stream, which would roughly double a 20-minute upload from the boat. It does
// not have to: Bunny will fetch from a URL server-side, so the second hop is
// Bunny reading its own CDN over its own network. Nothing extra leaves our
// uplink, and it does not compete with the next clip's upload.
//
// The URL we hand over is token-signed and short-lived by CDN standards but long
// by queue standards — a fetch can sit in Bunny's queue for a while, and a URL
// that expires before the fetch runs fails silently, leaving a video stuck at
// status 0 with no bytes. Hence the deliberately generous TTL below.
//
// Reference: POST /library/{libraryId}/videos/fetch, body { url, title, headers? }
// (bunny.net/docs/reference/video_fetchnewvideo, checked 2026-09-09).

import { NextRequest, NextResponse } from 'next/server'
import { signBunnyUrl, bunnyConfigured } from '../../../../lib/bunny-signed-url'

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!

// Long enough to outlive a slow transcode queue. The URL only grants read access
// to one object we are deliberately handing to Bunny, so a long life is cheap.
const FETCH_URL_TTL_SEC = 24 * 3600

interface Body {
  /** Path inside the storage zone, e.g. sessions/2026-09-08/originals/<id>.mp4 */
  path?: string
  /** Title to give the Stream video. Also how we find its guid afterwards. */
  title?: string
}

export async function POST(req: NextRequest) {
  if (!STREAM_KEY || !LIBRARY_ID) {
    return NextResponse.json({ error: 'Bunny Stream not configured' }, { status: 503 })
  }
  if (!bunnyConfigured()) {
    return NextResponse.json(
      { error: 'Bunny token auth not configured — cannot sign a fetch URL' },
      { status: 503 }
    )
  }

  const body = (await req.json().catch(() => null)) as Body | null
  const path = body?.path
  const title = body?.title
  if (!path || typeof path !== 'string') {
    return NextResponse.json({ error: 'path required' }, { status: 400 })
  }
  if (!title || typeof title !== 'string') {
    // The title is not decoration: Bunny's fetch response does not reliably
    // carry the new video's guid, so the title is how we find it again.
    return NextResponse.json({ error: 'title required' }, { status: 400 })
  }

  const signed = signBunnyUrl({ path, ttlSec: FETCH_URL_TTL_SEC })
  if (!signed) {
    return NextResponse.json({ error: 'could not sign the storage URL' }, { status: 500 })
  }

  try {
    const res = await fetch(
      `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos/fetch`,
      {
        method: 'POST',
        headers: { AccessKey: STREAM_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: signed.url, title }),
      }
    )
    const text = await res.text()
    if (!res.ok) {
      return NextResponse.json(
        { error: `Bunny fetch HTTP ${res.status}`, detail: text.slice(0, 300) },
        { status: 502 }
      )
    }

    // Bunny documents this as returning a StatusModel, but has been observed to
    // return the video object on some endpoints. Take a guid if we are given one
    // and only go looking when we are not — a lookup is a second round trip and
    // can race a library that has several clips with similar names.
    let parsed: Record<string, unknown> | null = null
    try { parsed = JSON.parse(text) } catch { parsed = null }
    const direct =
      (typeof parsed?.guid === 'string' && parsed.guid) ||
      (typeof parsed?.id === 'string' && parsed.id) ||
      null

    const streamId = direct || (await findByTitle(title))
    if (!streamId) {
      // The fetch was accepted, so the clip is not lost — we simply could not
      // name it. Say so plainly rather than returning ok with a null id, which
      // would silently leave the row without a stream to upgrade to.
      return NextResponse.json(
        { error: 'Bunny accepted the fetch but the video guid could not be resolved', title },
        { status: 502 }
      )
    }
    return NextResponse.json({ streamId, title, fetchedFrom: path })
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}

// Newest video whose title matches exactly. Our clip titles carry a timestamp
// and event tags, so they are unique per card; an exact match avoids picking up
// a re-upload of a neighbouring clip.
async function findByTitle(title: string): Promise<string | null> {
  const url =
    `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos` +
    `?page=1&itemsPerPage=100&orderBy=date&search=${encodeURIComponent(title)}`
  const res = await fetch(url, { headers: { AccessKey: STREAM_KEY } })
  if (!res.ok) return null
  const j = (await res.json()) as { items?: Array<{ guid?: string; title?: string }> }
  const hit = (j.items || []).find((v) => v.title === title)
  return hit?.guid || null
}

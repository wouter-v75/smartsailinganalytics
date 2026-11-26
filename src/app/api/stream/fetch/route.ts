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
// WHAT WE HAND OVER, and why it changed. This used to pass a token-signed
// pull-zone URL with a 24 h TTL. It worked, and it was outside what the API
// specifies: Bunny documents the fetch endpoint as taking "signed URLs,
// expiring tokens, or time-limited access links are not supported". The whole
// 720p path rested on that.
//
// The documented route to the same place is the `headers` field, which is for
// static auth. So we give Bunny the object's STORAGE API url and the zone's
// READ-ONLY access key, and it authenticates the way the API says to. Three
// things get better as a side effect:
//
//   - no expiry, so a fetch that sits in Bunny's queue for hours can no longer
//     be stranded by a dead link — which left videos at status 0 with no bytes
//     and nothing to say why;
//   - no dependency on the pull zone or on token auth being configured, so the
//     adaptive encode cannot be blocked by CDN-side settings;
//   - the key is read-only and server-side. It never reaches the browser, and
//     it travels from us to Bunny over TLS to be used against Bunny's own
//     storage.
//
// Reference: POST /library/{libraryId}/videos/fetch, body { url, title, headers? }
// (bunny.net/docs/reference/video_fetchnewvideo, re-read 2026-11-26).

import { NextRequest, NextResponse } from 'next/server'
import { storageObjectUrl } from '../../../../lib/bunnyStorageHost'
import { requireActiveUser } from '@/lib/supabase/admin-guard'

const STREAM_KEY = process.env.BUNNY_STREAM_API_KEY!
const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID!
// READ-ONLY by design (see .env.example): this key is handed to Bunny's fetcher,
// and fetching needs reading and nothing else. BUNNY_STORAGE_WRITE_KEY is the
// zone password and must never be sent here.
const STORAGE_READ_KEY = process.env.BUNNY_STORAGE_API_KEY
const STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE

interface Body {
  /** Path inside the storage zone, e.g. sessions/2026-09-08/originals/<id>.mp4 */
  path?: string
  /** Title to give the Stream video. Also how we find its guid afterwards. */
  title?: string
}

export async function POST(req: NextRequest) {
  const gate = await requireActiveUser()
  if (!gate.ok) return gate.response

  if (!STREAM_KEY || !LIBRARY_ID) {
    return NextResponse.json({ error: 'Bunny Stream not configured' }, { status: 503 })
  }
  if (!STORAGE_READ_KEY || !STORAGE_ZONE) {
    return NextResponse.json(
      { error: 'Bunny Storage read key/zone not configured — cannot authorise a fetch' },
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

  const sourceUrl = storageObjectUrl(STORAGE_ZONE, path)

  try {
    const res = await fetch(
      `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos/fetch`,
      {
        method: 'POST',
        headers: { AccessKey: STREAM_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: sourceUrl,
          title,
          // Static auth, which is what `headers` is documented for.
          headers: { AccessKey: STORAGE_READ_KEY },
        }),
      }
    )
    const text = await res.text()
    // 429 is a QUEUE limit, not a failure. Bunny documents the fetch API as
    // supporting "a limited number of queued fetch requests per user at a
    // time", varying "by region, time, current load", and returns 429 when it
    // is reached. The bytes are already in Storage and the clip is already
    // playable from there, so the only thing missing is the adaptive encode —
    // which is worth asking for again later, not reporting as a lost upload.
    //
    // This matters more since the watch folder started sending a proxy for
    // every clip: a day of racing is ~150 fetches in a row, where it used to be
    // whatever somebody pressed a button for.
    if (res.status === 429) {
      return NextResponse.json(
        { error: 'Bunny fetch queue is full', retryable: true, detail: text.slice(0, 300) },
        { status: 429 }
      )
    }
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

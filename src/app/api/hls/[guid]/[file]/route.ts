// GET /api/hls/:guid/master.m3u8?e=<exp>&s=<sig>
//
// Bunny Stream's playlist for one clip, reordered so a light rung comes first —
// for iPhones, whose native player starts on the first rung listed and would
// otherwise begin every clip at 720p. See src/lib/hlsMaster.ts.
//
// Authorisation is the signed link itself (minted by /api/videos/:id/url for a
// user who may read the clip), not a cookie: AVPlayer's own requests are not
// guaranteed to carry the page's session.
//
// If Bunny cannot be reached quickly, redirect to its own playlist: playback
// then starts at 720p as before — never worse than without this route.

import { NextRequest, NextResponse } from 'next/server'
import { reorderMaster, verifyMaster, masterSecret } from '../../../../../lib/hlsMaster'

const CDN_HOST = process.env.BUNNY_CDN_HOSTNAME || ''
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  req: NextRequest,
  { params }: { params: { guid: string; file: string } }
) {
  const { guid, file } = params
  if (file !== 'master.m3u8' || !GUID_RE.test(guid)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const secret = masterSecret()
  if (!secret || !CDN_HOST) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }
  const exp = Number(req.nextUrl.searchParams.get('e'))
  const sig = req.nextUrl.searchParams.get('s') || ''
  if (!verifyMaster(guid, exp, sig, secret)) {
    return NextResponse.json({ error: 'link expired or invalid' }, { status: 403 })
  }

  const base = `https://${CDN_HOST}/${guid}`
  const upstream = `${base}/playlist.m3u8`
  try {
    // The Stream zone refuses requests without a Referer (measured: 403), so
    // send the app's own origin, as the browser would.
    const res = await fetch(upstream, {
      headers: { Referer: `${req.nextUrl.origin}/` },
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) throw new Error(`Bunny ${res.status}`)
    const body = reorderMaster(await res.text(), base)
    return new NextResponse(body, {
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        // A clip's ladder does not change once encoded; the link is private.
        'Cache-Control': 'private, max-age=300',
      },
    })
  } catch {
    return NextResponse.redirect(upstream, 302)
  }
}

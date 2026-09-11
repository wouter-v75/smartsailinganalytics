// Bunny Stream webhook helpers (docs: bunny.net/docs/stream-webhook, read
// 11 Sept 2026).
//
// Signature: HMAC-SHA256 of the exact raw request body, keyed with the
// library's READ-ONLY API key, lowercase hex, in X-BunnyStream-Signature.
//
// Status codes in the WEBHOOK differ from the API's: here 3 = Finished and
// 4 = "Resolution finished — video now playable"; in the API 4 = Finished. The
// columns we cache (original_stream_status / proxy_stream_status) use the API
// numbering — the /url route and the list query read 4 as "playable" — so map.

import crypto from 'crypto'

export function verifyBunnySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false
  const want = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const got = signature.trim().toLowerCase()
  if (got.length !== want.length) return false
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))
}

/** Webhook status → the API-numbered value cached on the row; null = ignore. */
export function cachedStatusFor(webhookStatus: number): number | null {
  switch (webhookStatus) {
    case 3: // Finished
    case 4: // Resolution finished — already playable
      return 4
    case 5: // Failed
      return 5
    case 0: // Queued
      return 2
    case 1: // Processing
    case 2: // Encoding
      return 3
    default: // presigned uploads, captions, titles — nothing to do with playback
      return null
  }
}

/** The lowest-bitrate rungs of a multivariant playlist (relative URIs as given). */
export function lowestVariants(master: string, n = 2): string[] {
  const lines = master.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const out: { uri: string; bps: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue
    const m = lines[i].match(/[:,](?:AVERAGE-)?BANDWIDTH=(\d+)/)
    const uri = lines[i + 1]
    if (uri && !uri.startsWith('#')) out.push({ uri, bps: m ? Number(m[1]) : Number.MAX_SAFE_INTEGER })
  }
  return out.sort((a, b) => a.bps - b.bps).slice(0, n).map((v) => v.uri)
}

// iPhone start quality.
//
// Native HLS on iOS (AVPlayer) starts with the FIRST variant listed in the
// multivariant playlist, and Bunny Stream lists its highest rung first. So on an
// iPhone every clip began at 720p / ~4 Mbps — the slowest possible start on
// marina wifi or 4G. hls.js (Android, desktop) sorts by bitrate and starts at
// the lowest rung by itself, so this is an iPhone-only problem.
//
// Fix: serve iPhones a copy of Bunny's playlist with a light rung first. Same
// rungs, same Bunny segment URLs (made absolute), only the order changes; AVPlayer
// then adapts up as the connection allows.
//
// The copy is fetched with a short-lived signed link rather than a login cookie:
// whether AVPlayer's own requests carry the page's cookies is not something to
// bet playback on.

import crypto from 'crypto'

/** Start on the best rung at or under this — 360p on Bunny's 720p ladder. */
export const START_TARGET_BPS = 1_500_000

interface Variant { tag: string; uri: string; bps: number }

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`[:,]${name}=([^,]+)`))
  return m ? m[1] : null
}

/**
 * Rewrite a playlist so it can be served from another origin, with a light
 * start rung first. `base` is the directory the playlist came from, e.g.
 * `https://vz-xxx.b-cdn.net/<guid>`.
 */
export function reorderMaster(text: string, base: string, targetBps = START_TARGET_BPS): string {
  const root = base.replace(/\/$/, '')
  const abs = (u: string) => (/^https?:\/\//i.test(u) ? u : `${root}/${u.replace(/^\//, '')}`)
  const absAttr = (l: string) => l.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${abs(u)}"`)
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

  // Not a multivariant playlist (a single-rung media playlist): nothing to
  // reorder, but its relative URIs must still point at Bunny, not at us.
  if (!lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    return lines.map((l) => (l.startsWith('#') ? absAttr(l) : abs(l))).join('\n') + '\n'
  }

  const head: string[] = []
  const variants: Variant[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('#EXT-X-STREAM-INF')) {
      let j = i + 1
      while (j < lines.length && lines[j].startsWith('#')) j++
      if (j >= lines.length) break
      const bps = Number(attr(l, 'AVERAGE-BANDWIDTH') ?? attr(l, 'BANDWIDTH') ?? 0)
      variants.push({ tag: l, uri: abs(lines[j]), bps })
      i = j
    } else if (l.startsWith('#')) {
      head.push(absAttr(l))
    }
  }
  if (!variants.length) return text

  const fitting = variants.filter((v) => v.bps > 0 && v.bps <= targetBps)
  const start = fitting.length
    ? fitting.reduce((a, b) => (b.bps > a.bps ? b : a))
    : variants.reduce((a, b) => (b.bps < a.bps ? b : a))
  const ordered = [start, ...variants.filter((v) => v !== start)]
  return [...head, ...ordered.flatMap((v) => [v.tag, v.uri])].join('\n') + '\n'
}

// ── Signed link ──────────────────────────────────────────────────────────────
// A key of its own, derived from the Storage token key rather than reusing it.
export function masterSecret(): string | null {
  const k = process.env.BUNNY_TOKEN_AUTH_KEY
  return k ? crypto.createHmac('sha256', k).update('ssa-hls-master-v1').digest('hex') : null
}

export function signMaster(guid: string, expSec: number, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`${guid}.${expSec}`).digest('base64url')
}

export function verifyMaster(
  guid: string, expSec: number, sig: string, secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!Number.isFinite(expSec) || expSec < nowSec || !sig) return false
  const want = Buffer.from(signMaster(guid, expSec, secret))
  const got = Buffer.from(sig)
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}

/** Same-origin path the iPhone player loads instead of Bunny's playlist. */
export function masterPath(
  guid: string, secret: string, ttlSec = 12 * 3600,
  nowSec = Math.floor(Date.now() / 1000),
): { path: string; expires: number } {
  const e = nowSec + ttlSec
  return { path: `/api/hls/${guid}/master.m3u8?e=${e}&s=${signMaster(guid, e, secret)}`, expires: e }
}

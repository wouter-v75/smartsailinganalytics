// src/lib/droneProxy.ts
// ─────────────────────────────────────────────────────────────────────────────
// The card's own proxies, and which file holds a given second.
//
// DJI writes a 720p H.264 proxy beside every clip — `DJI_….LRF`, about 7–8
// Mbit/s against the original's ~250 — made by the camera at record time because
// the controller uses it for playback. Roughly a thirtieth of the bytes, already
// on the SSD, and every script here has ignored them: the cutter scans
// `.mp4/.mov/.m4v` and nothing else.
//
// That is what makes reviewing a day cheap. The expensive part of a proxy
// workflow is MAKING the proxies; this one is a rename away. Review plays the
// LRF, the cutter still cuts the 4K original, and nothing is copied or uploaded
// to look at it — the same bargain Njord's player strikes by storing a path
// rather than a file.
//
// CLOCKS. A DJI filename stamp is VENUE-LOCAL wall time, like everything else
// the card writes, and the SRT sidecars agree with it to about a second. So the
// local stamp is parsed here and the conversion to true UTC takes an explicit
// offset — never a guess. Read a filename as UTC and every clip lands an offset
// away from the track it is being reviewed against.
//
// Pure: no I/O, no React, no handles. The caller does the reading.
// ─────────────────────────────────────────────────────────────────────────────

const VIDEO_EXT = /\.(mp4|mov|m4v)$/i
const PROXY_EXT = /\.lrf$/i

/** `DJI_20260930141950_0001_D.MP4` → `DJI_20260930141950_0001_D`. */
export function stemOf(name: string): string {
  return String(name || '').replace(/\.[^.]+$/, '')
}

export const isVideoName = (n: string): boolean => VIDEO_EXT.test(String(n || ''))
export const isProxyName = (n: string): boolean => PROXY_EXT.test(String(n || ''))

/**
 * The instant in a DJI filename, as the card wrote it: venue-local wall time.
 *
 * `DJI_20260930141950_0001_D.MP4` → 2026-09-30 14:19:50 local. Returned as an
 * epoch value in that local frame — add nothing to it and it is NOT UTC. Pass it
 * through `toUtc` with the venue offset to get a real instant.
 */
export function parseDjiStamp(name: string): number | null {
  const m = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(name || ''))
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
  return Number.isFinite(ms) ? ms : null
}

/** Local wall clock → true UTC. The one place the offset is applied. */
export const toUtc = (localMs: number, tzOffsetMin: number): number =>
  localMs - tzOffsetMin * 60_000

export interface FootageFile {
  /** `DJI_20260930141950_0001_D` — what the original and the proxy share. */
  stem: string
  /** The 4K original, which is what the cutter will cut. */
  videoName: string
  /** The camera's 720p proxy, when the card has one. */
  proxyName: string | null
  /** True UTC, from the filename. */
  startUtc: number
  /** Filled in by the caller once the browser has read the file's metadata;
   *  a filename says when a clip started, never how long it ran. */
  durationSec?: number
}

/**
 * Pair every clip on the card with its proxy.
 *
 * Ordered by time, which is not the same as by name once a card holds more than
 * one flight: `_0001` restarts. A file with no readable stamp is dropped rather
 * than guessed at — it would land on the wrong second of the track, which is
 * worse than not appearing.
 */
export function pairFootage(names: readonly string[], tzOffsetMin: number): FootageFile[] {
  const proxies = new Map<string, string>()
  for (const n of names) if (isProxyName(n)) proxies.set(stemOf(n).toLowerCase(), n)

  const out: FootageFile[] = []
  for (const n of names) {
    if (!isVideoName(n)) continue
    const local = parseDjiStamp(n)
    if (local == null) continue
    const stem = stemOf(n)
    out.push({
      stem,
      videoName: n,
      proxyName: proxies.get(stem.toLowerCase()) ?? null,
      startUtc: toUtc(local, tzOffsetMin),
    })
  }
  return out.sort((a, b) => a.startUtc - b.startUtc)
}

/** What to play: the proxy if the card has one, else the original. */
export const playableName = (f: FootageFile): string => f.proxyName || f.videoName

export interface FootageHit {
  file: FootageFile
  /** Seconds into that file. */
  offsetSec: number
}

/**
 * Which file holds this instant, and how far into it.
 *
 * Needs durations, so it only answers once the caller has measured them. A clip
 * with no duration yet is treated as covering nothing rather than as covering
 * everything — an unmeasured file must not swallow a seek meant for the next
 * one.
 *
 * `slackSec` lets a press land just before a file starts and still open it,
 * which is what a person means when they click the very start of a green band.
 */
export function fileAt(
  files: readonly FootageFile[],
  utc: number,
  slackSec = 2
): FootageHit | null {
  for (const f of files) {
    if (!f.durationSec) continue
    const end = f.startUtc + f.durationSec * 1000
    if (utc >= f.startUtc - slackSec * 1000 && utc < end) {
      return { file: f, offsetSec: Math.max(0, (utc - f.startUtc) / 1000) }
    }
  }
  return null
}

/** The first file at or after this instant — for "play from here" when the
 *  press landed in a gap, which on a day with the drone on the deck is most of
 *  the track. */
export function nextFileFrom(files: readonly FootageFile[], utc: number): FootageFile | null {
  return files.find((f) => f.startUtc >= utc) ?? null
}

/** How many of the card's clips have a camera proxy. Shown in the UI because
 *  "review is slow today" has exactly one likely cause, and this is it. */
export function proxyCount(files: readonly FootageFile[]): number {
  return files.filter((f) => f.proxyName).length
}

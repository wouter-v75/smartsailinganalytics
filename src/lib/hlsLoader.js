// hls.js, bundled with the app instead of fetched from cdnjs at play time.
//
// The old path put a DNS lookup, a TLS handshake and a ~400 KB download from a
// third-party CDN in front of every first play on Android, and pinned hls.js at
// 1.4.14. Since then hls.js waits out an offline phone instead of burning its
// retries (1.6.11, navigator.onLine), detects stalls better (1.6) and bounds
// buffer appends that never finish (1.7). The light build drops subtitles,
// alternate audio, DRM, CMCD and interstitials — none of which our Bunny Stream
// clips use.
//
// iPhones never get here: they play HLS natively (see the player). Since 1.5,
// Hls.isSupported() is TRUE on iOS 17.1+ (ManagedMediaSource), so the player's
// native check must come first — it does.
//
// Plain JS on purpose: the `hls.js/light` entry ships no type declarations.

let mod = null

export function loadHls() {
  if (!mod) {
    mod = import('hls.js/light')
      .then((m) => m.default)
      .catch((e) => { mod = null; throw e })
  }
  return mod
}

/** Warm the chunk ahead of time, so the first play does not wait for it. */
export function prefetchHls() {
  loadHls().catch(() => { /* retried on play */ })
}

const retry = (timeouts, errors, maxLoadTimeMs) => ({
  default: {
    maxTimeToFirstByteMs: 10_000,
    maxLoadTimeMs,
    timeoutRetry: { maxNumRetry: timeouts, retryDelayMs: 0, maxRetryDelayMs: 0 },
    errorRetry: { maxNumRetry: errors, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
  },
})

export const HLS_CONFIG = {
  // Weak field wifi: start on the lowest rung and adapt up; never above the
  // size actually on screen.
  startLevel: 0,
  capLevelToPlayerSize: true,
  // Clips are 1–3 min: buffer the whole clip, so a wifi dropout does not stall
  // it once it has loaded…
  maxBufferLength: 180,
  maxMaxBufferLength: 600,
  // …but bound memory on phones (a 3-min 720p clip is ~45 MB; the old 200 MB
  // cap never applied) and let go of what has been watched.
  maxBufferSize: 60 * 1000 * 1000,
  backBufferLength: 60,
  // The playlist got ONE retry by default; a marina wifi blip should not end
  // playback before it starts.
  manifestLoadPolicy: retry(2, 3, 20_000),
  playlistLoadPolicy: retry(2, 3, 20_000),
  // A stuck segment download gives up (and ABR steps down) after 40 s, not 120.
  fragLoadPolicy: retry(4, 6, 40_000),
}

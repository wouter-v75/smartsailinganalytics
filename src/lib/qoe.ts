// Playback quality (QoE), measured the way Mux Data defines it:
//   startup (TTFF) — from asking to play to the first frame on screen
//   rebuffering    — stalls after the first frame (seeks excluded): count + time
//   outcome        — played / failed / exited before the first frame
// One summary per clip viewed, sent with sendBeacon to /api/qoe and stored in
// public.playback_events (EU). scripts/qoe-report.mjs turns it into numbers per
// platform — replacing "videos are often not available" with a failure rate.

export type Outcome = 'played' | 'failed' | 'exited_before_start'

export interface QoePayload {
  clip: string
  guid: string | null
  served: string | null
  outcome: Outcome
  ttff_ms: number | null
  watch_ms: number
  rebuffer_count: number
  rebuffer_ms: number
  engine: string | null
  start_light: boolean
  first_height: number | null
  max_height: number | null
  platform: string
  net: string | null
  error: string | null
  autoplay: boolean
}

export function platformOf(ua: string, maxTouchPoints = 0): string {
  if (/iPhone|iPod/.test(ua)) return 'iphone'
  // iPadOS reports itself as a Mac; touch gives it away.
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'ipad'
  if (/Android/.test(ua)) return 'android'
  return 'desktop'
}

interface Meta { clip: string; autoplay?: boolean; platform?: string; net?: string | null }

export function createQoe(meta: Meta, now: () => number = () => Date.now()) {
  const openedAt = now()
  let tapAt: number | null = meta.autoplay ? openedAt : null
  let firstFrameAt: number | null = null
  let playingSince: number | null = null
  let waitingSince: number | null = null
  let seeking = false
  let watchMs = 0
  let rebufferCount = 0
  let rebufferMs = 0
  let error: string | null = null
  let engine: string | null = null
  let startLight = false
  let firstHeight: number | null = null
  let maxHeight: number | null = null
  let sent = false

  const stopPlaying = (t: number) => {
    if (playingSince != null) { watchMs += t - playingSince; playingSince = null }
  }
  const endWaiting = (t: number) => {
    if (waitingSince != null) { rebufferMs += t - waitingSince; waitingSince = null }
  }

  return {
    /** The viewer asked to play (a tap, or autoplay). */
    tap() { if (tapAt == null) tapAt = now() },
    setEngine(e: string, light = false) { engine = e; startLight = light },
    height(h: number) {
      if (!h) return
      if (firstHeight == null) firstHeight = h
      maxHeight = Math.max(maxHeight ?? 0, h)
    },
    playing() {
      const t = now()
      if (firstFrameAt == null) { firstFrameAt = t; if (tapAt == null) tapAt = openedAt }
      endWaiting(t)
      playingSince = t
    },
    waiting() {
      const t = now()
      stopPlaying(t)
      // Before the first frame this is startup, already counted in TTFF; during a
      // seek it is the viewer's own doing. Neither is rebuffering.
      if (firstFrameAt != null && !seeking && waitingSince == null) { rebufferCount++; waitingSince = t }
    },
    pause() { const t = now(); stopPlaying(t); endWaiting(t) },
    seeking(on: boolean) { seeking = on; if (on) endWaiting(now()) },
    fail(reason: string) { if (!error) error = String(reason || 'unknown').slice(0, 200) },

    /** The summary, once. Null when the viewer never tried to play and nothing failed. */
    take(extra: { served?: string | null; guid?: string | null } = {}): QoePayload | null {
      if (sent) return null
      if (tapAt == null && !error) return null
      sent = true
      const t = now()
      stopPlaying(t); endWaiting(t)
      const outcome: Outcome = error ? 'failed' : firstFrameAt != null ? 'played' : 'exited_before_start'
      return {
        clip: meta.clip,
        guid: extra.guid ?? null,
        served: extra.served ?? null,
        outcome,
        ttff_ms: firstFrameAt != null && tapAt != null ? Math.max(0, firstFrameAt - tapAt) : null,
        watch_ms: watchMs,
        rebuffer_count: rebufferCount,
        rebuffer_ms: rebufferMs,
        engine,
        start_light: startLight,
        first_height: firstHeight,
        max_height: maxHeight,
        platform: meta.platform || 'unknown',
        net: meta.net ?? null,
        error,
        autoplay: !!meta.autoplay,
      }
    },
  }
}

/** Fire-and-forget. Telemetry must never get in the way of playback. */
export function sendQoe(p: QoePayload): void {
  try {
    const body = JSON.stringify(p)
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
        && navigator.sendBeacon('/api/qoe', new Blob([body], { type: 'application/json' }))) return
    fetch('/api/qoe', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => {})
  } catch { /* never break playback over telemetry */ }
}

const OUTCOMES: Outcome[] = ['played', 'failed', 'exited_before_start']
const MAX_MS = 3_600_000
const int = (v: unknown, max = MAX_MS): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : null
}
const str = (v: unknown, len: number): string | null =>
  typeof v === 'string' && v ? v.slice(0, len) : null

/** Server side: keep only known fields, bounded — a beacon is untrusted input. */
export function sanitizeQoe(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const outcome = OUTCOMES.includes(r.outcome as Outcome) ? (r.outcome as Outcome) : null
  const clip = str(r.clip, 80)
  if (!outcome || !clip) return null
  return {
    video_id: clip,
    stream_guid: str(r.guid, 40),
    served: str(r.served, 20),
    outcome,
    ttff_ms: int(r.ttff_ms),
    watch_ms: int(r.watch_ms) ?? 0,
    rebuffer_count: int(r.rebuffer_count, 10_000) ?? 0,
    rebuffer_ms: int(r.rebuffer_ms) ?? 0,
    engine: str(r.engine, 20),
    start_light: r.start_light === true,
    first_height: int(r.first_height, 10_000),
    max_height: int(r.max_height, 10_000),
    platform: str(r.platform, 20),
    net: str(r.net, 20),
    error: str(r.error, 200),
    autoplay: r.autoplay === true,
  }
}

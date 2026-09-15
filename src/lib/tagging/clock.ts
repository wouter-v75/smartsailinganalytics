// src/lib/tagging/clock.ts
// ─────────────────────────────────────────────────────────────────────────────
// The session's clock.
//
// Every time in the tagger is a UTC instant, and every time a crew member reads
// is the venue's wall clock — the one on the boat's instruments and in the race
// documents. The offset between them is a property of the SESSION, not of the
// phone: a trimmer who flew in yesterday and never changed their watch must see
// the same 13:04 as everyone else.
//
// So nothing here touches toLocaleTimeString, Intl, or the device timezone. An
// offset in minutes, applied to an instant, formatted as HH:MM:SS.
//
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const DAY_MS = 86_400_000

/** HH:MM:SS on the session's clock. */
export function sessionClock(utc: number, tzOffsetMin = 0): string {
  if (!isNum(utc)) return '--:--:--'
  return new Date(utc + tzOffsetMin * 60_000).toISOString().slice(11, 19)
}

/** HH:MM on the session's clock, for places that do not want seconds. */
export const sessionClockHm = (utc: number, tzOffsetMin = 0): string =>
  sessionClock(utc, tzOffsetMin).slice(0, 5)

/**
 * Read an HH:MM(:SS) the crew typed back into an instant.
 *
 * The typed value is a wall-clock time with no date, so it is resolved against
 * the DAY `anchorUtc` falls on — which is what someone correcting "13:04:10" to
 * "13:02" means. The one subtlety is a session that runs through local midnight:
 * resolving on the anchor's day would then throw the time 24 hours, so a result
 * more than half a day from the anchor is pulled to the nearer side.
 *
 * Returns null for anything that is not a time, so a half-typed field leaves the
 * tag where it was rather than moving it to 00:00.
 */
export function parseSessionClock(
  text: string,
  anchorUtc: number,
  tzOffsetMin = 0
): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(String(text ?? ''))
  if (!m || !isNum(anchorUtc)) return null
  const h = Number(m[1]), min = Number(m[2]), s = m[3] ? Number(m[3]) : 0
  if (h > 23 || min > 59 || s > 59) return null

  const shifted = anchorUtc + tzOffsetMin * 60_000
  const midnight = Math.floor(shifted / DAY_MS) * DAY_MS
  let out = midnight + (h * 3600 + min * 60 + s) * 1000 - tzOffsetMin * 60_000

  // Crossing local midnight: take whichever day puts the result nearest the
  // time it is correcting.
  if (out - anchorUtc > DAY_MS / 2) out -= DAY_MS
  else if (anchorUtc - out > DAY_MS / 2) out += DAY_MS
  return out
}

export interface Nudge {
  /** Milliseconds to add. Negative steps come first — people press late. */
  ms: number
  label: string
}

/**
 * The steps offered next to an editable time.
 *
 * Backwards first and backwards further, because the whole reason this control
 * exists is that a tag is pressed AFTER the thing it is about — the crew member
 * had to see it, recognise it and find the button, and on the water they did all
 * that one-handed. Forward steps are there so an overshoot is not a dead end.
 */
export const NUDGES: Nudge[] = [
  { ms: -600_000, label: '−10m' },
  { ms: -60_000, label: '−1m' },
  { ms: -10_000, label: '−10s' },
  { ms: -1_000, label: '−1s' },
  { ms: 1_000, label: '+1s' },
  { ms: 10_000, label: '+10s' },
  { ms: 60_000, label: '+1m' },
  { ms: 600_000, label: '+10m' },
]

/**
 * Apply a nudge, keeping the result inside the day's data.
 *
 * Clamping matters: −10 m pressed twice on a tag four minutes into the day would
 * otherwise put it before the boat left the dock, where the track cannot draw it
 * and no detection can ever match it.
 */
export function nudge(
  utc: number,
  ms: number,
  bounds?: { min?: number | null; max?: number | null }
): number {
  let out = utc + ms
  if (bounds && isNum(bounds.min) && out < bounds.min) out = bounds.min
  if (bounds && isNum(bounds.max) && out > bounds.max) out = bounds.max
  return out
}

/** "+4s" / "−1m 20s" / "" — how far a time has been moved from where it started. */
export function driftLabel(fromUtc: number, toUtc: number): string {
  const d = Math.round((toUtc - fromUtc) / 1000)
  if (!d) return ''
  const sign = d < 0 ? '−' : '+'
  const a = Math.abs(d)
  const m = Math.floor(a / 60)
  const s = a % 60
  return m ? `${sign}${m}m${s ? ` ${s}s` : ''}` : `${sign}${s}s`
}

// uploadOrder.ts — the order clips are pushed to the cloud.
//
// WHY THIS EXISTS. The clip script cuts starts first so the debrief's opening
// clip is ready while the gybes are still encoding. That bought nothing,
// because the uploader took clips in the order the library happened to show
// them — newest first. On 8 Sept the race start was encoded first and uploaded
// LAST, behind ten gybes: the one clip the debrief opens with was the last
// thing the team could watch.
//
// Uploads are serial and each clip becomes watchable as its own bytes land, so
// the order is not cosmetic — it decides what the team can see first. This
// mirrors the ranking in scripts/select-race-clips.mjs deliberately; if one
// changes, change the other.

/** Rank by event type. Lower goes first. */
const RANK: Record<string, number> = {
  'race-start': 0,
  racestart: 0,
  start: 0,
  topmark: 1,
  gate: 2,
  tack: 3,
  gybe: 3,
  jibe: 3,
}

const normalise = (s: unknown): string =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')

/**
 * Priority of one clip: 0 for a start, then roundings, then manoeuvres, 9 for
 * anything we cannot classify. Reads the tags first and falls back to the
 * title, because the clip script puts the same words in both and a clip that
 * has lost its tags should still be ordered sensibly rather than sinking to
 * the bottom with the untagged.
 */
export function clipRank(clip: { tags?: unknown; title?: unknown; name?: unknown }): number {
  const fromTags = (Array.isArray(clip.tags) ? clip.tags : [])
    .map(normalise)
    .map((t) => RANK[t])
    .filter((r): r is number => r != null)
  if (fromTags.length) return Math.min(...fromTags)

  const text = `-${normalise(clip.title || clip.name)}-`
  let best = 9
  for (const [word, rank] of Object.entries(RANK)) {
    // Bounded match: `-start-` must not fire on `-restart-`, and `-gate-`
    // must not fire on a boat called Gateway.
    if (text.includes(`-${word}-`)) best = Math.min(best, rank)
  }
  return best
}

/**
 * Milliseconds for ordering within a rank. Prefers a real start time and falls
 * back to the YYYYMMDDHHMMSS stamp the clip script writes into every filename.
 * Returns null when neither is present, and those sort last rather than
 * pretending to be at the epoch.
 */
export function clipTimeMs(clip: {
  startUtc?: unknown
  utc?: unknown
  title?: unknown
  name?: unknown
}): number | null {
  for (const v of [clip.startUtc, clip.utc]) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
    if (typeof v === 'string') {
      const t = Date.parse(v)
      if (Number.isFinite(t)) return t
    }
  }
  const m = String(clip.title || clip.name || '').match(
    /(\d{4})(\d{2})(\d{2})[ _-]?(\d{2})(\d{2})(\d{2})/
  )
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m.map(Number)
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  if (h > 23 || mi > 59 || s > 59) return null
  return Date.UTC(y, mo - 1, d, h, mi, s)
}

/**
 * Sort a copy of `clips` into upload order: starts, then roundings, then
 * manoeuvres, chronological within each. Does not mutate the input — callers
 * hold on to the selection order for the UI.
 */
export function sortForUpload<T extends { tags?: unknown; title?: unknown; name?: unknown }>(
  clips: readonly T[]
): T[] {
  return [...clips].sort((a, b) => {
    const r = clipRank(a) - clipRank(b)
    if (r !== 0) return r
    const ta = clipTimeMs(a)
    const tb = clipTimeMs(b)
    if (ta == null && tb == null) return 0
    if (ta == null) return 1          // undateable goes last, not first
    if (tb == null) return -1
    return ta - tb
  })
}

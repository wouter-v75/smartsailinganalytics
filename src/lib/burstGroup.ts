// src/lib/burstGroup.ts
// ─────────────────────────────────────────────────────────────────────────────
// A motor-drive burst is one moment, not twenty-four of them.
//
// 2026-09-04 holds 61 photographs, of which 41 are two bursts: 17 frames in five
// seconds and 24 in three. On a time axis those land on top of each other and
// read as the same picture repeated, which is how it was reported.
//
// So the timeline shows ONE card per burst — the middle frame, because the ends
// of a burst are where the photographer was still finding or already leaving the
// subject — and says how many frames are behind it. The rest are not thrown
// away: the card steps through them, and the Photos tab has always shown every
// frame.
//
// SINGLE-LINK, not fixed windows: a frame joins the burst it is within `gapMs`
// of, so a long continuous sequence is one burst however far it runs. Fixed
// windows would cut a five-second burst in half whenever it straddled a
// boundary, which is the more surprising behaviour of the two.
// ─────────────────────────────────────────────────────────────────────────────

export interface Burst<T> {
  /** The frame the timeline shows — the middle one. */
  lead: T
  /** Every frame, earliest first. `lead` is one of them. */
  frames: T[]
  /** Index of `lead` within `frames`. */
  leadIndex: number
  /** First and last instants in the burst. */
  t0: number
  t1: number
}

/**
 * Group items into bursts by time.
 *
 * @param items  anything with a time; order does not matter, they are sorted.
 * @param timeOf how to read the instant, ms.
 * @param gapMs  frames closer together than this belong to one burst.
 */
export function groupBursts<T>(
  items: readonly T[],
  timeOf: (t: T) => number,
  gapMs = 10_000,
): Burst<T>[] {
  const sorted = items
    .filter((it) => Number.isFinite(timeOf(it)))
    .slice()
    .sort((a, b) => timeOf(a) - timeOf(b))
  if (!sorted.length) return []

  const groups: T[][] = []
  for (const it of sorted) {
    const g = groups[groups.length - 1]
    // Compared against the PREVIOUS frame, not the burst's start: that is what
    // makes it single-link, and what lets a steady sequence stay one burst.
    if (g && timeOf(it) - timeOf(g[g.length - 1]) <= gapMs) g.push(it)
    else groups.push([it])
  }

  return groups.map((frames) => {
    // The middle. For an even count this is the later of the two central frames,
    // which matters not at all but should at least be decided rather than drift.
    const leadIndex = Math.floor(frames.length / 2) - (frames.length % 2 === 0 ? 1 : 0)
    return {
      lead: frames[leadIndex],
      frames,
      leadIndex,
      t0: timeOf(frames[0]),
      t1: timeOf(frames[frames.length - 1]),
    }
  })
}

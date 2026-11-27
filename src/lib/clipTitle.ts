// Matching one clip's title against another's, across the naming conventions
// that exist in this library.
//
// It lives here with a test because it decides what gets DELETED. Bunny is the
// archive and nothing is kept on the cards (Wouter, 27 Nov 2026), so an
// unreferenced Stream object may be the only copy of that footage there is. The
// triage asks "does a playable row exist for THIS clip?" and the answer is this
// comparison — so a false match says "superseded" about unique footage, and
// that is the direction that loses it.
//
// THE CONVENTIONS, all present on the live data:
//
//   20260911135629_race-start_day9_drone.mp4     a clips:day cut, as uploaded
//   20260911135629 race-start day9 drone         the same cut, as the row has it
//   DJI 20260527152016 0013 D_720p.mp4           a derived 720p encode
//   DJI 20260527152016 0013 D                    its full-resolution twin
//   20260729_145610.mp4                          straight off the camera
//
// So separators are interchangeable, the extension is noise, and a `720p`
// suffix marks a rendition of the same clip rather than a different one.

/** A title reduced to what identifies the clip. */
export function normTitle(t: string | null | undefined): string {
  return (t || '')
    .replace(/\.(mp4|mov|m4v)$/i, '')
    .replace(/[_ -]?720p$/i, '')
    .replace(/[_\-\s]+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Titles too weak to identify a clip by.
 *
 * A normalised title is only usable as an identity if it could not plausibly
 * belong to two different recordings. `undefined` is in the library as a real
 * title — a JS `undefined` reached the field — on 3.5 GB of 1080p, and a bare
 * word like `drone` or `race` names a category, not a clip. Matching on one of
 * those would call unique footage superseded.
 *
 * Every real title here carries its own timestamp, so the bar costs nothing.
 */
const UNUSABLE = new Set([
  '', 'undefined', 'null', 'nan', 'video', 'clip', 'drone', 'camera', 'race',
  'original', 'proxy', 'untitled', 'movie', 'img', 'export',
])

export function isUsableTitle(t: string | null | undefined): boolean {
  const n = normTitle(t)
  if (n.length < 8) return false      // shorter than one timestamp
  if (UNUSABLE.has(n)) return false
  return true
}

/**
 * Does this title name the same clip as one of `others`?
 *
 * Returns false for a title that cannot identify a clip, rather than matching
 * loosely — an unmatched file is kept, which is the safe outcome.
 */
export function sameClip(title: string | null | undefined, others: Set<string>): boolean {
  if (!isUsableTitle(title)) return false
  return others.has(normTitle(title))
}

/** The comparable titles of clips that can actually be played. */
export function titleIndex(
  rows: readonly { title?: string | null; playable: boolean }[]
): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    if (!r.playable || !isUsableTitle(r.title)) continue
    out.add(normTitle(r.title))
  }
  return out
}

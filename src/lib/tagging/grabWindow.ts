// Is a Grab video tag a MOMENT or a SECTION?
//
// Both are the same row. ssa_tag_events has carried [t0, t1) since 0062, and a
// tag placed by a button gets the definition's own lead and lag put round the
// press — Grab video's is 30 s either side, so an ordinary press is stored as a
// 60 s span. A tag whose in and out were marked while watching the footage back
// carries the window somebody chose instead.
//
// Nothing in the row says which it is. There is no flag, and adding one would
// not help the 150-odd rows already stored. What separates them is the only
// thing available: a chosen window is longer than the one the button would have
// made by itself.
//
// Why this is a module and not three lines in the cutter: the cutter decides
// what to encode from it, the review UI decides what is worth sending, and a
// rule those two disagree about produces a clip of a length nobody asked for.
// Here, with a test, they cannot drift.

/** Grab video's lead in baseTags, in ms — half of a plain press's stored span. */
export const GRAB_LEAD_MS = 30_000

/**
 * Below this, two marks are a double press rather than a window. A second is
 * generous for a keypress and far below anything worth cutting.
 */
export const MIN_SECTION_MS = 1_000

export interface GrabWindow {
  /** 'section' — cut exactly this. 'moment' — one instant, for the cutter to pad. */
  kind: 'section' | 'moment'
  /** Set for a section: the window as marked. */
  from?: number
  to?: number
  /** Set for a moment: the instant pressed, with the lead already taken off. */
  at?: number
}

/**
 * Read a stored Grab video row.
 *
 * `t0` is lead before the press, so a moment's instant is `t0 + leadMs` — the
 * same arithmetic every other tag in the cutter goes through, and the reason a
 * corrected mark is not cut 20 s early.
 */
export function grabWindow(
  { t0, t1 }: { t0: number; t1?: number | null },
  leadMs: number = GRAB_LEAD_MS
): GrabWindow {
  if (!Number.isFinite(t0)) return { kind: 'moment', at: NaN }
  const end = typeof t1 === 'number' && Number.isFinite(t1) ? t1 : null
  const span = end == null ? 0 : end - t0
  // STRICTLY longer than the button's own span. Equal is the button: a press
  // stores exactly 2 × lead, and treating that as a chosen section would cut
  // every press as a fixed 60 s clip of its own, bypassing the merging that
  // stops two presses ten seconds apart becoming two clips of the same water.
  if (span > 2 * leadMs) return { kind: 'section', from: t0, to: end as number }
  return { kind: 'moment', at: t0 + leadMs }
}

/**
 * An in and an out as the review UI collects them, in whatever order they were
 * pressed. Returns null when they are too close together to mean anything.
 *
 * Sorted rather than refused: an out point before the in point is nearly always
 * a second thought about where the section starts. The CUTTER refuses a
 * reversed pair, because by then it is a typo on a command line — here it is a
 * person changing their mind, which is a different thing.
 */
export function sectionFromMarks(
  markIn: number,
  markOut: number
): { from: number; to: number } | null {
  if (!Number.isFinite(markIn) || !Number.isFinite(markOut)) return null
  const from = Math.min(markIn, markOut)
  const to = Math.max(markIn, markOut)
  if (to - from < MIN_SECTION_MS) return null
  return { from, to }
}

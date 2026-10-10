// src/lib/tagging/pressAt.ts
// ─────────────────────────────────────────────────────────────────────────────
// What instant a button press means.
//
// Most specific first: a moment held on the track, then the card being
// reviewed, then the video playhead, then the clock. Tagging the track and
// having the tag land at "now" would make the whole view decorative.
//
// THE CLOCK IS ONLY RIGHT WHILE THE BOAT IS SAILING. The tab opens on today, so
// a crew tagging a day they have already sailed — the commonest thing to do on
// a phone, on the dock — presses buttons against a day whose log may not be the
// one on screen. Every such press lands at the moment it was pressed, and
// nothing downstream can tell: `t0` and `session_date` agree with each other
// perfectly and both are the wrong moment. There is nothing to recover from,
// because the real instant was never recorded.
//
// So the clock is CLAMPED to the day's own data window. A press on a day whose
// log ran 09:12–16:40 cannot land outside it: the worst case becomes a tag at
// the end of that day's data, which is visibly wrong, on the right day, on the
// track, draggable. That is recoverable; a tag on a day nobody sailed is not.
//
// And when the day has NO window — no log, no video — there is nothing to clamp
// to and nothing to correct against. The caller is told so (`atWallClock`) and
// says so on screen, rather than taking the press as though it meant something.
//
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export interface PressInputs {
  /** A moment held on the track. */
  picked?: number | null
  /** The card open in the review queue. */
  review?: number | null
  /** The video playhead. */
  playhead?: number | null
  /** The wall clock, injected so this stays pure. */
  now: number
  /** The day's data window — the log's first and last row. */
  bounds?: { min?: number | null; max?: number | null } | null
}

export type PressSource = 'picked' | 'review' | 'playhead' | 'clock' | 'clamped'

export interface PressResult {
  at: number
  source: PressSource
  /**
   * True when the instant is the bare wall clock on a day with no data to
   * place it against. The press still works — somebody pressing a button means
   * something by it — but nothing can check it, so the UI warns instead of
   * letting it pass as a timed tag.
   */
  atWallClock: boolean
}

export function pressAt(input: PressInputs): PressResult {
  const { picked, review, playhead, now, bounds } = input
  if (isNum(picked)) return { at: picked, source: 'picked', atWallClock: false }
  // The card being reviewed beats the uploaded clip being played: if both are
  // open, the one you are looking at is the one on the card.
  if (isNum(review)) return { at: review, source: 'review', atWallClock: false }
  if (isNum(playhead)) return { at: playhead, source: 'playhead', atWallClock: false }

  const min = isNum(bounds?.min) ? (bounds!.min as number) : null
  const max = isNum(bounds?.max) ? (bounds!.max as number) : null
  if (min == null || max == null || max < min) {
    return { at: now, source: 'clock', atWallClock: true }
  }
  if (now < min) return { at: min, source: 'clamped', atWallClock: false }
  if (now > max) return { at: max, source: 'clamped', atWallClock: false }
  // Inside the window: the boat is sailing and the clock is the best answer
  // there is.
  return { at: now, source: 'clock', atWallClock: false }
}

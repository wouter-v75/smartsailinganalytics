// src/lib/defaultTzOffset.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE VENUE OFFSET TO ASSUME WHEN THE SESSION DOES NOT CARRY ONE.
//
// It used to be `DEFAULT_TZ = 120`. That is CEST — **the summer offset** — and
// it was the year-round default, so it asserted two things at once: that the
// venue is Central Europe, and that it is summer. From the last Sunday in
// October to the last Sunday in March the second is false.
//
// What it cost, measured 28 Nov 2026: clips whose filenames stamp 12:00 and
// 12:15 were displayed in the Videos tab and the Timeline as **13:00 and
// 13:15**. Both tabs agreed, which is what made it look like a convention
// rather than a fault. It is worse away from the Med — the UK in November is
// UTC+0, so a UK day reads TWO hours late — and that is the same trap
// CLAUDE.md already warns about for `drone:coverage --tz`: "the venue is not
// always the Med."
//
// THE HONEST POSITION: a default cannot be right in general. Only the session
// knows where it was sailed, and `sessions.tz_offset_minutes` (or the log's own
// `tzOffset`) is the real answer whenever it exists. This is only what to do
// when there is nothing stored, and the question is which way of being wrong
// is best.
//
// The browser's own offset FOR THAT DATE, because:
//
//   • it is DST-correct by construction, which no constant can be — ask
//     `getTimezoneOffset` about a day in November and you get November's
//     answer;
//   • whoever imports a day's footage is almost always at the venue or in a
//     zone that matches it. The laptop that cut the clips is the best available
//     witness to where they were cut;
//   • when it IS wrong it is wrong legibly — "my computer is set to London" is
//     a thing a person can see and correct. A hardcoded +2 is wrong invisibly,
//     and asserts a continent and a season nobody chose.
//
// It must never stand in for a stored offset. Callers pass `log.tzOffset ??
// defaultTzOffsetMin(date)`, in that order, and the stored value always wins.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minutes EAST of UTC to assume for a session, e.g. 60 for CET, 120 for CEST.
 *
 * Note the sign: this is the opposite of `Date.prototype.getTimezoneOffset`,
 * which returns minutes to ADD to local time to reach UTC (−120 for UTC+2).
 * The app's `tz_offset_minutes` is east-positive, matching the TZ_OPTIONS
 * labels, so the sign is flipped here once rather than at every call site.
 *
 * @param sessionDate `YYYY-MM-DD`. Omitted means today — which is right for
 *   the Upload tab's selectors, where the day being imported is not yet known.
 */
export function defaultTzOffsetMin(sessionDate?: string | null): number {
  const at = instantFor(sessionDate)
  const mins = -at.getTimezoneOffset()
  // A zone offset is always a whole number of minutes within ±14 h. Anything
  // else means an environment without a real clock, and UTC is the only
  // defensible answer there — never the old +2.
  if (!Number.isFinite(mins) || Math.abs(mins) > 14 * 60) return 0
  // Negating a zero offset gives -0, which is === 0 but not Object.is 0 — so it
  // fails a strict equality check, a Map key lookup and a `toBe(0)`. UTC is a
  // real answer here (the UK in winter, Portugal in winter), so normalise it.
  return mins === 0 ? 0 : mins
}

/**
 * Noon UTC on the session's date — or now, if there is no date.
 *
 * Noon rather than midnight so that a venue up to twelve hours either side of
 * UTC still lands inside the intended calendar day, and so a DST transition at
 * 01:00 or 03:00 local cannot put the probe on the wrong side of the change.
 */
function instantFor(sessionDate?: string | null): Date {
  if (sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
    const d = new Date(`${sessionDate}T12:00:00Z`)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date()
}

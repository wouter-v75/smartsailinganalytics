// src/lib/tagging/sessionDate.ts
// ─────────────────────────────────────────────────────────────────────────────
// Which day does a tag belong to?
//
// A tag carries two times, and nothing used to keep them in step: t0, the
// instant somebody pressed the button, and session_date, the day the APP
// happened to be showing. The client sent both and the server wrote both
// verbatim, so a crew tagging on the water with yesterday's day still loaded —
// or, on 28 September, with a campaign day a week away loaded — filed every tag
// correctly timed onto a day nobody had sailed, and invisible on the day they
// belonged to.
//
// t0 is the one that cannot be wrong. But it cannot simply overrule the claim
// either: session_date is the VENUE's calendar day and t0 is UTC, so a day at
// a venue far from Greenwich legitimately disagrees with it, and a session that
// runs through local midnight disagrees by a whole day on purpose.
//
// So: believe the claim when it is anywhere near the instant, and fall back to
// the instant when it is not. A day's slack covers every venue offset and every
// midnight; five days does not, and never meant anything.
//
// Pure — no I/O.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** How far a claimed day may sit from the instant before it stops being a
 *  timezone and starts being a mistake. */
export const SESSION_DATE_SLACK_DAYS = 1

export interface SessionDateResult {
  date: string
  /** True when the claim was not believable and the instant was used instead.
   *  The caller logs it: a tag quietly moving day is worth one line. */
  corrected: boolean
}

export function sessionDateFor(t0Ms: number, claimed?: unknown): SessionDateResult {
  const fromInstant = isoDay(t0Ms)
  const claim = typeof claimed === 'string' ? claimed.slice(0, 10) : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(claim)) return { date: fromInstant, corrected: false }

  const claimMs = Date.parse(`${claim}T00:00:00Z`)
  if (!Number.isFinite(claimMs)) return { date: fromInstant, corrected: false }

  // Measured against the claimed day's own midnight, so "the same day" is zero
  // and a venue twelve hours out is still inside one.
  const drift = Math.abs(t0Ms - claimMs)
  if (drift <= (SESSION_DATE_SLACK_DAYS + 1) * DAY_MS) return { date: claim, corrected: false }
  return { date: fromInstant, corrected: true }
}

// src/lib/debriefContinue.ts
// ─────────────────────────────────────────────────────────────────────────────
// Finishing a summary the model ran out of room for.
//
// The ceiling is a TIME budget, not a context one: the route has 280 s before
// Vercel kills it, and a model generating at a few tens of tokens a second can
// spend all of it on one enormous call and return nothing. That is why
// max_tokens sits at 8000 and not 16000 — a truncated summary beats a 504.
//
// So rather than raise the ceiling, go round it: ask again for the REST. Each
// call stays comfortably inside the budget, and the only cost is one extra round
// trip on the debriefs that actually need it. Baraka's Admiral's Cup meeting
// needed it; a twenty-minute speed-team note will not.
//
// The merge is here, away from the route, because it is the part with judgement
// in it: which key was being written when the output stopped, what to do with
// keys the model never reached, and what to do when it repeats itself.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The key that was being written when the output stopped.
 *
 * JSON.parse preserves insertion order, so the last key in the repaired object
 * is the one that was cut — everything before it was finished and closed. Null
 * when there is nothing to continue.
 */
export function cutKeyOf(parsed: Record<string, unknown> | null): string | null {
  if (!parsed) return null
  const keys = Object.keys(parsed).filter((k) => {
    const v = parsed[k]
    return typeof v === 'string' ? v.length > 0 : v != null
  })
  return keys.length ? keys[keys.length - 1] : null
}

/**
 * Drop any tail of `partial` that `cont` has repeated at its start.
 *
 * Asked to continue, a model will quite often restate the last line or two for
 * context before carrying on. Pasting that straight on gives a note that says
 * the same thing twice in the middle, which reads as a transcription fault and
 * is worse than the gap it was meant to fix.
 *
 * The longest overlap wins, searched from longest to shortest so that a short
 * accidental coincidence ("- " or "the ") cannot beat a real repeat.
 */
export function trimOverlap(partial: string, cont: string, maxLook = 400): string {
  if (!partial || !cont) return cont
  const window = partial.slice(-maxLook)
  for (let n = Math.min(window.length, cont.length); n >= 12; n--) {
    if (window.slice(-n) === cont.slice(0, n)) return cont.slice(n)
  }
  return cont
}

/**
 * Join what the model wrote first with what it wrote when asked for the rest.
 *
 * Three cases, and the third is why this is not a spread:
 *   • the key that was CUT      → the continuation is appended to it;
 *   • a key it never REACHED    → taken from the continuation wholesale;
 *   • a key already FINISHED    → left alone. The continuation may mention it
 *     again, and a second, hastier version must not overwrite a complete one.
 */
export function mergeContinuation(
  partial: Record<string, string>,
  cont: Record<string, string>,
  cutKey: string | null,
): Record<string, string> {
  const out: Record<string, string> = { ...partial }
  for (const k of Object.keys(cont)) {
    const more = (cont[k] || '').trim()
    if (!more) continue
    if (k === cutKey) {
      const head = out[k] || ''
      // NOT trimmed, and no newline inserted. The cut is usually mid-SENTENCE —
      // "…clothing/gear (e.g., with" — so a line break here would break the
      // sentence it is meant to repair. The model decides its own paragraphs; a
      // single space is added only when neither side left one.
      const tail = trimOverlap(head, cont[k] || '')
      if (!tail.trim()) continue
      const joined = /\s$/.test(head) || /^\s/.test(tail) ? '' : ' '
      out[k] = head ? `${head}${joined}${tail}` : tail
    } else if (!(out[k] || '').trim()) {
      out[k] = more
    }
  }
  return out
}

/** How many times to ask for the rest before giving up and saying it is short. */
export const MAX_CONTINUATIONS = 3

/**
 * Enough of the budget left to be worth another call?
 *
 * Starting one that cannot finish is the failure the ceiling exists to avoid:
 * it turns a summary that is merely short into a 504 and no summary at all.
 */
export const MIN_MS_FOR_ANOTHER = 50_000

export function canContinue(elapsedMs: number, budgetMs: number, rounds: number): boolean {
  return rounds < MAX_CONTINUATIONS && budgetMs - elapsedMs >= MIN_MS_FOR_ANOTHER
}

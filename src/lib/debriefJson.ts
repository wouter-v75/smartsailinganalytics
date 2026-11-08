// src/lib/debriefJson.ts
// ─────────────────────────────────────────────────────────────────────────────
// Reading the summariser's JSON back, and SAYING when it had to be repaired.
//
// A model that runs out of output room stops mid-string, so the JSON never
// closes. Rather than fail outright and lose a 75-minute debrief, the repair
// below shuts the open string and the unbalanced braces and parses what is
// there — which is right, because most of the summary is worth keeping.
//
// But it used to return exactly what a clean parse returns, so nothing
// downstream could tell a rescued note from a finished one. The route decided
// "truncated" on `finish_reason === 'length'` alone, and when the provider
// reported anything else — Mistral's own spec is not consistent about this, and
// the published enums disagree — a note that stopped mid-sentence was saved with
// no warning at all. On Baraka's Admiral's Cup debrief it stopped at
// "- Apparel: Assign someone to handle team clothing/gear (e.g., with".
//
// So the repair now reports itself. That is a better signal than any
// finish_reason, because it is evidence from the payload rather than metadata
// the provider may or may not send: if the JSON did not close, the output was
// cut, whatever the API says about why.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractedJson {
  data: Record<string, unknown> | null
  /** True when the text had to be repaired to parse — so it was CUT SHORT. */
  repaired: boolean
}

export function extractJson(text: string): ExtractedJson {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const tryParse = (s: string): Record<string, unknown> | null => {
    try { return JSON.parse(s) as Record<string, unknown> } catch { return null }
  }

  let r = tryParse(cleaned)
  if (r) return { data: r, repaired: false }

  // Fences or prose around a COMPLETE object: still not truncated, just untidy.
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}')
  if (a >= 0 && b > a) {
    r = tryParse(cleaned.slice(a, b + 1))
    if (r) return { data: r, repaired: false }
  }

  // From the first '{', close an open string + any unbalanced braces and parse.
  // Reaching here at all means the object never closed on its own.
  if (a >= 0) {
    let s = cleaned.slice(a).replace(/\\+$/, '')
    const quotes = (s.match(/(?<!\\)"/g) || []).length
    if (quotes % 2 === 1) s += '"'
    const opens = (s.match(/{/g) || []).length, closes = (s.match(/}/g) || []).length
    if (opens > closes) s += '}'.repeat(opens - closes)
    r = tryParse(s)
    if (r) return { data: r, repaired: true }
  }
  return { data: null, repaired: false }
}

/**
 * Did the model stop because it had finished?
 *
 * Anything that is not a clean stop is treated as cut short. The enum is not
 * dependable across providers — Mistral's published values disagree about
 * whether a context-exhausted generation is `length` or `model_length` — and
 * the two failure directions are not equal: a warning on a complete summary
 * costs a second's reading, while a missing warning saves a note with its last
 * point gone. A MISSING finish_reason is taken as clean, so a provider that
 * sends none does not light the warning on every single run.
 */
export function stoppedCleanly(finishReason: string | null | undefined): boolean {
  if (finishReason == null || finishReason === '') return true
  return finishReason === 'stop' || finishReason === 'tool_calls'
}

/**
 * Does this text stop mid-sentence?
 *
 * THE THIRD SIGNAL, and the one that catches what the other two cannot.
 *
 * `repaired` was added because finish_reason is metadata the provider may get
 * wrong. It is better evidence — but it only fires when the JSON did not close.
 * On Ryujin's 7 Nov debrief (17:52 of audio, a complete 13,870-character
 * transcript) Mistral returned a **valid, closed** JSON object whose single
 * value stopped at "…allowed for a quick ", and reported
 * `finish_reason: "stop"`. Both signals said finished, the continuation loop
 * never ran, no warning was shown, and 1,151 characters were saved as a whole
 * note. Re-running it stops in the SAME sentence, so it is reproducible and not
 * a one-off.
 *
 * Nothing about the metadata or the shape of the payload can see that. The
 * CONTENT can: a working note that ends without so much as a full stop was cut,
 * whoever says otherwise. `scripts/debrief-stored.ts` has diagnosed this by hand
 * with exactly this test since it was written — it just had no way to tell the
 * summariser, which is why both live here now.
 *
 * It errs toward flagging, deliberately and for the reason given above: a
 * warning on a finished note costs a second's reading; a missing warning saves a
 * note with its last point gone. The cost of a false positive is bounded — the
 * continuation loop stops as soon as a round adds nothing.
 *
 * Only ever applied to MODEL output. A hand-typed note very often ends on a bare
 * header or a "#actions" tag, and that is not a fault.
 */
export function endsMidSentence(s: string | null | undefined): boolean {
  const tail = (s ?? '').trimEnd()
  if (!tail) return false
  return !/[.!?:)\]"'`\u00bb]$/.test(tail)
}

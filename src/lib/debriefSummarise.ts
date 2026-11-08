// src/lib/debriefSummarise.ts
// ─────────────────────────────────────────────────────────────────────────────
// Summarise a transcript, and finish the job when the model runs out of room.
//
// This lives out of the route for two reasons. The first is testing: the loop
// has real judgement in it — when to ask again, which key was cut, when to stop
// spending the time budget — and a loop that only runs behind an authenticated
// Next.js route against a paid API is a loop nobody exercises. With the model
// call injected, a fake that truncates twice and then finishes tests the whole
// thing in milliseconds.
//
// The second is that re-running a summary should not cost a transcription. The
// app's flow is audio → transcribe → summarise, so testing a SUMMARISE fix
// through the UI means paying for the transcription again. scripts/
// debrief-resummarise.ts calls this with the transcript alone — and calls THIS,
// not a copy of it, so the script and the route cannot drift.
// ─────────────────────────────────────────────────────────────────────────────

import { extractJson, stoppedCleanly, endsMidSentence } from './debriefJson'
import { cutKeyOf, mergeContinuation, canContinue } from './debriefContinue'

/** What one call to the model gives back. Injected, so the loop is testable. */
export interface AskResult {
  ok: boolean
  content?: string
  finishReason?: string
  status?: number
  text?: string
}
export type Ask = (messages: unknown[]) => Promise<AskResult>

/** Render whatever the model chose (string / array of bullets / nested object)
 *  down to a markdown bullet string. Mistral sometimes returns arrays even when
 *  asked for a string — this makes the caller indifferent to that. */
export function coerce(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v.map((x) => {
      const s = coerce(x).trim()
      return s.startsWith('-') || s.startsWith('•') ? s : `- ${s}`
    }).filter(Boolean).join('\n')
  }
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).map(([k, x]) => `- ${k}: ${coerce(x)}`).join('\n')
  }
  return String(v)
}

export const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Case/space-insensitive key lookup, so "Speed Learnings" or "speed-learnings"
 *  still map onto the canonical DB keys. */
export function toResult(obj: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  const byNorm: Record<string, unknown> = {}
  for (const k of Object.keys(obj)) byNorm[normKey(k)] = obj[k]
  const out: Record<string, string> = {}
  for (const k of keys) out[k] = coerce(k in obj ? obj[k] : byNorm[normKey(k)])
  return out
}

/** The instruction that asks for the remainder and nothing else. */
export function continueInstruction(cutKey: string | null): string {
  // "you ran out of room" was the only cause this knew about, and it is now the
  // least common one: the Ryujin case had room to spare and simply stopped. The
  // premise has to be the SYMPTOM, which is true however it happened, or the
  // model is being told something it can see is false.
  return 'That reply was CUT OFF — it is unfinished and stops mid-sentence. '
    + 'Continue from exactly where it stopped. Return ONLY valid JSON with the same keys. '
    + (cutKey
      ? `For "${cutKey}", output ONLY the text that still has to follow — do NOT repeat anything `
        + 'already written, and do not re-open a section that is already finished. '
      : '')
    + 'Include in full any key you had not started yet. Keep the same layout and the same voice.'
}

/** Which of the three tells fired, as of the last reply. For the log and the UI:
 *  "it still ends mid-sentence" and "the provider cut it off" are different
 *  sentences to read, and guessing between them is what cost the last three
 *  rounds of this bug. */
export interface CutSignals {
  /** The JSON did not close on its own and had to be repaired. */
  repaired: boolean
  /** finish_reason was something other than a clean stop. */
  finishReason: boolean
  /** The text itself stops without so much as a full stop. */
  midSentence: boolean
}

export interface SummariseOutcome {
  result: Record<string, string>
  /** Still short after every continuation it was allowed. */
  truncated: boolean
  rounds: number
  signals: CutSignals
  /** Null only when the FIRST reply could not be parsed at all. */
  error?: { kind: 'call' | 'parse'; status?: number; detail?: string }
  firstContent: string
}

/** The key that was being written: the last one with anything in it. Shared by
 *  the continuation prompt and the mid-sentence test so they cannot disagree
 *  about which value is the unfinished one. */
function lastFilledKey(r: Record<string, string>, keys: readonly string[]): string | null {
  return [...keys].reverse().find((k) => (r[k] || '').trim()) ?? null
}

const NOT_CUT: CutSignals = { repaired: false, finishReason: false, midSentence: false }

export async function summariseWithContinuation({
  ask, baseMessages, keys, budgetMs, startedAt = Date.now(), log = () => {},
  contentSignal = true,
}: {
  ask: Ask
  baseMessages: unknown[]
  keys: readonly string[]
  budgetMs: number
  startedAt?: number
  log?: (...a: unknown[]) => void
  /**
   * Use the mid-sentence test. TRUE for the structured modes, where the output
   * is a markdown note that always ends on a full stop, and the three stored
   * examples of a cut all end without one.
   *
   * FALSE for `note` — ONE dictated line, tidied, whose prompt says to keep it
   * the length it was said at. "- Check the jib lead" is a finished note with no
   * full stop in it, so the signal would fire on an ordinary note, and the cost
   * lands exactly where it hurts: another round trip on a phone on the dock,
   * with nothing shown to explain the wait, to protect against a 40-second
   * recording running out of an 8,000-token ceiling. It cannot.
   */
  contentSignal?: boolean
}): Promise<SummariseOutcome> {
  const first = await ask(baseMessages)
  if (!first.ok) {
    return { result: {}, truncated: false, rounds: 0, signals: NOT_CUT, firstContent: '', error: { kind: 'call', status: first.status, detail: first.text } }
  }
  const firstContent = first.content || ''
  const { data: parsed, repaired } = extractJson(firstContent)
  if (!parsed) {
    return {
      result: {}, rounds: 0, firstContent, error: { kind: 'parse' },
      truncated: repaired || !stoppedCleanly(first.finishReason),
      signals: { repaired, finishReason: !stoppedCleanly(first.finishReason), midSentence: false },
    }
  }

  let result = toResult(parsed, keys)
  let rounds = 0

  // THREE signals, and they fail in different directions, which is why all three
  // are needed and why none of them is allowed to be the only one:
  //   finish_reason — what the provider SAYS. Mistral's own enums disagree about
  //     it, and it said 'stop' on a reply that plainly was not finished.
  //   repaired      — what the payload SHOWS. Better evidence, but blind to a
  //     reply whose JSON closed tidily around an unfinished sentence.
  //   midSentence   — what the TEXT shows. A working note that ends without a
  //     full stop was cut, whatever the other two claim. This is the one that
  //     caught Ryujin's 7 Nov debrief, where the other two both said finished.
  let signals: CutSignals = {
    repaired,
    finishReason: !stoppedCleanly(first.finishReason),
    midSentence: contentSignal && endsMidSentence(result[lastFilledKey(result, keys) ?? '']),
  }
  let truncated = signals.repaired || signals.finishReason || signals.midSentence
  log('finish_reason:', first.finishReason ?? '(none)',
      repaired ? '· JSON REPAIRED' : '', signals.midSentence ? '· ENDS MID-SENTENCE' : '')

  while (truncated && canContinue(Date.now() - startedAt, budgetMs, rounds)) {
    const cutKey = lastFilledKey(result, keys) ?? cutKeyOf(parsed)
    log('continuing', `round ${rounds + 1}`, 'from', cutKey ?? '(nothing)')
    const more = await ask([
      ...baseMessages,
      { role: 'assistant', content: JSON.stringify(result) },
      { role: 'user', content: continueInstruction(cutKey) },
    ])
    if (!more.ok) { log('continuation failed', more.status); break }
    const { data: moreParsed, repaired: moreRepaired } = extractJson(more.content || '')
    if (!moreParsed) { log('continuation unparseable — keeping what we have'); break }

    const before = (result[cutKey ?? ''] || '').length
    result = mergeContinuation(result, toResult(moreParsed, keys), cutKey)
    const added = (result[cutKey ?? ''] || '').length - before
    signals = {
      repaired: moreRepaired,
      finishReason: !stoppedCleanly(more.finishReason),
      // Re-tested on the MERGED text: the question is whether the note is
      // finished now, not whether this one reply was.
      midSentence: contentSignal && endsMidSentence(result[lastFilledKey(result, keys) ?? '']),
    }
    truncated = signals.repaired || signals.finishReason || signals.midSentence
    log('continuation', `+${added} chars`, 'finish_reason:', more.finishReason ?? '(none)',
        truncated ? `· STILL SHORT${signals.midSentence ? ' (mid-sentence)' : ''}` : '· complete')
    rounds++
    // A round that added nothing anywhere will not add anything next time
    // either; stop rather than spending the budget discovering that twice.
    if (added <= 0 && !keys.some((k) => (result[k] || '').trim() && !(toResult(parsed, keys)[k] || '').trim())) break
  }

  return { result, truncated, rounds, signals, firstContent }
}

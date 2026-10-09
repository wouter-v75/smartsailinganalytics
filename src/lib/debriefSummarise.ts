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

import { extractJson, stoppedCleanly } from './debriefJson'
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
  return 'That reply was CUT OFF — you ran out of room and it stops mid-sentence. '
    + 'Continue from exactly where it stopped. Return ONLY valid JSON with the same keys. '
    + (cutKey
      ? `For "${cutKey}", output ONLY the text that still has to follow — do NOT repeat anything `
        + 'already written, and do not re-open a section that is already finished. '
      : '')
    + 'Include in full any key you had not started yet. Keep the same layout and the same voice.'
}

export interface SummariseOutcome {
  result: Record<string, string>
  /** Still short after every continuation it was allowed. */
  truncated: boolean
  rounds: number
  /** Null only when the FIRST reply could not be parsed at all. */
  error?: { kind: 'call' | 'parse'; status?: number; detail?: string }
  firstContent: string
}

export async function summariseWithContinuation({
  ask, baseMessages, keys, budgetMs, startedAt = Date.now(), log = () => {},
}: {
  ask: Ask
  baseMessages: unknown[]
  keys: readonly string[]
  budgetMs: number
  startedAt?: number
  log?: (...a: unknown[]) => void
}): Promise<SummariseOutcome> {
  const first = await ask(baseMessages)
  if (!first.ok) {
    return { result: {}, truncated: false, rounds: 0, firstContent: '', error: { kind: 'call', status: first.status, detail: first.text } }
  }
  const firstContent = first.content || ''
  const { data: parsed, repaired } = extractJson(firstContent)
  // TWO signals. finish_reason is what the provider SAYS; `repaired` is what the
  // payload SHOWS — an object that never closed was cut, whatever the metadata
  // claims, and the metadata is what let Baraka's debrief through unflagged.
  let truncated = repaired || !stoppedCleanly(first.finishReason)
  log('finish_reason:', first.finishReason ?? '(none)', repaired ? '· JSON REPAIRED' : '')
  if (!parsed) {
    return { result: {}, truncated, rounds: 0, firstContent, error: { kind: 'parse' } }
  }

  let result = toResult(parsed, keys)
  let rounds = 0

  while (truncated && canContinue(Date.now() - startedAt, budgetMs, rounds)) {
    // The last key with anything in it is the one that was being written.
    const cutKey = [...keys].reverse().find((k) => (result[k] || '').trim()) ?? cutKeyOf(parsed)
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
    truncated = moreRepaired || !stoppedCleanly(more.finishReason)
    log('continuation', `+${added} chars`, 'finish_reason:', more.finishReason ?? '(none)', truncated ? '· STILL SHORT' : '· complete')
    rounds++
    // A round that added nothing anywhere will not add anything next time
    // either; stop rather than spending the budget discovering that twice.
    if (added <= 0 && !keys.some((k) => (result[k] || '').trim() && !(toResult(parsed, keys)[k] || '').trim())) break
  }

  return { result, truncated, rounds, firstContent }
}

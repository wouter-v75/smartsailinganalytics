// src/lib/ai/askRun.ts
// ─────────────────────────────────────────────────────────────────────────────
// The loop: question → tool calls → deterministic results → written answer.
//
// Pure. The model call and the tool executor are both injected, so the whole
// thing runs in a test with a scripted model and a fake executor, and the route
// is left with nothing but auth and Supabase.
//
// Three things it refuses to do, each because the research says the failure is
// otherwise invisible:
//   • It never lets the model compute. Tools return rounded numbers; the final
//     answer is checked against them (askVerify).
//   • It never lets the model resolve a clock or a date. Those arrive resolved in
//     the context pack, and the day's timestamps are converted venue-local by the
//     executor. Handing date arithmetic to deterministic code is the single
//     change the governed-API paper singles out as reducing hallucination.
//   • It never answers an ambiguous question by picking one reading. It returns
//     suggestions instead, the way Cortex Analyst does.
// ─────────────────────────────────────────────────────────────────────────────

import { assistantTurn, type ChatMessage, type ChatResult, type ToolSpec } from './scaleway'
import { TOOLS, validate, describeCall, type ToolArgs, type ToolName } from './askTools'
import type { ToolResult } from './askTypes'
import { verifyAnswer, type VerifiedAnswer } from './askVerify'
import { extractJson } from '../headlineGenerate'

/** Tool rounds before we stop and write with what we have. */
export const MAX_ROUNDS = 3
/** Tool calls per round — more than this is a model spraying, not a plan. */
const MAX_CALLS_PER_ROUND = 4

export interface AskStep {
  tool: ToolName
  args: ToolArgs
  /** The resolved call in words, for the chips. */
  chips: string[]
  result: ToolResult
}

export interface AskOutcome {
  answer: VerifiedAnswer
  steps: AskStep[]
  suggestions: string[]
  /** Which path the answer took — always disclosed on screen. */
  usedTools: boolean
  ms: number
}

export type AskFailure = { ok: false; status: number; error: string; ms: number }
export type AskSuccess = { ok: true } & AskOutcome
export type AskResponse = AskSuccess | AskFailure

export type ChatFn = (req: { messages: ChatMessage[]; tools?: ToolSpec[]; json?: boolean }) => Promise<ChatResult>
export type ExecuteFn = (name: ToolName, args: ToolArgs) => Promise<ToolResult>

const RULES = [
  'You are the performance analyst sitting in a sailing team\'s debrief. You answer one question from a crew member, in plain English, from the boat\'s own data.',
  '',
  'How you work:',
  '• You never calculate. Call a tool and copy its numbers exactly as they come back, to the decimals given. Do not average, subtract, convert units or work out a percentage yourself — ask a tool for it.',
  '• You never work out a time or a date. The dates you may use are in the context below; a tool resolves the rest.',
  '• Prefer vmgPct (upwind and downwind) and bspPol (reaching). They are percentages of the polar target, so they compare fairly between different wind strengths. Raw bsp does not: in more wind everything is faster.',
  '• Every comparison carries its phase count n. Never call a group best or worst when its n is small — say the sample is thin instead.',
  '• When a question asks to see something, or when a picture would show what the numbers say, call find_media as well.',
  '• If the question could mean two different things, or the data cannot answer it, do NOT pick a reading. Answer with no lines and put two or three better, specific questions in "suggestions".',
  '• If a tool says something is unavailable, say so plainly in the answer. Never fill the gap from general sailing knowledge — this crew only wants what their own boat recorded.',
  '• When a tool hands you caveats, put every one of them in the answer, in its own sentence. A ranking of what matters is worthless, and worse than nothing, without them — the data shows association, never cause.',
  '',
  'Write like a coach in a debrief: short sentences, the number first, no preamble, no restating the question. British English. Never claim a cause you cannot see in the data — "VMG% was 3 points lower on port" is right, "the trimmer was late" is not.',
].join('\n')

const FINAL_INSTRUCTION = [
  'Now write the answer as JSON, and call no more tools.',
  '{"answer": ["…"], "bottomLine": ["…"], "suggestions": ["…"]}',
  '• "answer": up to 6 short sentences, each carrying a number you were given by a tool — EXCEPT when the honest answer is that the boat does not record the thing asked about, which you write as a plain sentence with no numbers in it. Never return an empty answer: say what is missing.',
  '• "bottomLine": up to 2 sentences — what to do differently. Omit it if the data does not support one.',
  '• "suggestions": only when you could not answer — two or three better questions. Otherwise [].',
  'Every number must appear in a tool result exactly as you write it. A sentence with a number that does not is deleted before the crew sees it.',
].join('\n')

export async function runAsk(opts: {
  question: string
  context: string
  chat: ChatFn
  execute: ExecuteFn
  /** Earlier question/answer pairs in this conversation, oldest first. */
  history?: { question: string; answer: string }[]
  openDate?: string | null
  /** Numbers that are legitimate without coming from a tool (the dates in scope). */
  extraNumbers?: unknown[]
  /**
   * Stop starting new tool rounds after this many ms and write with what is in
   * hand. The serverless limit is a hard wall; a half-answer that arrives beats a
   * whole one that is killed at 60 s.
   */
  budgetMs?: number
}): Promise<AskResponse> {
  const t0 = Date.now()
  const budget = opts.budgetMs ?? 35_000
  const messages: ChatMessage[] = [{ role: 'system', content: `${RULES}\n\n─── What this boat has ───\n${opts.context}` }]
  for (const h of opts.history || []) {
    messages.push({ role: 'user', content: h.question })
    messages.push({ role: 'assistant', content: h.answer })
  }
  messages.push({ role: 'user', content: opts.question })

  const steps: AskStep[] = []

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (Date.now() - t0 > budget) break
    const res = await opts.chat({ messages, tools: TOOLS })
    if (!res.ok) return { ok: false, status: res.status, error: res.error, ms: Date.now() - t0 }
    if (!res.toolCalls.length) break

    messages.push(assistantTurn(res.raw))
    for (const call of res.toolCalls.slice(0, MAX_CALLS_PER_ROUND)) {
      const v = validate(call.name, call.argumentsRaw)
      if (!v.ok) {
        // Back to the model as a readable sentence — a bad enum is a retry, not a 500.
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify({ error: v.error }) })
        continue
      }
      let result: ToolResult
      try {
        result = await opts.execute(v.name, v.args)
      } catch (e: unknown) {
        result = { summary: '', tables: [], media: [], unavailable: e instanceof Error ? e.message : 'the tool failed' }
      }
      steps.push({ tool: v.name, args: v.args, chips: describeCall(v.name, v.args, opts.openDate), result })
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: v.name,
        content: JSON.stringify(toModel(result)),
      })
    }
    // Every call in the round was rejected and nothing ran — one retry, then stop.
    if (!steps.length && round >= 1) break
  }

  messages.push({ role: 'user', content: FINAL_INSTRUCTION })
  const final = await opts.chat({ messages, json: true })
  if (!final.ok) return { ok: false, status: final.status, error: final.error, ms: Date.now() - t0 }

  const parsed = extractJson(final.content)
  const answer = verifyAnswer(parsed, steps.map(s => s.result), opts.extraNumbers || [])
  const suggestions = Array.isArray(parsed?.suggestions)
    ? (parsed!.suggestions as unknown[]).filter((s): s is string => typeof s === 'string' && !!s.trim()).slice(0, 3)
    : []

  return { ok: true, answer, steps, suggestions, usedTools: steps.length > 0, ms: Date.now() - t0 }
}

/**
 * What the model is shown of a result: the summary, the tables as compact arrays,
 * and media as one line each. Thumbnails and signed URLs never go into the prompt —
 * they are for the screen, and a model that cannot see a URL cannot invent one.
 */
function toModel(r: ToolResult): Record<string, unknown> {
  if (r.unavailable) return { unavailable: r.unavailable }
  return {
    summary: r.summary,
    tables: r.tables.map(t => ({
      title: t.title,
      columns: t.columns.map(c => (c.unit ? `${c.label} (${c.unit})` : c.label)),
      rows: t.rows,
      ...(t.droppedThin ? { rowsLeftOutForTooFewPhases: t.droppedThin } : {}),
    })),
    media: r.media.map(m => [m.kind, m.date, m.atLocal, m.title, m.conditions, m.note].filter(Boolean).join(' · ')),
  }
}

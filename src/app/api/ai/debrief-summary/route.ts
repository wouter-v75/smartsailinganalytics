// Server-side proxy: meeting transcript → a campaign section's fields, summarised
// by Mistral on Scaleway. The key stays on the server and all inference stays
// inside the Scaleway (EU) account — watertight sandbox, nothing to a third party.
//
// Env (see .env.example):
//   SCALEWAY_AI_API_KEY   — Secret Key
//   SCALEWAY_AI_BASE_URL  — https://api.scaleway.ai/<project>/v1
//   SCALEWAY_AI_MODEL     — defaults to mistral-medium-3.5-128b (measured best of
//                           the six Scaleway models; see __tests__/summaryBench)
//
// POST { transcript: string, mode?: "speedteam"|"debrief"|"planning" }
//   → the mode's field keys, each a markdown string. Defaults to "speedteam".
import { NextRequest, NextResponse } from 'next/server'
import { type Glossary } from '../../../../lib/debriefGlossary'
import { MODES, buildMessages } from '../../../../lib/debriefPrompt'
import { collapseRepeats } from '../../../../lib/transcriptClean'
import { extractJson, stoppedCleanly } from '../../../../lib/debriefJson'
import { cutKeyOf, mergeContinuation, canContinue } from '../../../../lib/debriefContinue'
import { requireActiveUser } from '@/lib/supabase/admin-guard'

// A 75-minute debrief took 45 s on mistral-medium (Maxi Worlds 2026, 10 Sept) — too close
// to the old 55 s abort. 300 s is the Fluid-compute ceiling on every Vercel plan.
export const maxDuration = 300
export const dynamic = 'force-dynamic'
const ABORT_MS = 280_000

const KEY = process.env.SCALEWAY_AI_API_KEY
const BASE = process.env.SCALEWAY_AI_BASE_URL
const MODEL = process.env.SCALEWAY_AI_MODEL || 'mistral-medium-3.5-128b'

const log = (...a: unknown[]) => { try { console.info('[ai/debrief-summary]', ...a) } catch { /* */ } }

export async function GET() {
  const gate = await requireActiveUser()
  if (!gate.ok) return gate.response

  return NextResponse.json({ configured: !!(KEY && BASE), model: MODEL, modes: Object.keys(MODES) })
}

// Render whatever the model chose (string / array of bullets / nested object)
// down to a markdown bullet string. Mistral sometimes returns arrays even when
// asked for a string — this makes the route indifferent to that.
function coerce(v: unknown): string {
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

const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export async function POST(req: NextRequest) {
  const gate = await requireActiveUser()
  if (!gate.ok) return gate.response

  const t0 = Date.now()
  if (!KEY || !BASE) {
    return NextResponse.json({ error: 'SCALEWAY_AI_API_KEY / SCALEWAY_AI_BASE_URL not configured' }, { status: 503 })
  }
  const data = (await req.json().catch(() => null)) as { transcript?: string; mode?: string; glossary?: Partial<Glossary> } | null
  const rawTranscript = data?.transcript?.trim()
  if (!rawTranscript) return NextResponse.json({ error: '"transcript" is required' }, { status: 400 })
  // Strip speech-recogniser repetition loops first. One real debrief repeated a
  // single phrase ~250 times; left in, it dominates the model's attention and the
  // summary comes back thin, missing whole topics discussed elsewhere.
  const cleaned = collapseRepeats(rawTranscript)
  const transcript = cleaned.text || rawTranscript
  const mode = MODES[data?.mode || 'speedteam'] || MODES.speedteam

  const ctrl = new AbortController()
  const killer = setTimeout(() => ctrl.abort(), ABORT_MS)
  try {
    log('summarising', `${transcript.length} chars`, data?.mode || 'speedteam', MODEL,
        cleaned.removed ? `(de-looped ${cleaned.removed} chars; worst ${cleaned.loops[0]?.count}x "${cleaned.loops[0]?.phrase?.slice(0, 40)}")` : '')
    /**
     * One call to the model. The continuation below reuses it unchanged, so the
     * two cannot drift in temperature, model or ceiling.
     */
    const ask = async (messages: unknown[]) => {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 8000,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages,
        }),
        signal: ctrl.signal,
      })
      const text = await r.text()
      if (!r.ok) return { ok: false as const, status: r.status, text }
      let content = '', finishReason: string | undefined
      try {
        const body = JSON.parse(text) as { choices?: { message?: { content?: string }; finish_reason?: string }[] }
        content = body.choices?.[0]?.message?.content || ''
        finishReason = body.choices?.[0]?.finish_reason
      } catch { /* */ }
      return { ok: true as const, content, finishReason }
    }

    const debug = !!req.nextUrl.searchParams.get('debug')
    const baseMessages = buildMessages(data?.mode, transcript, data?.glossary)

    // Case/space-insensitive key lookup so "Speed Learnings" or "speed-learnings"
    // still map onto the canonical DB keys.
    const toResult = (obj: Record<string, unknown>): Record<string, string> => {
      const byNorm: Record<string, unknown> = {}
      for (const k of Object.keys(obj)) byNorm[normKey(k)] = obj[k]
      const out: Record<string, string> = {}
      for (const k of mode.keys) out[k] = coerce(k in obj ? obj[k] : byNorm[normKey(k)])
      return out
    }

    const first = await ask(baseMessages)
    if (!first.ok) {
      log('scaleway error', first.status, first.text.slice(0, 200))
      return NextResponse.json({ error: `scaleway ${first.status}: ${first.text.slice(0, 200)}`, ms: Date.now() - t0 }, { status: 502 })
    }
    const { data: parsed, repaired } = extractJson(first.content)
    // TWO signals, because one was not enough. finish_reason is what the
    // provider SAYS; `repaired` is what the payload SHOWS — a JSON object that
    // never closed was cut, whatever the metadata claims. Baraka's Admiral's Cup
    // debrief stopped mid-sentence with finish_reason reporting something other
    // than 'length', so the repair rescued it and nobody was told.
    let truncated = repaired || !stoppedCleanly(first.finishReason)
    // ALWAYS logged, not only when truncated: this is the field whose real value
    // we could not establish from the published docs, so let the logs say.
    log('finish_reason:', first.finishReason ?? '(none)', repaired ? '· JSON REPAIRED' : '')
    if (!parsed) {
      log('parse failed, head:', first.content.slice(0, 120))
      return NextResponse.json({ error: 'could not parse model JSON', ...(debug ? { _raw: first.content } : {}), ms: Date.now() - t0 }, { status: 502 })
    }

    let result = toResult(parsed)

    // ── ask for the REST ──────────────────────────────────────────────────
    // Raising max_tokens was the obvious move and the wrong one: the ceiling is
    // a TIME budget, and 16000 can spend the whole 280 s and return nothing,
    // which is worse than a short summary. Going round it costs one extra round
    // trip, only on the debriefs that need it, and each call stays well inside
    // the budget. A 75-minute Admiral's Cup meeting needs it; a speed-team note
    // will never reach here.
    let rounds = 0
    while (truncated && canContinue(Date.now() - t0, ABORT_MS, rounds)) {
      // The last key with anything in it is the one that was being written.
      const cutKey = [...mode.keys].reverse().find((k) => (result[k] || '').trim()) ?? cutKeyOf(parsed)
      log('continuing', `round ${rounds + 1}`, 'from', cutKey ?? '(nothing)')
      const more = await ask([
        ...baseMessages,
        { role: 'assistant', content: JSON.stringify(result) },
        {
          role: 'user',
          content: `That reply was CUT OFF — you ran out of room and it stops mid-sentence. `
            + `Continue from exactly where it stopped. Return ONLY valid JSON with the same keys. `
            + (cutKey
              ? `For "${cutKey}", output ONLY the text that still has to follow — do NOT repeat anything already written, and do not re-open a section that is already finished. `
              : '')
            + `Include in full any key you had not started yet. Keep the same layout and the same voice.`,
        },
      ])
      if (!more.ok) { log('continuation failed', more.status); break }
      const { data: moreParsed, repaired: moreRepaired } = extractJson(more.content)
      if (!moreParsed) { log('continuation unparseable — keeping what we have'); break }
      const before = (result[cutKey ?? ''] || '').length
      result = mergeContinuation(result, toResult(moreParsed), cutKey)
      const added = (result[cutKey ?? ''] || '').length - before
      truncated = moreRepaired || !stoppedCleanly(more.finishReason)
      log('continuation', `+${added} chars`, 'finish_reason:', more.finishReason ?? '(none)', truncated ? '· STILL SHORT' : '· complete')
      // A continuation that added nothing will not add anything next time
      // either; stop rather than spending the budget discovering that twice.
      if (added <= 0 && !Object.keys(moreParsed).length) break
      rounds++
    }

    if (truncated) log('TRUNCATED — still incomplete after', rounds, 'continuation(s)')
    log('ok', Date.now() - t0, 'ms', 'filled:', mode.keys.filter((k) => result[k]).length)
    return NextResponse.json({
      ...result,
      ...(truncated ? { _truncated: true } : {}),
      ...(rounds ? { _continued: rounds } : {}),
      ...(debug ? { _raw: first.content } : {}),
      _ms: Date.now() - t0,
    })
  } catch (e: unknown) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    log('exception', aborted ? `aborted (>${ABORT_MS / 1000}s)` : String(e))
    return NextResponse.json(
      { error: aborted ? `summary >${ABORT_MS / 1000}s (aborted)` : (e instanceof Error ? e.message : 'failed'), ms: Date.now() - t0 },
      { status: aborted ? 504 : 500 },
    )
  } finally { clearTimeout(killer) }
}

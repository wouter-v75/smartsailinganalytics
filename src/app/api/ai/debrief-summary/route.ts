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
import { summariseWithContinuation } from '../../../../lib/debriefSummarise'
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
    const out = await summariseWithContinuation({
      ask,
      baseMessages: buildMessages(data?.mode, transcript, data?.glossary),
      keys: mode.keys,
      budgetMs: ABORT_MS,
      startedAt: t0,
      log,
    })

    if (out.error?.kind === 'call') {
      log('scaleway error', out.error.status, (out.error.detail || '').slice(0, 200))
      return NextResponse.json({ error: `scaleway ${out.error.status}: ${(out.error.detail || '').slice(0, 200)}`, ms: Date.now() - t0 }, { status: 502 })
    }
    if (out.error?.kind === 'parse') {
      log('parse failed, head:', out.firstContent.slice(0, 120))
      return NextResponse.json({ error: 'could not parse model JSON', ...(debug ? { _raw: out.firstContent } : {}), ms: Date.now() - t0 }, { status: 502 })
    }

    if (out.truncated) log('TRUNCATED — still incomplete after', out.rounds, 'continuation(s)')
    log('ok', Date.now() - t0, 'ms', 'filled:', mode.keys.filter((k) => out.result[k]).length)
    return NextResponse.json({
      ...out.result,
      ...(out.truncated ? { _truncated: true } : {}),
      ...(out.rounds ? { _continued: out.rounds } : {}),
      ...(debug ? { _raw: out.firstContent } : {}),
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

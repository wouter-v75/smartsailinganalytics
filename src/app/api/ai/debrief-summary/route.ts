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
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        // 4000 silently truncated a real debrief at about 80%: the model hit the
        // ceiling mid-string, extractJson's repair below closed the JSON, and
        // what came back LOOKED like a complete summary with the last note cut
        // off.
        //
        // The ceiling is NOT simply "as large as the context allows". It is a
        // time budget: the model generates at a few tens of tokens a second, so
        // 16000 could run past ABORT_MS and turn a truncated summary into a
        // five-minute wait ending in a 504 — which is worse, because at least
        // the truncated one arrived. 8000 is double the length that was cut and
        // still finishes comfortably inside the budget; anything longer than
        // that is a debrief summary nobody will read anyway, and _truncated
        // below now says so out loud rather than hiding it.
        max_tokens: 8000,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: buildMessages(data?.mode, transcript, data?.glossary),
      }),
      signal: ctrl.signal,
    })
    const raw = await res.text()
    if (!res.ok) {
      log('scaleway error', res.status, raw.slice(0, 200))
      return NextResponse.json({ error: `scaleway ${res.status}: ${raw.slice(0, 200)}`, ms: Date.now() - t0 }, { status: 502 })
    }
    let content = ''
    // `length` means the model stopped because it ran out of room, not because
    // it had finished. That is the ONE thing the caller must not have to guess
    // at: a truncated summary reads as a complete one — the repair in
    // extractJson makes sure of it — so it has to say so out loud.
    let finishReason: string | undefined
    try {
      const body = JSON.parse(raw) as { choices?: { message?: { content?: string }; finish_reason?: string }[] }
      content = body.choices?.[0]?.message?.content || ''
      finishReason = body.choices?.[0]?.finish_reason
    } catch { /* */ }
    const debug = !!req.nextUrl.searchParams.get('debug')
    const { data: parsed, repaired } = extractJson(content)
    // TWO signals, because one was not enough. finish_reason is what the
    // provider SAYS; `repaired` is what the payload SHOWS — a JSON object that
    // never closed was cut, whatever the metadata claims. Baraka's Admiral's Cup
    // debrief stopped mid-sentence with finish_reason reporting something other
    // than 'length', so the repair rescued it and nobody was told.
    const truncated = repaired || !stoppedCleanly(finishReason)
    // ALWAYS logged, not only when truncated: this is the field whose real value
    // we could not establish from the published docs, so let the logs say.
    log('finish_reason:', finishReason ?? '(none)', repaired ? '· JSON REPAIRED' : '')
    if (truncated) log('TRUNCATED — the summary is incomplete')
    if (!parsed) {
      log('parse failed, head:', content.slice(0, 120))
      return NextResponse.json({ error: 'could not parse model JSON', ...(debug ? { _raw: content } : {}), ms: Date.now() - t0 }, { status: 502 })
    }
    // Case/space-insensitive key lookup so "Speed Learnings" or "speed-learnings"
    // still map onto the canonical DB keys.
    const byNorm: Record<string, unknown> = {}
    for (const k of Object.keys(parsed)) byNorm[normKey(k)] = parsed[k]
    const result: Record<string, string> = {}
    for (const k of mode.keys) {
      const raw = k in parsed ? parsed[k] : byNorm[normKey(k)]
      result[k] = coerce(raw)
    }
    log('ok', Date.now() - t0, 'ms', 'filled:', mode.keys.filter((k) => result[k]).length)
    return NextResponse.json({
      ...result,
      ...(truncated ? { _truncated: true } : {}),
      ...(debug ? { _raw: content } : {}),
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

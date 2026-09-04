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

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const KEY = process.env.SCALEWAY_AI_API_KEY
const BASE = process.env.SCALEWAY_AI_BASE_URL
const MODEL = process.env.SCALEWAY_AI_MODEL || 'mistral-medium-3.5-128b'

const log = (...a: unknown[]) => { try { console.info('[ai/debrief-summary]', ...a) } catch { /* */ } }

export async function GET() {
  return NextResponse.json({ configured: !!(KEY && BASE), model: MODEL, modes: Object.keys(MODES) })
}

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const tryParse = (s: string): Record<string, unknown> | null => {
    try { return JSON.parse(s) as Record<string, unknown> } catch { return null }
  }
  let r = tryParse(cleaned)
  if (r) return r
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}')
  if (a >= 0 && b > a) { r = tryParse(cleaned.slice(a, b + 1)); if (r) return r }
  // Repair a truncated object: the model ran out of output tokens mid-string, so the
  // JSON never closed. From the first '{', close an open string + any unbalanced
  // braces and parse — salvages the (cut-off) note instead of failing outright.
  if (a >= 0) {
    let s = cleaned.slice(a).replace(/\\+$/, '')
    const quotes = (s.match(/(?<!\\)"/g) || []).length
    if (quotes % 2 === 1) s += '"'
    const opens = (s.match(/{/g) || []).length, closes = (s.match(/}/g) || []).length
    if (opens > closes) s += '}'.repeat(opens - closes)
    r = tryParse(s); if (r) return r
  }
  return null
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
  const killer = setTimeout(() => ctrl.abort(), 55_000)
  try {
    log('summarising', `${transcript.length} chars`, data?.mode || 'speedteam', MODEL,
        cleaned.removed ? `(de-looped ${cleaned.removed} chars; worst ${cleaned.loops[0]?.count}x "${cleaned.loops[0]?.phrase?.slice(0, 40)}")` : '')
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
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
    try { content = (JSON.parse(raw) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content || '' } catch { /* */ }
    const debug = !!req.nextUrl.searchParams.get('debug')
    const parsed = extractJson(content)
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
    return NextResponse.json({ ...result, ...(debug ? { _raw: content } : {}), _ms: Date.now() - t0 })
  } catch (e: unknown) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    log('exception', aborted ? 'aborted (>55s)' : String(e))
    return NextResponse.json(
      { error: aborted ? 'summary >55s (aborted)' : (e instanceof Error ? e.message : 'failed'), ms: Date.now() - t0 },
      { status: aborted ? 504 : 500 },
    )
  } finally { clearTimeout(killer) }
}

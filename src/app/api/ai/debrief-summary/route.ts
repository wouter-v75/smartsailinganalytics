// Server-side proxy: meeting transcript → a campaign section's fields, summarised
// by Mistral on Scaleway. The key stays on the server and all inference stays
// inside the Scaleway (EU) account — watertight sandbox, nothing to a third party.
//
// Env (see .env.example):
//   SCALEWAY_AI_API_KEY   — Secret Key
//   SCALEWAY_AI_BASE_URL  — https://api.scaleway.ai/<project>/v1
//   SCALEWAY_AI_MODEL     — e.g. mistral-small-3.2-24b-instruct-2506
//
// POST { transcript: string, mode?: "speedteam"|"debrief"|"planning" }
//   → the mode's field keys, each a markdown string. Defaults to "speedteam".
import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const KEY = process.env.SCALEWAY_AI_API_KEY
const BASE = process.env.SCALEWAY_AI_BASE_URL
const MODEL = process.env.SCALEWAY_AI_MODEL || 'mistral-small-3.2-24b-instruct-2506'

const log = (...a: unknown[]) => { try { console.info('[ai/debrief-summary]', ...a) } catch { /* */ } }

// Shared discipline — ported from scripts/speedteam-notes.sh. Each mode adds the
// section-specific keys + guidance. The model returns JSON keyed to the DB columns
// so the summary writes straight into the campaign section.
const RULES = `RULES — these matter:
- OUTPUT LANGUAGE: write the entire summary in ENGLISH. If the transcript is in another language (e.g. Dutch), translate it faithfully — but keep sail names, boat-part and manoeuvre terms, abbreviations (A2, A3, S2, genoa, kite, gybe) and people's names exactly as spoken.
- Use ONLY what is in the transcript. Do not invent numbers, sail names or conclusions.
- If a section has nothing in the transcript, set it to "Nothing recorded." Do not pad it out. An empty section is information; a fabricated one is a liability.
- Where the transcript is garbled but the meaning is clear, use the meaning. Where the meaning is NOT clear, say so briefly, e.g. "(unclear — check the recording)".
- Keep sailing jargon as the team used it — do not water it down into generic plain English.
- Bullet points ("- " each). Terse. This is a working note, not prose.
- Don't guess who *said* what (the transcript has no reliable speaker labels). But DO keep a crew member's name when the content is clearly about them — a job, strength or action point (e.g. "Marc to focus on tactics and mainsail", "Jan to turn faster in the inside gybe").`

const CONTEXT = `The transcript is from a live, in-person sailing-team meeting of several people. It is a raw machine transcript: no speaker labels, it will contain mishearings (especially of sail names, boat parts and numbers), and people talk over each other. Work with what is actually there.`

type Mode = { keys: string[]; prompt: string }
const MODES: Record<string, Mode> = {
  speedteam: {
    keys: ['speed_learnings'],
    prompt: `You are summarising a sailing team's SPEED TEAM meeting for a performance-analysis app.

${CONTEXT}

Return ONLY valid JSON (no markdown fences, no prose outside the JSON) with EXACTLY this one key, a markdown bullet string:
  "speed_learnings"  — The full working note from the meeting. Capture, in this order where present: what the team established about boat speed and setup (what was fast, what was slow, and why — sail combinations, rig settings, modes, conditions, numbers); what they decided to test, try or watch on the water next; and the bigger long-term themes (gear to change, data to gather, questions to resolve over the campaign). Group naturally with short sub-headers or plain bullets — one cohesive note, not separate sections.

${RULES}`,
  },
  debrief: {
    keys: ['learnings'],
    prompt: `You are summarising a sailing team's post-session DEBRIEF for a performance-analysis app.

${CONTEXT}

Return ONLY valid JSON (no markdown fences, no prose outside the JSON) with EXACTLY this one key, a markdown bullet string:
  "learnings"  — The full working note from the debrief. Capture what happened and what was learned this session — what worked, what did not, and WHY — across manoeuvres (sets/hoists, gybes, drops, peels), starts, tactics and communication, boat handling and conditions, plus the concrete focus points to carry into the next session.
  Organise the note under short thematic sub-headers in bold (e.g. "**Upwind**", "**Sets & hoists**", "**Gybes**", "**Drops**", "**Peels**", "**Starts**", "**Tactics & communication**", "**Conditions**", "**Finish & admin**", "**Logistics**", "**Focus next session**") — but ONLY include a sub-header when the transcript actually has content for it, and under each write terse "- " bullets. Do not force material into a header it does not fit.

${RULES}`,
  },
  planning: {
    keys: ['plan', 'timings'],
    prompt: `You are summarising a sailing team's pre-race PLANNING / briefing meeting for a performance-analysis app.

${CONTEXT}

Return ONLY valid JSON (no markdown fences, no prose outside the JSON) with EXACTLY these keys, each a markdown bullet string:
  "plan"      — Today's plan and intent: the areas to focus on, the tests or drills to run, the strategic and tactical calls agreed, conditions expected.
  "timings"   — The schedule as discussed: dock-out, warning signal, first start, and any other time-critical items. If no times were mentioned, set it to "Nothing recorded."

${RULES}`,
  },
}

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
  const data = (await req.json().catch(() => null)) as { transcript?: string; mode?: string } | null
  const transcript = data?.transcript?.trim()
  if (!transcript) return NextResponse.json({ error: '"transcript" is required' }, { status: 400 })
  const mode = MODES[data?.mode || 'speedteam'] || MODES.speedteam

  const ctrl = new AbortController()
  const killer = setTimeout(() => ctrl.abort(), 55_000)
  try {
    log('summarising', `${transcript.length} chars`, data?.mode || 'speedteam', MODEL)
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: mode.prompt },
          { role: 'user', content: `Here is the meeting transcript:\n\n${transcript}` },
        ],
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

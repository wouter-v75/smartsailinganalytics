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
- Use ONLY what is in the transcript. Do not invent numbers, sail names or conclusions.
- If a section has nothing in the transcript, set it to "Nothing recorded." Do not pad it out. An empty section is information; a fabricated one is a liability.
- Where the transcript is garbled but the meaning is clear, use the meaning. Where the meaning is NOT clear, say so briefly, e.g. "(unclear — check the recording)".
- Keep sailing terminology as the team used it. Do not translate jargon into plain English.
- Bullet points ("- " each). Terse. This is a working note, not prose.
- Do not attribute statements to individuals — the transcript has no reliable speaker labels.`

const CONTEXT = `The transcript is from a live, in-person sailing-team meeting of several people. It is a raw machine transcript: no speaker labels, it will contain mishearings (especially of sail names, boat parts and numbers), and people talk over each other. Work with what is actually there.`

type Mode = { keys: string[]; prompt: string }
const MODES: Record<string, Mode> = {
  speedteam: {
    keys: ['speed_learnings', 'speed_focus_today', 'speed_long_term'],
    prompt: `You are summarising a sailing team's SPEED TEAM meeting for a performance-analysis app.

${CONTEXT}

Return ONLY valid JSON (no markdown fences, no prose outside the JSON) with EXACTLY these keys, each a markdown bullet string:
  "speed_learnings"    — What the team established about boat speed and setup: what was fast, what was slow, and why. Concrete and specific: sail combinations, rig settings, modes, conditions, numbers.
  "speed_focus_today"  — What they decided to test, try or watch on the water next. Actionable items only.
  "speed_long_term"    — Bigger themes: gear to change, data to gather, questions to resolve over the campaign.

${RULES}`,
  },
  debrief: {
    keys: ['learnings', 'next_focus'],
    prompt: `You are summarising a sailing team's post-session DEBRIEF for a performance-analysis app.

${CONTEXT}

Return ONLY valid JSON (no markdown fences, no prose outside the JSON) with EXACTLY these keys, each a markdown bullet string:
  "learnings"    — What happened and what was learned this session: what worked, what didn't, manoeuvres, starts, tactics, conditions, mistakes and their causes.
  "next_focus"   — The concrete focus points to carry into the next session. Actionable items only.

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
  try { return JSON.parse(cleaned) as Record<string, unknown> } catch { /* */ }
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}')
  if (a >= 0 && b > a) { try { return JSON.parse(cleaned.slice(a, b + 1)) as Record<string, unknown> } catch { /* */ } }
  return null
}

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
        max_tokens: 2000,
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
    const parsed = extractJson(content)
    if (!parsed) {
      log('parse failed, head:', content.slice(0, 120))
      return NextResponse.json({ error: 'could not parse model JSON', ms: Date.now() - t0 }, { status: 502 })
    }
    const result: Record<string, string> = {}
    for (const k of mode.keys) result[k] = typeof parsed[k] === 'string' ? (parsed[k] as string) : ''
    log('ok', Date.now() - t0, 'ms')
    return NextResponse.json({ ...result, _ms: Date.now() - t0 })
  } catch (e: unknown) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    log('exception', aborted ? 'aborted (>55s)' : String(e))
    return NextResponse.json(
      { error: aborted ? 'summary >55s (aborted)' : (e instanceof Error ? e.message : 'failed'), ms: Date.now() - t0 },
      { status: aborted ? 504 : 500 },
    )
  } finally { clearTimeout(killer) }
}

// Server-side proxy that turns the forecast data into an executive weather &
// strategy brief via Claude. The Anthropic key stays on the server (never shipped
// to the browser). Set ANTHROPIC_API_KEY (or NEXT_PUBLIC_ANTHROPIC_API_KEY) in the
// environment. Returns { typeOfDay, situation, todaysWind, stability, outlook }.
import { NextRequest, NextResponse } from 'next/server'

// LLM calls routinely exceed Vercel's default function timeout (10–15 s), which
// kills the request and surfaces to the client as a timeout. Allow up to 60 s.
export const maxDuration = 60
export const dynamic = 'force-dynamic'

const KEY = process.env.ANTHROPIC_API_KEY || process.env.NEXT_PUBLIC_ANTHROPIC_API_KEY

const SYSTEM = `You are a sailing-race meteorologist writing a concise WEATHER & STRATEGY BRIEF for a racing team's morning meeting. You are given today's forecast data for a venue: an "outlook" by day (TWD/TWS ranges), "today" hourly TWD/TWS at mast height, and a "diagnostics" object computed by a deterministic physics engine.

TREAT "diagnostics" AS GROUND TRUTH. Do not invent figures — phrase the brief around the numbers provided. The diagnostics may include:
  - typeOfDay: pure sea breeze / thermally-enhanced gradient / gradient wind day / funnelled gradient (use verbatim as the regime).
  - seaBreeze: { score 0-10, quadrant (Q1 best … Q3 suppressed), expectedDirFrom, veerToFrom, timing, sbi, crossShoreKt (+offshore), thermalBendDeg, lowLevelKt, deltaT, favourable }.
  - stability: { hMixM (mixed-layer depth), capBaseM, capStrengthC, lapseRateCkm, gate 0-1, hasLowCap }. A low cap suppresses the breeze; a deep well-mixed layer favours it.
  - cloud: { signal -1..1, verdict, note } — insolation / cloud-trend control.
  - confidence: { label HIGH/MODERATE/LOW, sigmaTwd (model spread) }. Light air (<7 kn) caps confidence.
  - funnelling: { flag, cores, rMax } — topographic acceleration near the course.
Any field may be null (missing data) — then speak qualitatively and do not fabricate a number.

Return ONLY valid JSON (no markdown, no prose outside JSON) with exactly these keys.
KEEP EVERYTHING TERSE AND PUNCHY — short phrases, NOT flowing sentences. Bullet-style. Use the actual numbers (kn, °, local times).

SHORT one-line strings (each ≤ ~14 words):
  "typeOfDay":  the regime (use diagnostics.typeOfDay if present).
  "situation":  synoptic/thermal setup, in a phrase.
  "todaysWind": today's wind in a phrase — timing, dir & veer, strength.
  "stability":  boundary-layer depth / cap implication, in a phrase.
  "outlook":    multi-day trend, in a phrase.
  "confidenceNote": confidence label + the single key risk, in a phrase.

ARRAYS of short bullet strings (each bullet ≤ ~12 words, fragments not full sentences):
  "outlookDays":     one bullet PER upcoming day in data order, starting with the day name (e.g. "Sat: NE 10-14 kn, building midday, veering W").
  "generalWeather":  3-4 bullets on the meteorology (surface flow, 925 hPa gradient & separation, cloud, BL mixing, air-SST).
  "strategy":        3-5 TACTICAL bullets for TODAY's racing — favoured side, shifts to play, start bias, pressure/gates, what to watch. Tactics/strategy go ONLY here.
  "notes":           2-4 bullets on TODAY's local effects / hazards (terrain channelling, sea-breeze front, convergence) — NON-tactical.
  "modelComparison": 2-3 bullets on model agreement/spread through the racing window and which to trust.
Any field may be null or [] (missing data) — then omit it; do not fabricate numbers.
Be specific, use the actual numbers (knots, degrees, local times), keep a racing-tactical tone. Concise but complete.`

const MODEL = process.env.ANTHROPIC_FORECAST_MODEL || 'claude-sonnet-4-6'

// Health check — confirms whether the server has the key WITHOUT exposing it.
// GET /api/ai/forecast-summary → { configured, keyVar, model }
export async function GET() {
  return NextResponse.json({
    configured: !!KEY,
    keyVar: process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY'
      : (process.env.NEXT_PUBLIC_ANTHROPIC_API_KEY ? 'NEXT_PUBLIC_ANTHROPIC_API_KEY' : null),
    model: MODEL,
  })
}

export async function POST(req: NextRequest) {
  const t0 = Date.now()
  const log = (...a: unknown[]) => console.log('[ai/forecast-summary]', `+${Date.now() - t0}ms`, ...a)
  if (!KEY) { log('no key'); return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 503 }) }
  let data: unknown
  try { ({ data } = await req.json()) } catch { return NextResponse.json({ error: 'bad request' }, { status: 400 }) }
  log('calling anthropic', MODEL, `payload≈${JSON.stringify(data).length}b`)
  // Abort the upstream call before the function timeout so we can return a clean
  // error (and a timing) instead of the platform killing the request opaquely.
  const ctrl = new AbortController()
  const killer = setTimeout(() => ctrl.abort(), 55000)
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2400,
        system: SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(data) }],
      }),
    })
    log('anthropic responded', res.status)
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      log('anthropic error body', detail.slice(0, 300))
      return NextResponse.json({ error: `anthropic ${res.status}: ${detail.slice(0, 300)}`, ms: Date.now() - t0 }, { status: 502 })
    }
    const j = await res.json()
    const usage = j?.usage ? `${j.usage.input_tokens}in/${j.usage.output_tokens}out` : '?'
    const text = (j.content || []).find((b: { type?: string }) => b.type === 'text')?.text || '{}'
    let parsed
    try { parsed = JSON.parse(text.replace(/```json|```/g, '').trim()) }
    catch (pe) { log('JSON parse failed', String(pe), 'text head:', text.slice(0, 120)); return NextResponse.json({ error: `parse failed (${j?.stop_reason || '?'}, ${usage})`, ms: Date.now() - t0 }, { status: 502 }) }
    log('ok', usage, 'stop:', j?.stop_reason)
    return NextResponse.json({ ...parsed, _ms: Date.now() - t0 })
  } catch (e: unknown) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    log('exception', aborted ? 'aborted (>55s)' : String(e))
    return NextResponse.json({ error: aborted ? 'anthropic call >55s (aborted)' : (e instanceof Error ? e.message : 'failed'), ms: Date.now() - t0 }, { status: aborted ? 504 : 500 })
  } finally { clearTimeout(killer) }
}

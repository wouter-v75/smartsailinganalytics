// Server-side proxy that turns the forecast data into an executive weather &
// strategy brief via Claude. The Anthropic key stays on the server (never shipped
// to the browser). Set ANTHROPIC_API_KEY (or NEXT_PUBLIC_ANTHROPIC_API_KEY) in the
// environment. Returns { typeOfDay, situation, todaysWind, stability, outlook }.
import { NextRequest, NextResponse } from 'next/server'

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
The first group is the SHORT executive-summary lines on slide 1:
  "typeOfDay":  the regime (use diagnostics.typeOfDay if present).
  "situation":  1-2 sentences on the synoptic/thermal setup (use quadrant, cross-shore gradient, stability).
  "todaysWind": 1-2 sentences on the racing-day wind — timing, expected direction & veer, strength, shifts to play.
  "stability":  1 sentence on boundary-layer depth / cap / sounding implications for the sea breeze.
  "outlook":    1 sentence on the multi-day trend.
  "confidenceNote": 1 short sentence pairing the confidence label with the named risk/trigger (model split, marginal breeze, light air).
The second group is fuller PROSE PARAGRAPHS (3-5 sentences each, flowing prose, no bullet lists) for the body slides, written like a professional race-meteorology briefing:
  "generalWeather": the synoptic + meteorology picture — surface flow, 925 hPa gradient and the surface-to-gradient separation, cloud, boundary-layer mixing, air-SST contrast and what it means for the day.
  "modelComparison": how the models agree or differ on TWD/TWS through the racing window, the spread, which to trust, and the resulting uncertainty.
  "sideNotes": local effects, terrain channelling / funnelling, sea-breeze front or convergence positioning, and the tactical triggers to watch (what would change the call).
Any field may be null (missing data) — then speak qualitatively and do not fabricate a number.
Be specific, use the actual numbers (knots, degrees, local times), keep a racing-tactical tone. Concise but complete.`

export async function POST(req: NextRequest) {
  if (!KEY) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 503 })
  let data: unknown
  try { ({ data } = await req.json()) } catch { return NextResponse.json({ error: 'bad request' }, { status: 400 }) }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1300,
        system: SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(data) }],
      }),
    })
    if (!res.ok) return NextResponse.json({ error: `anthropic ${res.status}` }, { status: 502 })
    const j = await res.json()
    const text = (j.content || []).find((b: { type?: string }) => b.type === 'text')?.text || '{}'
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
    return NextResponse.json(parsed)
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 })
  }
}

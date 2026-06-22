// Server-side proxy that turns the forecast data into an executive weather &
// strategy brief via Claude. The Anthropic key stays on the server (never shipped
// to the browser). Set ANTHROPIC_API_KEY (or NEXT_PUBLIC_ANTHROPIC_API_KEY) in the
// environment. Returns { typeOfDay, situation, todaysWind, stability, outlook }.
import { NextRequest, NextResponse } from 'next/server'

const KEY = process.env.ANTHROPIC_API_KEY || process.env.NEXT_PUBLIC_ANTHROPIC_API_KEY

const SYSTEM = `You are a sailing-race meteorologist writing a concise WEATHER & STRATEGY BRIEF for a racing team's morning meeting. You are given today's forecast data for a venue (outlook by day with TWD/TWS ranges, today's hourly TWD/TWS at mast height, boundary-layer-height trend, and a low-level sounding summary).

Return ONLY valid JSON (no markdown, no prose outside JSON) with exactly these keys:
  "typeOfDay":  2-4 words, e.g. "Sea-breeze day", "Gradient day", "Mixed / transitional".
  "situation":  1-2 sentences on the synoptic setup driving the day.
  "todaysWind": 1-2 sentences on the racing-day wind — timing, direction trend (left/right), strength, and any shifts to play.
  "stability":  1 sentence on boundary-layer depth / sounding implications (sea-breeze depth, inversions, gust potential).
  "outlook":    1 sentence on the multi-day trend.
Be specific, use the actual numbers (knots, degrees, local times), and keep a racing-tactical tone. Concise.`

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
        max_tokens: 700,
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

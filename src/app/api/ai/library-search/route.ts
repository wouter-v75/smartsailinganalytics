// Natural-language video-library search — routed through Scaleway Mistral
// (EU-hosted, private) instead of the old browser→Anthropic call. Given the
// clip metadata the user already sees (passed from the client, so no new data
// is exposed) plus a query, it returns the matching clip ids to filter the
// library.
//
// Not logged to ai_query_log: this is a lightweight filter, not the analysis
// Q&A loop, and library search runs without a campaign/team context.
//
//   GET  → { configured }
//   POST { query, clips: [{id,title,date,source,tags,tws,twa,vmg,polperc,vsTargPerc,sog}] }
//        → { matches: string[], explanation, insight }
import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../lib/supabase/server'
import { aiConfigured, mistralJSON, AiError } from '../../../../lib/ai/mistral'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

// Bound the payload so token cost stays predictable.
const MAX_CLIPS = 400

const SYSTEM = `You match a sailing video library against a natural-language query. You are given a JSON array "clips", each: { id, title, date, source, tags[], tws, twa, vmg, polperc, vsTargPerc, sog } (numeric fields may be null: tws=wind kn, twa=angle°, vmg kn, polperc/vsTargPerc=% of target, sog kn). Select the clips matching the query — by tag, conditions (wind/TWA/VMG/speed ranges), date, sail, or title words. Use ONLY the clips provided and match by their "id"; never invent ids.

Return ONLY JSON: { "matches": string[] (matching clip ids, best first; [] if none), "explanation": string (one short sentence on what you matched), "insight": string (optional one-line coaching note, "" if none) }.`

export async function GET() {
  return NextResponse.json({ configured: aiConfigured() })
}

export async function POST(req: NextRequest) {
  const t0 = Date.now()
  if (!aiConfigured()) {
    return NextResponse.json({ error: 'SCALEWAY_AI_API_KEY not configured' }, { status: 503 })
  }

  // Auth-gate so the AI key can't be used anonymously (no DB access needed).
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const query: string | undefined = body?.query?.trim()
  const clips = Array.isArray(body?.clips) ? body.clips.slice(0, MAX_CLIPS) : null
  if (!query || !clips) {
    return NextResponse.json({ error: 'query and clips required' }, { status: 400 })
  }
  if (!clips.length) {
    return NextResponse.json({ matches: [], explanation: 'No clips to search.', insight: '' })
  }

  try {
    const { data } = await mistralJSON<{ matches: string[]; explanation: string; insight: string }>({
      system: SYSTEM,
      user: `QUERY:\n${query}\n\nCLIPS (JSON):\n${JSON.stringify(clips)}`,
      maxTokens: 700,
    })
    // Defensive: only return ids that were actually in the input.
    const ids = new Set(clips.map((c: { id: string }) => c.id))
    const matches = Array.isArray(data.matches) ? data.matches.filter((m) => ids.has(m)) : []
    return NextResponse.json({
      matches,
      explanation: data.explanation || '',
      insight: data.insight || '',
      _ms: Date.now() - t0,
    })
  } catch (e) {
    const status = e instanceof AiError ? e.status : 500
    return NextResponse.json({ error: e instanceof Error ? e.message : 'search failed', _ms: Date.now() - t0 }, { status })
  }
}

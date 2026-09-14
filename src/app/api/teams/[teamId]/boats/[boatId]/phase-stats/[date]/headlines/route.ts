// Written headlines for one day, drafted by Mistral on Scaleway (EU) from the stored
// phase stats + tacks/gybes (lib/headlineFacts). The key stays on the server and all
// inference stays inside the Scaleway account, like /api/ai/debrief-summary.
//
//   POST → { headlines: { headlines, bottomLine, dropped }, model, at, ms }
//
// The model only gets FACTS and must copy numbers from them; validateHeadlines() drops
// any sentence carrying a number that is not in FACTS. The result is stored on the
// session_phase_stats row (0061), which GET …/phase-stats/:date?full=1 returns.
//
// Env: SCALEWAY_AI_API_KEY, SCALEWAY_AI_BASE_URL, SCALEWAY_AI_MODEL (default
// mistral-medium-3.5-128b). RLS: the user's session reads + updates the row.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '../../../../../../../../../lib/supabase/server'
import { expandPhases, type StoredPhase } from '../../../../../../../../../lib/seasonCurves'
import { buildHeadlineFacts, buildHeadlineMessages, validateHeadlines } from '../../../../../../../../../lib/headlineFacts'
import type { Manoeuvre } from '../../../../../../../../../lib/manoeuvres'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const KEY = process.env.SCALEWAY_AI_API_KEY
const BASE = process.env.SCALEWAY_AI_BASE_URL
const MODEL = process.env.SCALEWAY_AI_MODEL || 'mistral-medium-3.5-128b'

type Params = { params: { teamId: string; boatId: string; date: string } }
const log = (...a: unknown[]) => { try { console.info('[phase-stats/headlines]', ...a) } catch { /* */ } }

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json|```/g, '').trim()
  const tryParse = (s: string) => { try { return JSON.parse(s) as Record<string, unknown> } catch { return null } }
  const direct = tryParse(cleaned)
  if (direct) return direct
  const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}')
  return a >= 0 && b > a ? tryParse(cleaned.slice(a, b + 1)) : null
}

export async function POST(_req: NextRequest, { params }: Params) {
  const t0 = Date.now()
  if (!KEY || !BASE) {
    return NextResponse.json({ error: 'SCALEWAY_AI_API_KEY / SCALEWAY_AI_BASE_URL not configured' }, { status: 503 })
  }
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const [{ data: row, error: rowErr }, { data: session }] = await Promise.all([
    supabase
      .from('session_phase_stats')
      .select('id, phases, manoeuvres, polar_name, resolution_s')
      .eq('team_id', params.teamId)
      .eq('boat_id', params.boatId)
      .eq('date', params.date)
      .maybeSingle(),
    supabase
      .from('sessions')
      .select('tz_offset_minutes, meta:xml_data->meta')
      .eq('team_id', params.teamId)
      .eq('boat_id', params.boatId)
      .eq('date', params.date)
      .maybeSingle(),
  ])
  if (rowErr) return NextResponse.json({ error: rowErr.message }, { status: 500 })
  if (!row?.phases || !(row.phases as unknown[]).length) {
    return NextResponse.json({ error: 'no stored stats for this day yet — open it in Analytics first' }, { status: 409 })
  }

  const meta = ((session as any)?.meta || {}) as { boat?: string; location?: string }
  const facts = buildHeadlineFacts({
    date: params.date,
    stats: expandPhases(row.phases as StoredPhase[]),
    manoeuvres: (row.manoeuvres || []) as Manoeuvre[],
    tzOffsetMin: (session as any)?.tz_offset_minutes ?? 0,
    polarName: row.polar_name ?? null,
    resolutionSeconds: row.resolution_s ?? null,
    boat: meta.boat ?? null,
    venue: meta.location ?? null,
  })

  const ctrl = new AbortController()
  const killer = setTimeout(() => ctrl.abort(), 55_000)
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: buildHeadlineMessages(facts),
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
    if (!parsed) return NextResponse.json({ error: 'could not parse model JSON', ms: Date.now() - t0 }, { status: 502 })

    const headlines = validateHeadlines(parsed as { headlines?: unknown; bottomLine?: unknown }, facts)
    log('ok', Date.now() - t0, 'ms', `${headlines.headlines.length} headlines, ${headlines.bottomLine.length} bottom line, ${headlines.dropped.length} dropped`)
    if (!headlines.headlines.length) {
      return NextResponse.json({ error: 'the model wrote no headline that passed the number check', dropped: headlines.dropped, ms: Date.now() - t0 }, { status: 502 })
    }

    const at = new Date().toISOString()
    const { error: saveErr } = await supabase
      .from('session_phase_stats')
      .update({ headlines, headlines_model: MODEL, headlines_at: at })
      .eq('id', row.id)
    if (saveErr) return NextResponse.json({ error: saveErr.message }, { status: 500 })
    return NextResponse.json({ headlines, model: MODEL, at, ms: Date.now() - t0 })
  } catch (e: unknown) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return NextResponse.json(
      { error: aborted ? 'headlines took >55 s (aborted)' : e instanceof Error ? e.message : 'failed', ms: Date.now() - t0 },
      { status: aborted ? 504 : 500 }
    )
  } finally {
    clearTimeout(killer)
  }
}

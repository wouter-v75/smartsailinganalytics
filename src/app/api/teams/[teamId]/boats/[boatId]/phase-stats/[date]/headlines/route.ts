// Written headlines for one day, drafted by Mistral on Scaleway (EU) from the stored
// phase stats + tacks/gybes (lib/headlineFacts), in sections: Start (from the cloud log around
// each gun), Upwind, Downwind, Reaching (when sailed) and Sail shape (lidar). The key stays on the server and all inference
// stays inside the Scaleway account, like /api/ai/debrief-summary.
//
//   POST → { headlines: { version: 2, sections, dropped }, model, at, ms }
//
// The model only gets FACTS and must copy numbers from them; validateSections() drops any
// sentence carrying a number that is not in its section's facts. The result is stored on the
// session_phase_stats row (0061), which GET …/phase-stats/:date?full=1 returns.
// scripts/headlines-backfill.ts writes the same thing for a range of days.
//
// Env: SCALEWAY_AI_API_KEY, SCALEWAY_AI_BASE_URL, SCALEWAY_AI_MODEL (default
// mistral-medium-3.5-128b). RLS: the user's session reads + updates the row.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '../../../../../../../../../lib/supabase/server'
import { STATS_VERSION, expandPhases, type SeasonRow, type StoredPhase } from '../../../../../../../../../lib/seasonCurves'
import { buildHeadlineFacts } from '../../../../../../../../../lib/headlineFacts'
import { generateHeadlines, DEFAULT_HEADLINES_MODEL } from '../../../../../../../../../lib/headlineGenerate'
import type { Manoeuvre } from '../../../../../../../../../lib/manoeuvres'
import { polarFromData } from '../../../../../../../../../lib/polarFile'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const KEY = process.env.SCALEWAY_AI_API_KEY
const BASE = process.env.SCALEWAY_AI_BASE_URL
const MODEL = process.env.SCALEWAY_AI_MODEL || DEFAULT_HEADLINES_MODEL

type Params = { params: { teamId: string; boatId: string; date: string } }
const log = (...a: unknown[]) => { try { console.info('[phase-stats/headlines]', ...a) } catch { /* */ } }

export async function POST(_req: NextRequest, { params }: Params) {
  if (!KEY || !BASE) {
    return NextResponse.json({ error: 'SCALEWAY_AI_API_KEY / SCALEWAY_AI_BASE_URL not configured' }, { status: 503 })
  }
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const [{ data: row, error: rowErr }, { data: session }, { data: polarRow }, { data: seasonData }] = await Promise.all([
    supabase
      .from('session_phase_stats')
      .select('id, phases, manoeuvres, polar_name, resolution_s')
      .eq('team_id', params.teamId)
      .eq('boat_id', params.boatId)
      .eq('date', params.date)
      .maybeSingle(),
    supabase
      .from('sessions')
      .select('tz_offset_minutes, meta:xml_data->meta, sailsUpEvents:xml_data->sailsUpEvents, raceGuns:xml_data->raceGuns, tackJibes:xml_data->tackJibes, startLines:xml_data->startLines, logRows:log_data->rows')
      .eq('team_id', params.teamId)
      .eq('boat_id', params.boatId)
      .eq('date', params.date)
      .maybeSingle(),
    // The active polar: VMG% in the start section.
    supabase
      .from('polars')
      .select('data')
      .eq('team_id', params.teamId)
      .eq('boat_id', params.boatId)
      .eq('is_active', true)
      .maybeSingle(),
    // The boat's stored days: "against this season at the same wind".
    supabase
      .from('session_phase_stats')
      .select('date, phases')
      .eq('team_id', params.teamId)
      .eq('boat_id', params.boatId)
      .eq('stats_version', STATS_VERSION),
  ])
  if (rowErr) return NextResponse.json({ error: rowErr.message }, { status: 500 })
  if (!row?.phases || !(row.phases as unknown[]).length) {
    return NextResponse.json({ error: 'no stored stats for this day yet — open it in Analytics first' }, { status: 409 })
  }

  const s = (session || {}) as {
    tz_offset_minutes?: number | null; meta?: { boat?: string; location?: string } | null
    sailsUpEvents?: unknown[] | null; raceGuns?: unknown[] | null; tackJibes?: unknown[] | null; startLines?: unknown[] | null
    logRows?: { utc: number }[] | null
  }
  const facts = buildHeadlineFacts({
    date: params.date,
    stats: expandPhases(row.phases as StoredPhase[]),
    manoeuvres: (row.manoeuvres || []) as Manoeuvre[],
    tzOffsetMin: s.tz_offset_minutes ?? 0,
    polarName: row.polar_name ?? null,
    resolutionSeconds: row.resolution_s ?? null,
    boat: s.meta?.boat ?? null,
    venue: s.meta?.location ?? null,
    xml: { sailsUpEvents: s.sailsUpEvents || [], raceGuns: s.raceGuns || [], tackJibes: s.tackJibes || [], startLines: s.startLines || [] },
    rows: s.logRows || [],
    polar: polarFromData((polarRow as { data?: unknown } | null)?.data),
    seasonRows: (seasonData || []) as SeasonRow[],
  })

  const result = await generateHeadlines(facts, { key: KEY, base: BASE, model: MODEL })
  if (!result.ok) {
    log('failed', result.status, result.error)
    return NextResponse.json({ error: result.error, dropped: result.dropped, ms: result.ms }, { status: result.status })
  }
  const n = Object.values(result.headlines.sections).reduce((a, x) => a + (x?.headlines.length || 0), 0)
  log('ok', result.ms, 'ms', `${Object.keys(result.headlines.sections).join('/')} · ${n} headlines · ${result.headlines.dropped.length} dropped`)

  const at = new Date().toISOString()
  const { error: saveErr } = await supabase
    .from('session_phase_stats')
    .update({ headlines: result.headlines, headlines_model: result.model, headlines_at: at })
    .eq('id', row.id)
  if (saveErr) return NextResponse.json({ error: saveErr.message }, { status: 500 })
  return NextResponse.json({ headlines: result.headlines, model: result.model, at, ms: result.ms })
}

// Stored 30 s phase averages + tacks/gybes for one session (session_phase_stats, 0060/0061).
//
//   GET                → { stats: summary | null }
//   GET ?full=1        → { stats: summary + phases + manoeuvres + headlines | null }
//   POST [?ifStale=1]  → compute server-side from the stored session (the cloud copy of the log,
//                        a row every ~6 s) with the boat's ACTIVE polar. With ifStale a row that is
//                        current is left as is without reading the log.
//   POST body { phases, manoeuvres, resolution_s, log_rows, polar_id }
//                      → store stats a device computed from its FULL-resolution log (≈1 s).
//                        polar_id must be the boat's active polar.
//
// Either way a row is only written when shouldReplace() allows it — out of date, or computed
// from clearly finer data — so the 6 s cloud copy never overwrites stats from the full log.
// Replacing the stats clears headlines written from the old numbers.
//
// RLS gates everything; we use the user's session, not service-role — a user can only store
// stats for a session they can read. Before the migrations are run the verbs answer
// 503 { needsMigration: true } so the UI can say so instead of failing.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '../../../../../../../../lib/supabase/server'
import { computePhaseStats } from '../../../../../../../../lib/phaseStats'
import { analyseManoeuvres } from '../../../../../../../../lib/manoeuvres'
import { polarFromData } from '../../../../../../../../lib/polarFile'
import {
  STATS_VERSION, compactPhases, compactManoeuvres, medianInterval, shouldReplace, statsAreCurrent,
} from '../../../../../../../../lib/seasonCurves'

type Params = { params: { teamId: string; boatId: string; date: string } }

const SUMMARY = 'date, stats_version, polar_id, polar_name, log_rows, phase_count, resolution_s, computed_at, headlines_at'
const FULL = `${SUMMARY}, phases, manoeuvres, headlines, headlines_model`

// PostgREST: PGRST205 = table not in the schema cache, PGRST204 = column not in it (0061 not run);
// Postgres: 42P01 = undefined table, 42703 = undefined column.
function dbError(error: { code?: string; message: string }) {
  if (['PGRST205', 'PGRST204', '42P01', '42703'].includes(error.code || '')) {
    return NextResponse.json(
      { error: `session_phase_stats not up to date — run migrations 0060 and 0061 (${error.message})`, needsMigration: true },
      { status: 503 }
    )
  }
  return NextResponse.json({ error: error.message }, { status: 500 })
}

export async function GET(req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })
  const full = new URL(req.url).searchParams.get('full') === '1'

  const { data, error } = await supabase
    .from('session_phase_stats')
    .select(full ? FULL : SUMMARY)
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .eq('date', params.date)
    .maybeSingle()
  if (error) return dbError(error)
  return NextResponse.json({ stats: data })
}

interface ClientStats {
  phases: unknown[]
  manoeuvres: unknown[]
  resolution_s: number
  log_rows: number
  polar_id: string | null
}

function readClientStats(body: any): ClientStats | null {
  if (!body || typeof body !== 'object') return null
  if (!Array.isArray(body.phases) || body.phases.length > 5000) return null
  if (!Array.isArray(body.manoeuvres) || body.manoeuvres.length > 500) return null
  if (typeof body.resolution_s !== 'number' || !(body.resolution_s > 0)) return null
  return {
    phases: body.phases,
    manoeuvres: body.manoeuvres,
    resolution_s: body.resolution_s,
    log_rows: Number.isFinite(body.log_rows) ? body.log_rows : 0,
    polar_id: body.polar_id ?? null,
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })
  const ifStale = new URL(req.url).searchParams.get('ifStale') === '1'
  const rawBody = await req.json().catch(() => null)
  const client = readClientStats(rawBody)
  if (rawBody && !client) return NextResponse.json({ error: 'invalid stats body' }, { status: 400 })

  const { data: polarRow, error: polarErr } = await supabase
    .from('polars')
    .select('id, name, data')
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .eq('is_active', true)
    .maybeSingle()
  if (polarErr) return NextResponse.json({ error: polarErr.message }, { status: 500 })
  const polarId = polarRow?.id ?? null
  if (client && (client.polar_id ?? null) !== polarId) {
    return NextResponse.json({ error: 'stats were computed with a polar that is no longer active', activePolarId: polarId }, { status: 409 })
  }

  // The stored row and the session's last change, side by side (no log_data read).
  const [{ data: existing, error: existingErr }, { data: sessionMeta, error: metaErr }] = await Promise.all([
    supabase
      .from('session_phase_stats')
      .select(SUMMARY)
      .eq('team_id', params.teamId)
      .eq('boat_id', params.boatId)
      .eq('date', params.date)
      .maybeSingle(),
    supabase
      .from('sessions')
      .select('id, updated_at')
      .eq('team_id', params.teamId)
      .eq('boat_id', params.boatId)
      .eq('date', params.date)
      .maybeSingle(),
  ])
  if (existingErr) return dbError(existingErr)
  if (metaErr) return NextResponse.json({ error: metaErr.message }, { status: 500 })
  if (!sessionMeta) return NextResponse.json({ error: 'no session for this date' }, { status: 404 })
  const now = { polarId, sessionUpdatedAt: sessionMeta.updated_at ?? null }

  let row: Record<string, unknown>
  if (client) {
    if (!shouldReplace(existing as any, client.resolution_s, now)) {
      return NextResponse.json({ stats: existing, computed: false, reason: 'stored stats are current and at least as fine' })
    }
    row = {
      phases: client.phases,
      manoeuvres: client.manoeuvres,
      phase_count: client.phases.length,
      log_rows: client.log_rows,
      resolution_s: client.resolution_s,
    }
  } else {
    if (ifStale && statsAreCurrent(existing as any, now)) {
      return NextResponse.json({ stats: existing, computed: false })
    }
    const { data: session, error: sessionErr } = await supabase
      .from('sessions')
      .select('log_data, xml_data')
      .eq('id', sessionMeta.id)
      .maybeSingle()
    if (sessionErr) return NextResponse.json({ error: sessionErr.message }, { status: 500 })
    const rows = ((session?.log_data as { rows?: unknown[] } | null)?.rows || []) as any[]
    const resolution = medianInterval(rows)
    if (!shouldReplace(existing as any, resolution, now)) {
      return NextResponse.json({ stats: existing, computed: false, reason: 'stored stats are finer than the cloud log' })
    }
    const stats = computePhaseStats(rows, session?.xml_data, { polar: polarFromData(polarRow?.data) })
    row = {
      phases: compactPhases(stats),
      manoeuvres: compactManoeuvres(analyseManoeuvres(rows, session?.xml_data)),
      phase_count: stats.length,
      log_rows: rows.length,
      resolution_s: resolution,
    }
  }

  const { data, error } = await supabase
    .from('session_phase_stats')
    .upsert(
      {
        team_id: params.teamId,
        boat_id: params.boatId,
        session_id: sessionMeta.id,
        date: params.date,
        stats_version: STATS_VERSION,
        polar_id: polarId,
        polar_name: polarRow?.name ?? null,
        ...row,
        headlines: null,
        headlines_model: null,
        headlines_at: null,
        computed_by_user_id: uid,
        computed_at: new Date().toISOString(),
      },
      { onConflict: 'boat_id,date' }
    )
    .select(SUMMARY)
    .single()
  if (error) return dbError(error)
  return NextResponse.json({ stats: data, computed: true })
}

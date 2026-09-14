// Season reference curves for a boat, from the stored phase averages
// (session_phase_stats, migration 0060; see src/lib/seasonCurves.ts).
//
//   GET [?exclude=YYYY-MM-DD,…][&seasons=2025,2026]
//       → { curves: season → mode → channel → [{ x: TWS bin, y: median, n }],
//           sessions: season → count, phases: season → count,
//           rows: [{ date, season, polar_name, phase_count, computed_at }] }
//
// Only rows at the current STATS_VERSION contribute, so a curve never mixes old and
// new maths. The phases JSONB stays server-side; the client gets the small curves.
// RLS gates the read. Before migration 0060 is run this answers 503 { needsMigration }.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '../../../../../../../lib/supabase/server'
import { STATS_VERSION, seasonCurves, type StoredPhase } from '../../../../../../../lib/seasonCurves'

export async function GET(req: NextRequest, { params }: { params: { teamId: string; boatId: string } }) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const sp = new URL(req.url).searchParams
  const exclude = (sp.get('exclude') || '').split(',').filter(Boolean)
  const seasons = (sp.get('seasons') || '').split(',').map(Number).filter(Number.isFinite).filter(Boolean)

  let q = supabase
    .from('session_phase_stats')
    .select('date, season, polar_name, phase_count, computed_at, phases')
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .eq('stats_version', STATS_VERSION)
    .order('date', { ascending: true })
  if (seasons.length) q = q.in('season', seasons)

  const { data, error } = await q
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') {
      return NextResponse.json(
        { error: 'session_phase_stats table missing — run supabase/migrations/0060_session_phase_stats.sql', needsMigration: true },
        { status: 503 }
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (data || []) as Array<{ date: string; season: number; polar_name: string | null; phase_count: number; computed_at: string; phases: StoredPhase[] }>
  const result = seasonCurves(rows.map(r => ({ date: r.date, phases: r.phases })), { exclude })
  return NextResponse.json({
    ...result,
    rows: rows.map(({ phases: _phases, ...rest }) => rest),
  })
}

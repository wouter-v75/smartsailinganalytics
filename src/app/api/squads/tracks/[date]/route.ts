// Tracks other teams have shared with a squad, for one date.
//
// RLS does the deciding: this selects every session on the date whose
// shared_with_squad is true, and the policy from 0071 returns only the ones the
// caller may actually see. There is no team filter here on purpose — adding one
// would duplicate the access rule in a second place, and the two would drift.
//
// Rows are THINNED SERVER-SIDE. A session's cloud log is about a megabyte, and
// six boats would be six megabytes to draw six reference lines on a map. A
// track that is not the one being analysed only has to show WHERE a boat went;
// the active boat keeps its full resolution and its colour ramps.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '@/lib/supabase/server'

const STEP_MS = 4000

function thin(rows: unknown): Array<{ utc: number; lat: number; lon: number }> {
  if (!Array.isArray(rows)) return []
  const out: Array<{ utc: number; lat: number; lon: number }> = []
  let bucket = -Infinity
  for (const r of rows as Array<Record<string, number>>) {
    const { utc, lat, lon } = r || {}
    if (!Number.isFinite(utc) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const b = Math.floor(utc / STEP_MS)
    if (b === bucket) continue
    bucket = b
    out.push({ utc, lat, lon })
  }
  return out
}

export async function GET(req: NextRequest, { params }: { params: { date: string } }) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('sessions')
    .select('id, team_id, boat_id, log_data, teams(name), boats(name, sail_number)')
    .eq('date', params.date)
    .eq('shared_with_squad', true)

  if (error) {
    if (['PGRST204', '42703', 'PGRST205'].includes(error.code || '')) {
      return NextResponse.json({ tracks: [], needsMigration: true })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // The caller's own boat is excluded by the client, which knows which one is
  // on screen; returning it here would make this route depend on a notion of
  // "active" that belongs to the browser.
  const tracks = (data || []).map((s: any) => ({
    teamId: s.team_id,
    teamName: s.teams?.name ?? null,
    boatId: s.boat_id,
    boatName: s.boats?.name ?? 'Unknown boat',
    sailNumber: s.boats?.sail_number ?? null,
    rows: thin(s.log_data?.rows),
  })).filter((t: { rows: unknown[] }) => t.rows.length > 1)

  return NextResponse.json({ tracks })
}

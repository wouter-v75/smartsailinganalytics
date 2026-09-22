// Tracks other teams have shared with a squad, for one date.
//
// RLS does the deciding: this selects every session on the date whose
// shared_with_squad is true, and the policy from 0074 returns only the ones the
// caller may actually see. There is no team filter here on purpose — adding one
// would duplicate the access rule in a second place, and the two would drift.
//
// ── WHY THIS ROUTE ENFORCES `logdata` AND THE DATABASE DOES NOT ─────────────
//
// Every other squad category is a row-level question, so a policy answers it.
// `logdata` is not: it is the difference between a thinned position track and
// every channel the instruments recorded, which is a question about COLUMNS
// AND SAMPLE RATE INSIDE ONE ROW. Postgres policies are row-level, so this is
// the one rule the schema cannot carry, and 0074's header says so.
//
// That makes this route the single place it is enforced. It asks the database
// rather than re-deriving the answer: squad_shares(team_id, 'logdata') is the
// same SECURITY DEFINER function the policies use, so there is one definition
// of who may see what, not two that drift.
//
// THREE LEVELS, and the default is the cheap one:
//
//   no logdata            utc, lat, lon            thinned to one point / 4 s
//   logdata               + sog, cog               thinned to one point / 4 s
//   logdata + detail=full every channel, untouched, at the logged rate
//
// The map only needs the first — a reference track has to show WHERE a boat
// went. So a plain request stays small (a session's log is about a megabyte,
// and six boats would be six), and a caller that genuinely wants the log asks
// for it. `detail=full` from a team that has not shared logdata silently gets
// the thinned track, which is not a refusal: they were never entitled to more,
// and erroring would tell them what another team has chosen to withhold.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '@/lib/supabase/server'

const STEP_MS = 4000

export type TrackDetail = 'track' | 'speed' | 'full'

/**
 * One point per STEP_MS, keeping the first of each bucket.
 *
 * `extra` carries the channels the viewer is entitled to. Speed and course are
 * one number each per kept point — cheap enough to include whenever logdata is
 * shared, and enough to colour another boat's track by speed rather than
 * drawing it as a bare line.
 */
function thin(
  rows: unknown,
  extra: boolean
): Array<Record<string, number>> {
  if (!Array.isArray(rows)) return []
  const out: Array<Record<string, number>> = []
  let bucket = -Infinity
  for (const r of rows as Array<Record<string, number>>) {
    const { utc, lat, lon } = r || {}
    if (!Number.isFinite(utc) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const b = Math.floor(utc / STEP_MS)
    if (b === bucket) continue
    bucket = b
    const point: Record<string, number> = { utc, lat, lon }
    if (extra) {
      if (Number.isFinite(r.sog)) point.sog = r.sog
      if (Number.isFinite(r.cog)) point.cog = r.cog
    }
    out.push(point)
  }
  return out
}

export async function GET(req: NextRequest, { params }: { params: { date: string } }) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const wantsFull = req.nextUrl.searchParams.get('detail') === 'full'

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

  // Ask once per TEAM, not once per session: several boats in one team share
  // one answer, and this is a round trip each.
  const teamIds = Array.from(new Set((data || []).map((s: any) => s.team_id).filter(Boolean)))
  const sharesLog = new Map<string, boolean>()
  await Promise.all(teamIds.map(async (teamId) => {
    // The same function the policies use. A local re-implementation would be a
    // second copy of the rule, and the two would drift the first time either
    // changed — which is the specific failure this codebase keeps hitting.
    const { data: ok, error: rpcErr } = await supabase.rpc('squad_shares', {
      p_team_id: teamId,
      p_category: 'logdata',
    })
    // Unknown means NO. Failing open on a sharing question would hand out
    // another team's full log because a round trip went wrong.
    sharesLog.set(teamId, rpcErr ? false : ok === true)
  }))

  // The caller's own boat is excluded by the client, which knows which one is
  // on screen; returning it here would make this route depend on a notion of
  // "active" that belongs to the browser.
  const tracks = (data || []).map((s: any) => {
    const mayHaveLog = sharesLog.get(s.team_id) === true
    const full = mayHaveLog && wantsFull
    const rows = full
      ? (Array.isArray(s.log_data?.rows) ? s.log_data.rows : [])
      : thin(s.log_data?.rows, mayHaveLog)
    return {
      teamId: s.team_id,
      teamName: s.teams?.name ?? null,
      boatId: s.boat_id,
      boatName: s.boats?.name ?? 'Unknown boat',
      sailNumber: s.boats?.sail_number ?? null,
      // What this caller actually got, so the client never has to guess
      // whether a missing channel means "withheld" or "not logged".
      detail: (full ? 'full' : mayHaveLog ? 'speed' : 'track') as TrackDetail,
      rows,
    }
  }).filter((t: { rows: unknown[] }) => t.rows.length > 1)

  return NextResponse.json({ tracks })
}

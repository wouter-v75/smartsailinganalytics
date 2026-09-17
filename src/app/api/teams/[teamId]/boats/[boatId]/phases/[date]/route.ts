// Phase sets SSA built for one session (session_phases, migration 0069) — the second
// source of phases alongside the KND event file's own.
//
//   GET     → { active, history }   the set in force for this day, and the ones before it
//   POST    { phases, runs, settings, mode, resolution, note }
//           → upload a set: the previous one is stood down, this becomes active
//   DELETE  → stand the active set down (the rows stay: an upload is reversible)
//
// Writing is COACH AND UP, one step above the TL2 who may build phases on their own
// machine: an upload changes what the rest of the team sees. RLS is the authority —
// this route runs as the user, never with the service key.
//
// The event file's phases are never written here. `mode` records how the two were
// resolved ('add' = the event file stands where they overlap, 'override' = these win
// in their own ranges) so the decision can be explained, or undone, later.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '@/lib/supabase/server'
import { withSettings } from '@/lib/phaseSettings'

type Params = { params: { teamId: string; boatId: string; date: string } }

const SUMMARY = 'id, date, source, phase_len_s, phase_count, resolution_mode, resolution, note, is_active, created_at, created_by_user_id'
const FULL = `${SUMMARY}, settings, runs, phases`

function dbError(error: { code?: string; message: string }) {
  if (['PGRST205', 'PGRST204', '42P01', '42703'].includes(error.code || '')) {
    return NextResponse.json(
      { error: `session_phases not found — run migration 0069 (${error.message})`, needsMigration: true },
      { status: 503 }
    )
  }
  return NextResponse.json({ error: error.message }, { status: 500 })
}

export async function GET(_req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('session_phases')
    .select(FULL)
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .eq('date', params.date)
    .order('created_at', { ascending: false })
  if (error) return dbError(error)

  const rows = data || []
  return NextResponse.json({
    active: rows.find((r: { is_active: boolean }) => r.is_active) || null,
    // History without the phases themselves: a day can hold several uploads.
    history: rows.filter((r: { is_active: boolean }) => !r.is_active)
      .map(({ phases, runs, settings, ...rest }) => rest),   // eslint-disable-line @typescript-eslint/no-unused-vars
  })
}

export async function POST(req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const phases = Array.isArray(body?.phases) ? body.phases : null
  if (!phases?.length) return NextResponse.json({ error: '"phases" is required' }, { status: 400 })
  if (body.mode && !['add', 'override'].includes(body.mode)) {
    return NextResponse.json({ error: 'mode must be "add" or "override"' }, { status: 400 })
  }
  const settings = withSettings(body.settings)

  // The session this day belongs to, when there is one — so deleting a session takes
  // its phases with it rather than leaving them orphaned.
  const { data: session } = await supabase
    .from('sessions')
    .select('id')
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .eq('date', params.date)
    .maybeSingle()

  // One active set per boat and day (partial unique index): stand the old one down
  // first, exactly as a new polar deactivates the previous.
  const { error: deErr } = await supabase
    .from('session_phases')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .eq('date', params.date)
    .eq('is_active', true)
  if (deErr) return dbError(deErr)

  const { data, error } = await supabase
    .from('session_phases')
    .insert({
      team_id: params.teamId, boat_id: params.boatId, session_id: session?.id ?? null,
      date: params.date, source: 'ssa',
      phase_len_s: settings.phaseLenS, settings,
      runs: Array.isArray(body.runs) ? body.runs : [],
      phases, phase_count: phases.length,
      resolution_mode: body.mode ?? null, resolution: body.resolution ?? null,
      note: typeof body.note === 'string' ? body.note : null,
      is_active: true, created_by_user_id: uid,
    })
    .select(FULL)
    .single()
  if (error) return dbError(error)
  return NextResponse.json({ set: data })
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  // Stood down, not deleted: what the team saw yesterday stays on the record.
  const { data, error } = await supabase
    .from('session_phases')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .eq('date', params.date)
    .eq('is_active', true)
    .select('id')
  if (error) return dbError(error)
  return NextResponse.json({ standDown: data?.length || 0 })
}

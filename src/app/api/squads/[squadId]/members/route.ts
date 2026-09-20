// Joining and leaving a squad.
//
// Only a team's OWN manager or coach may enrol it or take it out — enforced by
// the squad_members policy in 0071, not by this route. Nobody enrols a team
// they do not run, and nobody is enrolled without someone on that team saying
// yes.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '@/lib/supabase/server'

type Params = { params: { squadId: string } }

const BOOL_CATEGORIES = [
  'tracks', 'logdata', 'videos', 'photos', 'sailscans', 'comments', 'notes',
] as const

/** Only the categories the policies know about, in the shapes they expect. */
function normaliseShares(raw: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const k of BOOL_CATEGORIES) out[k] = raw[k] === true
  out.tags = raw.tags === 'race' || raw.tags === 'all' ? raw.tags : 'none'
  return out
}

// POST { team_id, status?, shares?, valid_from?, valid_to? }
// Adds a team, or updates its row. `status` is 'active' when a team joins of
// its own accord and 'invited' when an admin is offering it the place.
//
// `shares` is the team's OWN decision about what it contributes, so it is
// written only when present — an admin extending an invitation must not be
// able to preset it, and a later status change must not silently reset it.
export async function POST(req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body?.team_id) return NextResponse.json({ error: 'team_id required' }, { status: 400 })

  const status = ['invited', 'active', 'left'].includes(body.status) ? body.status : 'active'
  const row: Record<string, unknown> = {
    squad_id: params.squadId,
    team_id: body.team_id,
    status,
    valid_from: body.valid_from ?? null,
    valid_to: body.valid_to ?? null,
    invited_by_user_id: uid,
  }
  if (body.shares && typeof body.shares === 'object') {
    // Normalised server-side: a client cannot invent a category, and `tags`
    // cannot arrive as anything but the three values the policy understands.
    row.shares = normaliseShares(body.shares)
  }
  // Only a real decision is recorded as one: an invitation is not consent.
  if (status !== 'invited') {
    row.decided_by_user_id = uid
    row.decided_at = new Date().toISOString()
  }

  const { data, error } = await supabase
    .from('squad_members')
    .upsert(row, { onConflict: 'squad_id,team_id' })
    .select('id, team_id, status, shares, valid_from, valid_to')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 403 })
  return NextResponse.json({ member: data })
}

// DELETE ?team_id=… → leave. The row is kept with status 'left' rather than
// deleted: what was shared while the team was in has been seen, and the record
// of having been a member is part of explaining that.
export async function DELETE(req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const teamId = req.nextUrl.searchParams.get('team_id')
  if (!teamId) return NextResponse.json({ error: 'team_id required' }, { status: 400 })

  const { error } = await supabase
    .from('squad_members')
    .update({ status: 'left', decided_by_user_id: uid, decided_at: new Date().toISOString() })
    .eq('squad_id', params.squadId)
    .eq('team_id', teamId)
  if (error) return NextResponse.json({ error: error.message }, { status: 403 })
  return NextResponse.json({ ok: true })
}

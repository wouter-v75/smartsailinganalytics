// Polars (target / VPP reference) per (team, boat). The polar holds the boat's
// speed/heel/rudder/AWA targets as a grid in `data` JSONB. One active polar per
// boat (DB partial-unique index); older versions are kept for history.
//
//   GET   ?boat_id=…[&active=1]   → the boat's polars (or just the active one).
//   POST  { boat_id, name, source?, valid_from?, data, notes?, activate? }
//                                 → create a polar; activate=true makes it the
//                                   boat's active polar (deactivating the rest).
//
// RLS gates writes to the TL3+ leadership set via the user's server-side session.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../lib/supabase/server'

const SELECT =
  'id,boat_id,name,source,is_active,valid_from,data,notes,created_at,updated_at'

export async function GET(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const boatId = searchParams.get('boat_id')
  const onlyActive = searchParams.get('active') === '1'

  let q = supabase.from('polars').select(SELECT).eq('team_id', params.teamId)
  if (boatId) q = q.eq('boat_id', boatId)
  if (onlyActive) q = q.eq('is_active', true)
  q = q.order('is_active', { ascending: false }).order('valid_from', { ascending: false, nullsFirst: false })

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ polars: data || [] })
}

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body || !body.boat_id || !body.name || !body.data)
    return NextResponse.json({ error: 'boat_id, name and data required' }, { status: 400 })

  const activate = body.activate !== false // default: make the new polar active

  // Only one active polar per boat (DB partial-unique index). Clear the current
  // active one first so the insert below doesn't collide.
  if (activate) {
    const { error: deErr } = await supabase
      .from('polars')
      .update({ is_active: false })
      .eq('team_id', params.teamId)
      .eq('boat_id', body.boat_id)
      .eq('is_active', true)
    if (deErr) return NextResponse.json({ error: deErr.message }, { status: 500 })
  }

  const row = {
    team_id: params.teamId,
    boat_id: body.boat_id,
    name: body.name,
    source: body.source ?? null,
    is_active: activate,
    valid_from: body.valid_from ?? null,
    data: body.data,
    notes: body.notes ?? null,
    created_by_user_id: user.id,
  }
  const { data, error } = await supabase.from('polars').insert(row).select(SELECT).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ polar: data })
}

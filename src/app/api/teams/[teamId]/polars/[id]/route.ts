// Update one polar version.
//
//   PATCH  body { activate?: true, name?, valid_from?, notes? }
//          → activate=true makes this version the boat's active polar (the
//            analytics and Targets tab read the active one) and deactivates the
//            others for the SAME boat. Versions are never deleted here, so the
//            boat keeps its polar history. RLS gates the write to the TL3+ set.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../../lib/supabase/server'

const SELECT =
  'id,boat_id,name,source,is_active,valid_from,data,notes,created_at,updated_at'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { teamId: string; id: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as
    | { activate?: boolean; name?: string; valid_from?: string | null; notes?: string | null }
    | null
  if (!body) return NextResponse.json({ error: 'body required' }, { status: 400 })

  const { data: row, error: readErr } = await supabase
    .from('polars')
    .select('id,boat_id,is_active')
    .eq('id', params.id)
    .eq('team_id', params.teamId)
    .maybeSingle()
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })
  if (!row) return NextResponse.json({ error: 'polar not found' }, { status: 404 })

  const patch: Record<string, unknown> = {}
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim()
  if ('valid_from' in body) patch.valid_from = body.valid_from || null
  if ('notes' in body) patch.notes = body.notes ?? null
  if (body.activate === true) patch.is_active = true
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: 'no writable fields' }, { status: 400 })
  }

  // One active polar per boat (DB partial-unique index): clear the current one first.
  if (body.activate === true && !row.is_active) {
    const { error: deErr } = await supabase
      .from('polars')
      .update({ is_active: false })
      .eq('team_id', params.teamId)
      .eq('boat_id', row.boat_id)
      .eq('is_active', true)
    if (deErr) return NextResponse.json({ error: deErr.message }, { status: 500 })
  }

  const { data, error } = await supabase
    .from('polars')
    .update(patch)
    .eq('id', params.id)
    .eq('team_id', params.teamId)
    .select(SELECT)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ polar: data })
}

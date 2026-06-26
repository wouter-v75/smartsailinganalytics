// Sail inventory per (team, boat). The inventory is SSA-owned master data
// (sail tags that scans link to + certificates), editable by TL3+ (RLS).
//
//   GET   ?boat_id=…              → the boat's sails (inventory + crossover).
//   POST  { boat_id, name, … }    → create a sail.
//   PATCH { id, …fields }         → update a sail (rename / retire / cert / …).
//
// RLS gates writes to the TL3+ leadership set via the user's server-side session.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../lib/supabase/server'

const SELECT =
  'id,boat_id,name,kind,category,sailmaker,design_code,build_date,in_service_date,retired,' +
  'tws_min_kn,tws_max_kn,twa_min_deg,twa_max_deg,certificate_key,certificate_name,specs,notes,updated_at'

// fields a client may set on create/update (whitelist)
const WRITABLE = [
  'name', 'kind', 'category', 'sailmaker', 'design_code', 'build_date',
  'in_service_date', 'retired', 'tws_min_kn', 'tws_max_kn', 'twa_min_deg',
  'twa_max_deg', 'certificate_key', 'certificate_name', 'specs', 'notes',
] as const

function pick(body: any) {
  const out: Record<string, any> = {}
  for (const k of WRITABLE) if (k in body) out[k] = body[k]
  return out
}

export async function GET(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const boatId = searchParams.get('boat_id')

  let q = supabase.from('sails').select(SELECT).eq('team_id', params.teamId)
  if (boatId) q = q.eq('boat_id', boatId)
  q = q.order('retired', { ascending: true }).order('category', { ascending: true })

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ sails: data || [] })
}

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body || !body.boat_id || !body.name)
    return NextResponse.json({ error: 'boat_id and name required' }, { status: 400 })

  const row = {
    team_id: params.teamId,
    boat_id: body.boat_id,
    created_by_user_id: user.id,
    ...pick(body),
  }
  const { data, error } = await supabase.from('sails').insert(row).select(SELECT).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ sail: data })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body || !body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const patch = pick(body)
  if (Object.keys(patch).length === 0)
    return NextResponse.json({ error: 'no writable fields' }, { status: 400 })

  const { data, error } = await supabase
    .from('sails')
    .update(patch)
    .eq('id', body.id)
    .eq('team_id', params.teamId)
    .select(SELECT)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ sail: data })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  // Linked scans keep their data; sail_scans.sail_id is ON DELETE SET NULL.
  const { error } = await supabase.from('sails').delete().eq('id', id).eq('team_id', params.teamId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// POST → create a boat in a team. Body: { name, sail_number?, length_m? }.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../lib/supabase/admin-guard'

// Coerce the request body's length_m value into a sane numeric metres value
// or null. Anything outside 0–100 m (or non-numeric) is treated as cleared —
// the admin UI converts ft→m before posting, so we never see imperial here.
function parseLengthM(input: unknown): number | null {
  if (input == null || input === '') return null
  const n = typeof input === 'number' ? input : parseFloat(String(input))
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null
  return Math.round(n * 100) / 100
}

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as
    | { name?: string; sail_number?: string; length_m?: number | string | null }
    | null
  const name = body?.name?.trim()
  if (!name) {
    return NextResponse.json({ error: 'name required' }, { status: 400 })
  }
  const sail_number = body?.sail_number?.trim() || null
  const length_m = parseLengthM(body?.length_m)

  const service = getServiceSupabase()
  const { data, error } = await service
    .from('boats')
    .insert({ team_id: params.teamId, name, sail_number, length_m })
    .select('id, name, sail_number, length_m, created_at')
    .single()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'boat.create',
    details: { team_id: params.teamId, boat_id: data.id, name },
  })
  return NextResponse.json({ boat: data })
}

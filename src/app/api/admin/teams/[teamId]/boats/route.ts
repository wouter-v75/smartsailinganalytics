// POST → create a boat in a team. Body: { name, sail_number? }.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../lib/supabase/admin-guard'

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as
    | { name?: string; sail_number?: string }
    | null
  const name = body?.name?.trim()
  if (!name) {
    return NextResponse.json({ error: 'name required' }, { status: 400 })
  }
  const sail_number = body?.sail_number?.trim() || null

  const service = getServiceSupabase()
  const { data, error } = await service
    .from('boats')
    .insert({ team_id: params.teamId, name, sail_number })
    .select('id, name, sail_number, created_at')
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

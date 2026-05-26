// PATCH → rename / update sail_number / set length_m. DELETE → cascade.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../../lib/supabase/admin-guard'

// Same length normalisation as the POST route: clamp to a sensible boat
// range or null. Imperial input is converted on the client side, so length
// values arriving here are always metres.
function parseLengthM(input: unknown): number | null {
  if (input == null || input === '') return null
  const n = typeof input === 'number' ? input : parseFloat(String(input))
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null
  return Math.round(n * 100) / 100
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as
    | { name?: string; sail_number?: string | null; length_m?: number | string | null }
    | null
  const update: Record<string, unknown> = {}
  if (body?.name !== undefined) update.name = body.name.trim()
  if (body?.sail_number !== undefined) {
    update.sail_number = body.sail_number?.toString().trim() || null
  }
  if (body && 'length_m' in body) {
    update.length_m = parseLengthM(body.length_m)
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const service = getServiceSupabase()
  const { data, error } = await service
    .from('boats')
    .update(update)
    .eq('id', params.boatId)
    .eq('team_id', params.teamId)
    .select('id, name, sail_number, length_m')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'boat.update',
    details: { team_id: params.teamId, boat_id: params.boatId, ...update },
  })
  return NextResponse.json({ boat: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const service = getServiceSupabase()
  const { error } = await service
    .from('boats')
    .delete()
    .eq('id', params.boatId)
    .eq('team_id', params.teamId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'boat.delete',
    details: { team_id: params.teamId, boat_id: params.boatId },
  })
  return NextResponse.json({ ok: true })
}

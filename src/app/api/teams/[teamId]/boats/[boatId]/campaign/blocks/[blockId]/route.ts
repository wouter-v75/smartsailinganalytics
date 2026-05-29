// Edit or delete a typed block. RLS enforces the write gate.
//
// PATCH  → body { block_type?, label?, seq?, start_min?, end_min?, objective? }
// DELETE → remove the block.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'

const BLOCK_TYPES = [
  'technical-testing',
  'speed-testing',
  'race-training',
  'racing',
  'other',
] as const
type BlockType = (typeof BLOCK_TYPES)[number]

export async function PATCH(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string; blockId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as
    | {
        block_type?: BlockType
        label?: string | null
        seq?: number
        start_min?: number | null
        end_min?: number | null
        objective?: string | null
      }
    | null

  const update: Record<string, unknown> = {}
  if (body?.block_type) {
    if (!BLOCK_TYPES.includes(body.block_type)) {
      return NextResponse.json({ error: 'invalid block_type' }, { status: 400 })
    }
    update.block_type = body.block_type
  }
  if (body && 'label' in body) update.label = body.label ?? null
  if (body && typeof body.seq === 'number') update.seq = body.seq
  if (body && 'start_min' in body) update.start_min = body.start_min ?? null
  if (body && 'end_min' in body) update.end_min = body.end_min ?? null
  if (body && 'objective' in body) update.objective = body.objective ?? null
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('session_blocks')
    .update(update)
    .eq('id', params.blockId)
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .select('id, session_id, block_type, label, seq, start_min, end_min, objective')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ block: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { teamId: string; boatId: string; blockId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { error } = await supabase
    .from('session_blocks')
    .delete()
    .eq('id', params.blockId)
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// Create a typed block within a test day. Multiple blocks per day are allowed.
//
// POST → body { session_id, block_type, label?, seq?, start_min?, end_min?, objective? }
// RLS enforces the coach/tl1/tl2 write gate.

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

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as
    | {
        session_id?: string
        block_type?: BlockType
        label?: string | null
        seq?: number
        start_min?: number | null
        end_min?: number | null
        objective?: string | null
      }
    | null
  if (!body?.session_id || !body?.block_type) {
    return NextResponse.json({ error: 'session_id and block_type required' }, { status: 400 })
  }
  if (!BLOCK_TYPES.includes(body.block_type)) {
    return NextResponse.json({ error: 'invalid block_type' }, { status: 400 })
  }

  // Confirm the session belongs to this team+boat (defence in depth on top of RLS).
  const { data: sess } = await supabase
    .from('sessions')
    .select('id')
    .eq('id', body.session_id)
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .maybeSingle()
  if (!sess) return NextResponse.json({ error: 'session not found' }, { status: 404 })

  const { data, error } = await supabase
    .from('session_blocks')
    .insert({
      session_id: body.session_id,
      team_id: params.teamId,
      boat_id: params.boatId,
      block_type: body.block_type,
      label: body.label ?? null,
      seq: typeof body.seq === 'number' ? body.seq : 0,
      start_min: typeof body.start_min === 'number' ? body.start_min : null,
      end_min: typeof body.end_min === 'number' ? body.end_min : null,
      objective: body.objective ?? null,
      created_by_user_id: user.id,
    })
    .select('id, session_id, block_type, label, seq, start_min, end_min, objective')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ block: data })
}

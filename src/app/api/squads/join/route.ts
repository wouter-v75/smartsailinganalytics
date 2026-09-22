// Redeem a squad join code, for a team you run.
//
// The whole of the decision lives in redeem_squad_code() (0076), a SECURITY
// DEFINER function, for one reason: the redeemer must NOT be able to read
// squad_join_codes. They hold one token and that is all they are entitled to
// know — being able to list the table would turn a capability into a
// directory. The function validates on their behalf and writes the one row.
//
// It creates an INVITED row. Joining — with the categories — stays a separate,
// deliberate act on the team's own Squad panel, so redeeming a code shares
// nothing and cannot be made to.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { code?: string; team_id?: string }
  const code = String(body.code || '').trim()
  if (!code) return NextResponse.json({ error: 'a code is required' }, { status: 400 })
  if (!body.team_id) return NextResponse.json({ error: 'team_id required' }, { status: 400 })

  const { data, error } = await supabase.rpc('redeem_squad_code', {
    p_token: code,
    p_team_id: body.team_id,
  })

  if (error) {
    if (['42883', 'PGRST202'].includes(error.code || '')) {
      return NextResponse.json(
        { error: 'squad codes are not available yet — migration 0076 is not applied', needsMigration: true },
        { status: 503 }
      )
    }
    // The function RAISEs a plain sentence for every refusal it makes —
    // expired, withdrawn, used up, not your team. Pass it through rather than
    // flattening four different situations into one unhelpful "failed".
    return NextResponse.json({ error: error.message || 'that code did not work' }, { status: 400 })
  }

  const { data: squad } = await supabase
    .from('squads')
    .select('id, name')
    .eq('id', data)
    .maybeSingle()

  return NextResponse.json({ squad_id: data, squad_name: squad?.name ?? null })
}

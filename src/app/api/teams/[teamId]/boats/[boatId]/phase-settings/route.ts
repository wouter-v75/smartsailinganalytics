// What a phase has to be to count, on THIS boat (src/lib/phaseSettings.ts).
//
//   GET  → { settings }   the boat's stored thresholds, or null for the app defaults
//   PUT  { settings }     save them — coach and up (RLS on boat_phase_settings)
//
// Per boat because a 37 m maxi and a sportsboat do not hold the same angles, and these
// numbers decide what is allowed to become performance data.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '@/lib/supabase/server'
import { withSettings } from '@/lib/phaseSettings'

type Params = { params: { teamId: string; boatId: string } }

// The table arrives in migration 0069; until it is run, say so rather than failing.
function dbError(error: { code?: string; message: string }) {
  if (['PGRST205', 'PGRST204', '42P01', '42703'].includes(error.code || '')) {
    return NextResponse.json(
      { error: `boat_phase_settings not found — run migration 0069 (${error.message})`, needsMigration: true },
      { status: 503 }
    )
  }
  return NextResponse.json({ error: error.message }, { status: 500 })
}

export async function GET(_req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('boat_phase_settings')
    .select('settings, updated_at, updated_by_user_id')
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .maybeSingle()
  if (error) return dbError(error)
  return NextResponse.json({
    settings: data?.settings ?? null,
    updatedAt: data?.updated_at ?? null,
  })
}

export async function PUT(req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body?.settings) return NextResponse.json({ error: '"settings" is required' }, { status: 400 })
  // Store them cleaned: a junk threshold that reached the table would quietly change
  // what every later build accepts.
  const settings = withSettings(body.settings)

  const { data, error } = await supabase
    .from('boat_phase_settings')
    .upsert({
      boat_id: params.boatId, team_id: params.teamId, settings,
      updated_by_user_id: uid, updated_at: new Date().toISOString(),
    }, { onConflict: 'boat_id' })
    .select('settings, updated_at')
    .single()
  if (error) return dbError(error)
  return NextResponse.json({ settings: data.settings, updatedAt: data.updated_at })
}

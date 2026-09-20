// Squads a user's teams belong to, and creating one.
//
// A squad is an agreement between TEAMS to share tracks, nothing more: it owns
// no boats and no sessions, which is what makes leaving one clean. RLS is the
// authority here as everywhere — this route runs as the user, never with the
// service key.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '@/lib/supabase/server'

function dbError(error: { code?: string; message: string }) {
  if (['PGRST205', 'PGRST204', '42P01', '42703'].includes(error.code || '')) {
    return NextResponse.json(
      { error: `squads not found — run migration 0071 (${error.message})`, needsMigration: true },
      { status: 503 }
    )
  }
  return NextResponse.json({ error: error.message }, { status: 500 })
}

// GET → every squad the caller can see, with its members.
export async function GET() {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('squads')
    .select('id, name, note, created_at, squad_members(id, team_id, status, valid_from, valid_to, teams(name))')
    .order('created_at', { ascending: false })
  if (error) return dbError(error)
  return NextResponse.json({ squads: data || [] })
}

// POST { name, note?, team_id } → create a squad and put that team in it as
// its first ACTIVE member. Creating a squad you are not in would be a squad
// nobody can see, so the founding team is required.
export async function POST(req: NextRequest) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const name = String(body?.name || '').trim()
  const teamId = body?.team_id
  if (!name || !teamId) {
    return NextResponse.json({ error: 'name and team_id required' }, { status: 400 })
  }

  const { data: squad, error } = await supabase
    .from('squads')
    .insert({ name, note: body?.note ?? null, created_by_user_id: uid })
    .select('id, name, note, created_at')
    .single()
  if (error) return dbError(error)

  const { error: memberError } = await supabase.from('squad_members').insert({
    squad_id: squad.id, team_id: teamId, status: 'active',
    invited_by_user_id: uid, decided_by_user_id: uid, decided_at: new Date().toISOString(),
  })
  // The squad exists but the founding team could not be added — almost always
  // because the caller does not run that team. Say so rather than leaving an
  // invisible squad behind.
  if (memberError) {
    await supabase.from('squads').delete().eq('id', squad.id)
    return NextResponse.json(
      { error: `could not add that team to the squad: ${memberError.message}` },
      { status: 403 }
    )
  }
  return NextResponse.json({ squad })
}

// Teams collection.
//   GET  → list teams with basic counts (used by admin pages and forms).
//   POST → create a new team. Body: { name }.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../lib/supabase/server'
import { requireAdmin } from '../../../../lib/supabase/admin-guard'

export async function GET() {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  const service = getServiceSupabase()
  const { data, error } = await service
    .from('teams')
    .select('id, name, created_at')
    .order('name', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ teams: data || [] })
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as
    | { name?: string }
    | null
  const name = body?.name?.trim()
  if (!name) {
    return NextResponse.json({ error: 'name required' }, { status: 400 })
  }

  const service = getServiceSupabase()
  const { data, error } = await service
    .from('teams')
    .insert({ name, created_by_user_id: guard.userId })
    .select('id, name, created_at')
    .single()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'team.create',
    details: { team_id: data.id, name },
  })

  return NextResponse.json({ team: data })
}

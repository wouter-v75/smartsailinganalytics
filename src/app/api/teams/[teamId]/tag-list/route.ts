// Cloud tag list per (team, optional boat).
//
//   GET    ?boat_id=…  → fetch the tag list. Returns [] if none yet.
//   PUT    body: { tags: string[], boat_id?: string | null }
//
// RLS gates this — caller must have boat access. We use the user's auth
// (server-side cookie session) so RLS policies fire, not service-role.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../lib/supabase/server'

export async function GET(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const boatIdParam = searchParams.get('boat_id')
  const boatId = boatIdParam && boatIdParam !== '' ? boatIdParam : null

  let query = supabase
    .from('tag_lists')
    .select('id, tags, updated_at')
    .eq('team_id', params.teamId)
  query = boatId
    ? query.eq('boat_id', boatId)
    : query.is('boat_id', null)

  const { data, error } = await query.maybeSingle()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({
    tags: (data?.tags as string[] | undefined) || [],
    updated_at: data?.updated_at || null,
  })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as
    | { tags?: string[]; boat_id?: string | null }
    | null
  if (!body || !Array.isArray(body.tags)) {
    return NextResponse.json({ error: 'tags[] required' }, { status: 400 })
  }

  const boatId = body.boat_id || null
  // Dedupe + lower-case + drop empties for storage hygiene.
  const tags = Array.from(
    new Set(
      body.tags
        .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
        .filter(Boolean)
    )
  )

  // Upsert by (team_id, boat_id).
  const { data, error } = await supabase
    .from('tag_lists')
    .upsert(
      {
        team_id: params.teamId,
        boat_id: boatId,
        tags,
        updated_by_user_id: user.id,
      },
      { onConflict: 'team_id,boat_id' }
    )
    .select('id, tags, updated_at')
    .single()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ tags: data.tags, updated_at: data.updated_at })
}

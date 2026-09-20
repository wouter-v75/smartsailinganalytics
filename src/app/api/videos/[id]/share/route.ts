// "Shared with the squad", for one videos row.
//
// Its own route rather than a field on the media PUT, for the same reason the
// session flag is sent alone: an ordinary save must never be able to change who
// can see something. This endpoint sets exactly one column and nothing else.
//
// RLS is the authority. It runs as the user, so only somebody with write access
// to the owning boat can change it — a squad partner who can SEE a clip cannot
// re-share it, which is the property that makes sharing safe to grant.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '@/lib/supabase/server'

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (typeof body?.shared_with_squad !== 'boolean') {
    return NextResponse.json({ error: 'shared_with_squad (boolean) required' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('videos')
    .update({ shared_with_squad: body.shared_with_squad })
    .eq('id', params.id)
    .select('id, shared_with_squad')
    .single()

  if (error) {
    if (['PGRST204', '42703'].includes(error.code || '')) {
      return NextResponse.json(
        { error: `shared_with_squad not found — run migration 0072 (${error.message})`, needsMigration: true },
        { status: 503 }
      )
    }
    return NextResponse.json({ error: error.message }, { status: 403 })
  }
  if (!data) return NextResponse.json({ error: 'not found, or not yours to share' }, { status: 404 })
  return NextResponse.json({ videos: data })
}

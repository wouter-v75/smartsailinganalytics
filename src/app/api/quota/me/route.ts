// GET /api/quota/me — return the calling user's storage usage. Used by
// the in-app quota indicator.

import { NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../lib/supabase/server'
import { getQuota } from '../../../../lib/quota'

export async function GET() {
  const ssr = getServerSupabase()
  const {
    data: { user },
  } = await ssr.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })
  const state = await getQuota(user.id)
  if (!state) {
    return NextResponse.json({ error: 'no quota row' }, { status: 404 })
  }
  return NextResponse.json(state)
}

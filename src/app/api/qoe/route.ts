// POST /api/qoe — one playback-quality summary per clip viewed (lib/qoe.ts).
//
// Sent with navigator.sendBeacon, so it carries the session cookie but nobody
// waits for the answer: always 204. Signed-in users only; the row is written
// with the service role (the table has RLS on and no client policies).
// If the table does not exist yet (migration 0057 not applied) the insert
// fails quietly — playback is never affected.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, getServiceSupabase } from '../../../lib/supabase/server'
import { sanitizeQoe } from '../../../lib/qoe'

const done = () => new NextResponse(null, { status: 204 })

export async function POST(req: NextRequest) {
  const { data: { user } } = await getServerSupabase().auth.getUser()
  if (!user) return done()

  let raw: unknown
  try { raw = await req.json() } catch { return done() }
  const row = sanitizeQoe(raw)
  if (!row) return done()

  try {
    const { error } = await getServiceSupabase().from('playback_events').insert({ ...row, user_id: user.id })
    if (error) console.warn('[qoe] insert failed:', error.message)
  } catch (e) {
    console.warn('[qoe] insert threw:', e instanceof Error ? e.message : e)
  }
  return done()
}

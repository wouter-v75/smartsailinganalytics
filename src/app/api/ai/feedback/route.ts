// Feedback capture for the AI query log — the human half of the feedback loop.
//
// A user rates an answer (👍 / 👎) and, optionally, a coach writes the ideal
// answer. Those rated rows in `ai_query_log` become (a) curated few-shot
// candidates for ANALYZE_FEWSHOT, (b) the eval gold set, and (c) — much later,
// if ever — fine-tuning data. Nothing leaves the app.
//
// Authorization is enforced by RLS (ai_query_log_update): the author can rate
// their own row; coaches/team_managers can rate or correct any team row. An
// update that touches no permitted row affects 0 rows → we return 404.
//
//   POST { logId, rating?: 1 | -1 | 0, correction?: string }
//     rating 1 = up, -1 = down, 0 (or null) = clear. Omit to leave unchanged.
//     correction = a coach's ideal answer. Omit to leave unchanged; "" clears.
import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const logId: string | undefined = body?.logId
  if (!logId) return NextResponse.json({ error: 'logId required' }, { status: 400 })

  const patch: Record<string, unknown> = {
    rated_by: user.id,
    rated_at: new Date().toISOString(),
  }

  // rating: 1 | -1 set; 0 or null clears; undefined = leave unchanged.
  if ('rating' in (body ?? {})) {
    const r = body.rating
    if (r === 1 || r === -1) patch.rating = r
    else if (r === 0 || r === null) patch.rating = null
    else return NextResponse.json({ error: 'rating must be 1, -1, or 0' }, { status: 400 })
  }

  // correction: any string sets it; "" clears; undefined = leave unchanged.
  if ('correction' in (body ?? {})) {
    const c = typeof body.correction === 'string' ? body.correction.trim() : ''
    patch.correction = c || null
  }

  if (!('rating' in patch) && !('correction' in patch)) {
    return NextResponse.json({ error: 'provide rating and/or correction' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('ai_query_log')
    .update(patch)
    .eq('id', logId)
    .select('id, rating, correction')
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'not found or not permitted' }, { status: 404 })
  return NextResponse.json({ ok: true, ...data })
}

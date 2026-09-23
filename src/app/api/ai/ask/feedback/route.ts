// 👍 / 👎 on one answer from the Ask box.
//
//   POST { logId, verdict: 1 | -1 | null, note? } → { ok: true }
//
// RLS lets a person update only their own ai_query_log row, so this route needs
// no ownership check of its own — the policy is the check. The 👍 rows are what
// later gets curated into few-shot examples, which is how the answers improve
// without fine-tuning and without breaking Scaleway's zero-retention.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '../../../../../lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { logId, verdict, note } = await req.json().catch(() => ({})) as
    { logId?: string; verdict?: number | null; note?: string }
  if (!logId) return NextResponse.json({ error: 'logId is required' }, { status: 400 })
  if (verdict != null && verdict !== 1 && verdict !== -1) {
    return NextResponse.json({ error: 'verdict must be 1, -1 or null' }, { status: 400 })
  }

  // `rating` / `correction` / `rated_*` keep the names the table already had
  // (0087 adopted them, 0088 dropped the rest). Good names; renaming a column to
  // say the same thing differently is churn.
  const { error } = await supabase
    .from('ai_query_log')
    .update({
      rating: verdict ?? null,
      correction: (note || '').trim().slice(0, 1000) || null,
      rated_by: verdict == null ? null : uid,
      rated_at: verdict == null ? null : new Date().toISOString(),
    })
    .eq('id', logId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

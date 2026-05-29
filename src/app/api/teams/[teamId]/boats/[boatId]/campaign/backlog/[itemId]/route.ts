// Edit or delete a backlog item.
//
// PATCH  → update any editable field, including the loop-closing ones:
//          answer_state (binary items) and progress_pct (progress goals).
//          When answer_state flips to 'answered' we stamp answered_at + status.
// DELETE → remove the item.
//
// RLS enforces the write gate; the UI further restricts editing to the item's
// owning sub-team for non-coach roles.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'

const KINDS = ['action', 'fmea', 'task', 'deliverable', 'milestone']
const STATUSES = ['open', 'in_progress', 'done', 'parked', 'wontfix']
const ANSWER_STATES = ['unanswered', 'partial', 'answered']
const COMPLETIONS = ['binary', 'progress']

export async function PATCH(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string; itemId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!b) return NextResponse.json({ error: 'bad body' }, { status: 400 })

  const update: Record<string, unknown> = {}
  const setStr = (k: string) => {
    if (k in b) update[k] = b[k] == null ? null : String(b[k])
  }
  if (typeof b.title === 'string' && b.title.trim()) update.title = b.title.trim()
  setStr('body')
  if (typeof b.kind === 'string' && KINDS.includes(b.kind)) update.kind = b.kind
  if (typeof b.completion === 'string' && COMPLETIONS.includes(b.completion))
    update.completion = b.completion
  if (typeof b.status === 'string' && STATUSES.includes(b.status)) update.status = b.status
  if ('subteam_id' in b) update.subteam_id = b.subteam_id ?? null
  if ('owner_user_id' in b) update.owner_user_id = b.owner_user_id ?? null
  if ('due_date' in b) update.due_date = b.due_date ?? null
  if ('is_milestone' in b) update.is_milestone = b.is_milestone === true
  if ('priority' in b)
    update.priority = typeof b.priority === 'number' ? b.priority : null
  if ('wind_min_kt' in b)
    update.wind_min_kt = typeof b.wind_min_kt === 'number' ? b.wind_min_kt : null
  if ('wind_max_kt' in b)
    update.wind_max_kt = typeof b.wind_max_kt === 'number' ? b.wind_max_kt : null
  if ('progress_pct' in b)
    update.progress_pct =
      typeof b.progress_pct === 'number'
        ? Math.max(0, Math.min(100, Math.round(b.progress_pct)))
        : null
  if ('meta' in b) update.meta = b.meta ?? null
  // Loop-closing: provenance pointers + the answer tri-state.
  if ('answered_run_id' in b) update.answered_run_id = b.answered_run_id ?? null
  if ('answered_note_id' in b) update.answered_note_id = b.answered_note_id ?? null
  if ('answered_session_id' in b)
    update.answered_session_id = b.answered_session_id ?? null
  if (typeof b.answer_state === 'string' && ANSWER_STATES.includes(b.answer_state)) {
    update.answer_state = b.answer_state
    if (b.answer_state === 'answered') {
      update.answered_at = new Date().toISOString()
      if (!('status' in update)) update.status = 'done'
    } else if (b.answer_state === 'unanswered') {
      update.answered_at = null
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('backlog_items')
    .update(update)
    .eq('id', params.itemId)
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .select('id')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ item: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { teamId: string; boatId: string; itemId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { error } = await supabase
    .from('backlog_items')
    .delete()
    .eq('id', params.itemId)
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

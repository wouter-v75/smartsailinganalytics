// The one prioritised backlog for a boat's campaign.
//
// GET  → list items (with sub-team label embed) ordered by priority then age.
//        The client filters by sub-team / status / kind in the UI.
// POST → create an item. RLS enforces the coach/tl1/tl2 write gate; finer
//        "edit only your own sub-team's items" is enforced in the UI layer.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'

const KINDS = ['action', 'fmea', 'task', 'deliverable', 'milestone'] as const
const COMPLETIONS = ['binary', 'progress'] as const
type Kind = (typeof KINDS)[number]
type Completion = (typeof COMPLETIONS)[number]

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('backlog_items')
    .select(
      'id, kind, subteam_id, title, body, status, priority, owner_user_id, ' +
        'target_session_id, due_date, is_milestone, wind_min_kt, wind_max_kt, ' +
        'completion, answer_state, progress_pct, answered_at, ' +
        'source_note_id, source_run_id, source_clip_id, meta, created_at, updated_at, ' +
        'subteams(id, label, category)'
    )
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .order('priority', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data || [] })
}

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as {
    title?: string
    body?: string | null
    kind?: Kind
    completion?: Completion
    subteam_id?: string | null
    priority?: number | null
    owner_user_id?: string | null
    due_date?: string | null
    is_milestone?: boolean
    wind_min_kt?: number | null
    wind_max_kt?: number | null
    meta?: Record<string, unknown> | null
  } | null

  if (!body?.title?.trim()) {
    return NextResponse.json({ error: 'title required' }, { status: 400 })
  }
  const kind: Kind = KINDS.includes(body.kind as Kind) ? (body.kind as Kind) : 'task'
  const completion: Completion = COMPLETIONS.includes(body.completion as Completion)
    ? (body.completion as Completion)
    : 'binary'

  const { data, error } = await supabase
    .from('backlog_items')
    .insert({
      team_id: params.teamId,
      boat_id: params.boatId,
      kind,
      completion,
      subteam_id: body.subteam_id ?? null,
      title: body.title.trim(),
      body: body.body ?? null,
      priority: typeof body.priority === 'number' ? body.priority : null,
      owner_user_id: body.owner_user_id ?? null,
      due_date: body.due_date ?? null,
      is_milestone: body.is_milestone === true || kind === 'milestone',
      wind_min_kt: typeof body.wind_min_kt === 'number' ? body.wind_min_kt : null,
      wind_max_kt: typeof body.wind_max_kt === 'number' ? body.wind_max_kt : null,
      progress_pct: completion === 'progress' ? 0 : null,
      meta: body.meta ?? null,
      created_by_user_id: user.id,
    })
    .select('id')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ item: data })
}

// The one prioritised backlog for a boat's campaign.
//
// GET  → list items (with sub-team label embed) ordered by priority then age.
//        The client filters by sub-team / status / kind in the UI.
// POST → create an item. RLS enforces the coach/tl1/tl2 write gate; finer
//        "edit only your own sub-team's items" is enforced in the UI layer.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'

const KINDS = ['action', 'task', 'test', 'training', 'fmea', 'deliverable', 'milestone'] as const
const VENUES = ['on-water', 'dock', 'shed']
const COMPLETIONS = ['binary', 'progress'] as const
type Kind = (typeof KINDS)[number]
type Completion = (typeof COMPLETIONS)[number]

export async function GET(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  // `?scope=team` returns items across every boat on the team the caller can
  // see (RLS still filters), so the UI can render a boat chip per row.
  const teamScope = req.nextUrl.searchParams.get('scope') === 'team'

  let q = supabase
    .from('backlog_items')
    .select(
      'id, kind, subteam_id, title, body, status, priority, owner_user_id, ' +
        'target_session_id, due_date, is_milestone, wind_min_kt, wind_max_kt, ' +
        'completion, answer_state, progress_pct, answered_at, tags, venue, ' +
        'source_note_id, source_run_id, source_clip_id, meta, created_at, updated_at, ' +
        'boat_id, boats(name), subteams(id, label, category)'
    )
    .eq('team_id', params.teamId)
    .order('priority', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
  if (!teamScope) q = q.eq('boat_id', params.boatId)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const items = ((data || []) as unknown as Array<Record<string, unknown>>).map((row) => {
    const { boats, ...rest } = row
    return {
      ...rest,
      boat_name: ((boats as { name?: string } | null)?.name) || null,
    }
  })
  return NextResponse.json({ items })
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
    target_session_id?: string | null
    due_date?: string | null
    is_milestone?: boolean
    wind_min_kt?: number | null
    wind_max_kt?: number | null
    venue?: string | null
    tags?: string[]
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
      target_session_id: body.target_session_id ?? null,
      due_date: body.due_date ?? null,
      is_milestone: body.is_milestone === true || kind === 'milestone',
      wind_min_kt: typeof body.wind_min_kt === 'number' ? body.wind_min_kt : null,
      wind_max_kt: typeof body.wind_max_kt === 'number' ? body.wind_max_kt : null,
      venue: VENUES.includes(body.venue as string) ? body.venue : null,
      progress_pct: completion === 'progress' ? 0 : null,
      tags: Array.isArray(body.tags)
        ? Array.from(new Set(body.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)))
        : [],
      meta: body.meta ?? null,
      created_by_user_id: user.id,
    })
    .select('id')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ item: data })
}

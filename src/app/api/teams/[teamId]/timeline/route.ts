// Timeline Tree persistence (Phase 2). Producers build TimelineNode[] client-side
// (t0/t1 as UTC ms) and POST them here to upsert into timeline_nodes; the GET
// returns a boat's nodes (optionally one day) for the timeline projections.
// RLS gates reads to boat-access and writes to the tl1/tl2 crew.
//
//   GET   ?boat_id=…[&date=YYYY-MM-DD]  → { nodes: TimelineNode[] } (t0/t1 in ms)
//   POST  { boat_id, session_id?, session_date?, nodes: TimelineNode[] } → upsert

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../lib/supabase/server'
import type { TimelineNode } from '../../../../../lib/timeline/types'

const SELECT = 'id,parent_id,kind,t0,t1,title,subtitle,source,producer,metrics,meta,session_id,session_date'

const toMs = (v: string) => Date.parse(v)

export async function GET(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const boatId = searchParams.get('boat_id')
  const date = searchParams.get('date')
  if (!boatId) return NextResponse.json({ error: 'boat_id required' }, { status: 400 })

  // latest=1 → just the most recent day that has data (for "focus on last day").
  if (searchParams.get('latest') === '1') {
    const { data, error } = await supabase
      .from('timeline_nodes')
      .select('session_date,t0')
      .eq('team_id', params.teamId).eq('boat_id', boatId)
      .order('t0', { ascending: false }).limit(1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const row = data?.[0]
    const latestDate = row?.session_date || (row?.t0 ? new Date(row.t0).toISOString().slice(0, 10) : null)
    return NextResponse.json({ latestDate })
  }

  let q = supabase.from('timeline_nodes').select(SELECT).eq('team_id', params.teamId).eq('boat_id', boatId)
  if (date) q = q.eq('session_date', date)
  q = q.order('t0', { ascending: true })

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const nodes = (data || []).map((r) => ({
    id: r.id, parentId: r.parent_id, kind: r.kind, t0: toMs(r.t0), t1: toMs(r.t1),
    title: r.title, subtitle: r.subtitle ?? undefined, source: r.source, producer: r.producer,
    metrics: r.metrics ?? undefined, meta: r.meta ?? undefined,
  }))
  return NextResponse.json({ nodes })
}

export async function POST(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const boatId: string | undefined = body?.boat_id
  const nodes: TimelineNode[] = Array.isArray(body?.nodes) ? body.nodes : []
  if (!boatId || !nodes.length) return NextResponse.json({ error: 'boat_id and nodes[] required' }, { status: 400 })

  const now = new Date().toISOString()
  const rows = nodes.map((n) => ({
    id: n.id,
    team_id: params.teamId,
    boat_id: boatId,
    session_id: body?.session_id ?? null,
    session_date: body?.session_date ?? null,
    parent_id: n.parentId ?? null,
    kind: n.kind,
    t0: new Date(n.t0).toISOString(),
    t1: new Date(n.t1).toISOString(),
    title: n.title,
    subtitle: n.subtitle ?? null,
    source: n.source ?? 'auto',
    producer: n.producer ?? 'eventfile',
    metrics: n.metrics ?? null,
    meta: n.meta ?? null,
    updated_at: now,
  }))

  const { error } = await supabase.from('timeline_nodes').upsert(rows, { onConflict: 'id' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, n: rows.length })
}

// A day's tags.
//
//   GET  ?boat_id=…&date=YYYY-MM-DD[&include_rejected=1]  → { events, authors }
//   POST { boat_id, session_date, slug | tag_def_id, at | t0/t1, … }  → { event }
//
// The POST is the crew's one-press path, and it is deliberately the simplest
// thing in the tagger: a trimmer sees a sail change, hits the button, and the
// server works out the window from the definition's lead/lag. Everyone on the
// boat can contribute without anyone owning an analyst's desktop app.
//
// RLS is the authority on who may write what (migration 0062). This route also
// checks the definition's own `min_role` and section, because that is editorial
// policy the crew sets for itself rather than a security boundary — and because
// a clear 403 beats a silent RLS refusal.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { canApplyTagDef, applyBlockedReason } from '@/lib/tagging/gating'
import {
  TAG_EVENT_COLUMNS, TAG_DEF_COLUMNS, toTagEvent, toTagDef,
  toTagEventInsert, windowForPress,
} from '@/lib/tagging/rowMap'
import { identityFor } from '@/lib/tagging/identity'

export async function GET(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const boatId = searchParams.get('boat_id')
  const date = searchParams.get('date')
  if (!boatId) return NextResponse.json({ error: 'boat_id required' }, { status: 400 })

  let q = supabase
    .from('ssa_tag_events')
    .select(TAG_EVENT_COLUMNS)
    .eq('team_id', params.teamId)
    .eq('boat_id', boatId)
  if (date) q = q.eq('session_date', date)
  // Rejected rows are tombstones: kept so a detection cannot come back, hidden
  // unless someone is auditing what was thrown away.
  if (searchParams.get('include_rejected') !== '1') q = q.eq('rejected', false)

  const { data, error } = await q.order('t0', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const events = (data || []).map(toTagEvent)

  // Who placed the hand-made ones. Needed by the duplicate list, which asks
  // whose of two tags to keep and cannot ask that about "somebody". Resolved
  // here rather than in the client because RLS lets a member read a teammate's
  // name (users_select_teammate, 0002) and one lookup beats one per row.
  const ids = Array.from(new Set(
    events
      .filter((e) => e.source === 'human')
      .map((e) => e.createdByUserId || e.ownerUserId)
      .filter((id): id is string => !!id)
  ))
  const authors: Record<string, string> = {}
  if (ids.length) {
    const { data: people } = await supabase.from('users').select('id,name,email').in('id', ids)
    for (const p of people || []) {
      const name = String(p.name || p.email || '').trim()
      if (name) authors[p.id] = name
    }
  }

  return NextResponse.json({ events, authors })
}

export async function POST(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const boatId: string | undefined = body?.boat_id
  const sessionDate: string | undefined = body?.session_date
  if (!boatId || !sessionDate) {
    return NextResponse.json({ error: 'boat_id and session_date required' }, { status: 400 })
  }

  // Find the definition — by id, or by slug within this team/boat.
  let defQuery = supabase.from('ssa_tag_defs').select(TAG_DEF_COLUMNS).eq('team_id', params.teamId)
  if (body?.tag_def_id) defQuery = defQuery.eq('id', body.tag_def_id)
  else if (body?.slug) defQuery = defQuery.eq('slug', body.slug).eq('archived', false)
  else return NextResponse.json({ error: 'tag_def_id or slug required' }, { status: 400 })

  const { data: defRows, error: defErr } = await defQuery.limit(5)
  if (defErr) return NextResponse.json({ error: defErr.message }, { status: 500 })
  if (!defRows?.length) return NextResponse.json({ error: 'No such tag' }, { status: 404 })

  const me = await identityFor(supabase, user.id, params.teamId, boatId)
  // With several definitions sharing a slug (a general one and a section one,
  // say), take the first this user may actually apply.
  const defs = defRows.map(toTagDef)
  const def = defs.find((d) => canApplyTagDef(d, me)) || defs[0]
  if (!canApplyTagDef(def, me)) {
    return NextResponse.json({ error: applyBlockedReason(def, me) || 'Not allowed' }, { status: 403 })
  }

  // `at` is the press instant and the server applies lead/lag; explicit t0/t1
  // is for a tag dragged onto the track, which already knows its window.
  const at = Number(body?.at)
  const hasWindow = Number.isFinite(Number(body?.t0))
  const win = hasWindow
    ? { t0: Number(body.t0), t1: Number.isFinite(Number(body?.t1)) ? Number(body.t1) : Number(body.t0) }
    : Number.isFinite(at)
      ? windowForPress(def, at)
      : null
  if (!win) return NextResponse.json({ error: 'at or t0 required' }, { status: 400 })

  const row = toTagEventInsert({
    teamId: params.teamId,
    boatId,
    sessionId: body?.session_id ?? null,
    sessionDate,
    tagDefId: def.id,
    slug: def.slug,
    label: typeof body?.label === 'string' && body.label.trim()
      ? body.label.trim().slice(0, 120)
      : def.label,
    color: def.color,
    // A private-by-default definition is SHARED vocabulary — everyone sees
    // "Personal note" in the picker — but each application belongs to whoever
    // pressed it, and 0062's RLS then keeps it to them. Without this a personal
    // definition would need an owner, so we would be seeding one per user.
    scope: def.privateByDefault ? 'personal' : def.scope,
    section: def.privateByDefault ? null : def.section,
    ownerUserId: def.privateByDefault || def.scope === 'personal' ? user.id : null,
    t0: Math.min(win.t0, win.t1),
    t1: Math.max(win.t0, win.t1),
    targetKind: body?.target_kind || 'track',
    targetId: body?.target_id ?? null,
    note: body?.note ?? null,
    labels: Array.isArray(body?.labels) ? body.labels : [],
    source: 'human',
    producer: 'user',
    detectionKey: null,
    autoT0: null,
    autoT1: null,
    confidence: null,
    editedFields: [],
    verifiedByUserId: null,
    verifiedAt: null,
    rejected: false,
    rejectedReason: null,
    reelOrder: null,
    createdByUserId: user.id,
    meta: body?.meta ?? null,
  })

  const { data, error } = await supabase
    .from('ssa_tag_events').insert(row).select(TAG_EVENT_COLUMNS).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ event: toTagEvent(data) }, { status: 201 })
}

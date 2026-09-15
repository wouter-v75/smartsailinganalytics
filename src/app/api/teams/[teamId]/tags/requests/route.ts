// What the crew ask for once a moment is tagged.
//
//   GET   ?boat_id=…&date=…[&kind=][&status=]  → { requests, byTag }
//   POST  { tag_event_id, kind, media_kind?, note? }  → ask for something
//   PATCH { id, status?, note?, decision_note?, asset_id? }  → decide or reword
//
// Two kinds, and they are genuinely different animals:
//
//   video    "pull me the clip of this". Needs an approver, because a day makes
//            far more footage than anyone will upload. Approvers are coach /
//            manager / admin AND anyone in the MEDIA section — the drone
//            operator has the footage and should not need a coach's sign-off to
//            hand over something they are holding.
//
//   debrief  "let's talk about this tonight". No approver at all. Nomination is
//            open to everyone who sails, the nominations ARE the shortlist, and
//            the coach picking one onto the reel is the approval.
//
// Because nominating is open, several people asking about the same gybe is the
// strongest signal a shortlist has — so the GET counts votes per tag rather than
// just listing rows.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { TAG_REQUEST_COLUMNS, toTagRequest } from '@/lib/tagging/rowMap'
import { identityFor } from '@/lib/tagging/identity'
import { canApproveMedia, canCurateReel } from '@/lib/tagging/requests'
import type { RequestKind } from '@/lib/tagging/types'

export async function GET(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const boatId = searchParams.get('boat_id')
  const date = searchParams.get('date')
  if (!boatId) return NextResponse.json({ error: 'boat_id required' }, { status: 400 })

  let q = supabase
    .from('ssa_tag_requests').select(TAG_REQUEST_COLUMNS)
    .eq('team_id', params.teamId).eq('boat_id', boatId)
  if (date) q = q.eq('session_date', date)
  const kind = searchParams.get('kind')
  if (kind) q = q.eq('kind', kind)
  const status = searchParams.get('status')
  if (status) q = q.eq('status', status)

  const { data, error } = await q.order('requested_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const requests = (data || []).map(toTagRequest)

  // Per-tag rollup: what the shortlist and the video queue actually render.
  const byTag: Record<string, { debriefVotes: number; videoPending: number; mine: RequestKind[] }> = {}
  for (const r of requests) {
    const b = byTag[r.tagEventId] || (byTag[r.tagEventId] = { debriefVotes: 0, videoPending: 0, mine: [] })
    if (r.kind === 'debrief' && r.status !== 'declined') b.debriefVotes++
    if (r.kind === 'video' && (r.status === 'open' || r.status === 'approved')) b.videoPending++
    if (r.requestedByUserId === user.id) b.mine.push(r.kind)
  }

  const me = await identityFor(supabase, user.id, params.teamId, boatId)
  return NextResponse.json({
    requests,
    byTag,
    can: { approveVideo: canApproveMedia(me), curateReel: canCurateReel(me) },
  })
}

export async function POST(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const tagEventId = String(body?.tag_event_id || '')
  const kind = String(body?.kind || '') as RequestKind
  if (!tagEventId || (kind !== 'video' && kind !== 'debrief')) {
    return NextResponse.json({ error: 'tag_event_id and kind (video|debrief) required' }, { status: 400 })
  }

  // The tag decides the boat and the day, so a request cannot be misfiled — and
  // reading it first means RLS has already checked the caller can see it.
  const { data: tagRow } = await supabase
    .from('ssa_tag_events').select('id,team_id,boat_id,session_date,scope')
    .eq('team_id', params.teamId).eq('id', tagEventId).maybeSingle()
  if (!tagRow) return NextResponse.json({ error: 'No such tag' }, { status: 404 })

  // A personal tag is already private to you; asking the team about something
  // they cannot see would only produce confusion.
  if (tagRow.scope === 'personal') {
    return NextResponse.json(
      { error: 'Make this a team comment first — nobody else can see a personal note.' },
      { status: 400 }
    )
  }

  const row = {
    team_id: params.teamId,
    boat_id: tagRow.boat_id,
    session_date: tagRow.session_date,
    tag_event_id: tagEventId,
    kind,
    media_kind: kind === 'video' ? (body?.media_kind || 'video') : null,
    status: 'open',
    note: body?.note ?? null,
    requested_by_user_id: user.id,
  }

  const { data, error } = await supabase
    .from('ssa_tag_requests')
    // Asking twice is editing your own request, not an error — and it keeps the
    // vote count honest.
    .upsert(row, { onConflict: 'tag_event_id,kind,requested_by_user_id' })
    .select(TAG_REQUEST_COLUMNS).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ request: toTagRequest(data) }, { status: 201 })
}

export async function PATCH(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const id = String(body?.id || '')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { data: existing } = await supabase
    .from('ssa_tag_requests').select(TAG_REQUEST_COLUMNS)
    .eq('team_id', params.teamId).eq('id', id).maybeSingle()
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const request = toTagRequest(existing)

  const me = await identityFor(supabase, user.id, params.teamId, request.boatId)
  const isMine = request.requestedByUserId === user.id
  const mayDecide = request.kind === 'video' ? canApproveMedia(me) : canCurateReel(me)

  const patch: Record<string, unknown> = {}

  // Rewording your own request needs no permission.
  if ('note' in (body || {}) && isMine) patch.note = body.note ?? null

  if (body?.status && body.status !== request.status) {
    if (!mayDecide && !(isMine && body.status === 'declined')) {
      return NextResponse.json(
        { error: request.kind === 'video'
            ? 'Approving footage is for a coach, manager or the media team.'
            : 'Selecting what gets debriefed is the coach’s call.' },
        { status: 403 }
      )
    }
    patch.status = body.status
    patch.decided_by_user_id = user.id
    patch.decided_at = new Date().toISOString()
    if (body?.decision_note != null) patch.decision_note = body.decision_note
  }

  if (body?.asset_id != null && mayDecide) {
    patch.asset_id = body.asset_id
    patch.asset_kind = body?.asset_kind ?? request.mediaKind
    // Handing over the asset is what "fulfilled" means; saying so explicitly
    // saves the media team a second call.
    if (!patch.status) patch.status = 'fulfilled'
  }

  if (!Object.keys(patch).length) return NextResponse.json({ request, changed: false })

  const { data, error } = await supabase
    .from('ssa_tag_requests').update(patch).eq('id', id)
    .select(TAG_REQUEST_COLUMNS).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ request: toTagRequest(data), changed: true })
}

export async function DELETE(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await supabase
    .from('ssa_tag_requests').delete().eq('team_id', params.teamId).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ deleted: true })
}

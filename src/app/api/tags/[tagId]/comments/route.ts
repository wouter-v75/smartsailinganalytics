// Squad comments on one tagged moment.
//
// THE ONLY CROSS-TEAM WRITE IN SSA. Everywhere else, a squad partner reads and
// nothing more. Here a coach from another team can say something about your
// tack — which is the entire point of a squad debrief, and is why migration
// 0074 gave it its own table rather than letting anyone near ssa_tag_events.
// They can add a comment; they cannot touch the tag, the session, or anything
// else, and only the author can edit or delete their own words.
//
// RLS IS THE AUTHORITY, as everywhere. This route runs as the user, so
// squad_comments_select and squad_comments_insert decide what comes back and
// what is allowed in. Three things are NOT taken from the caller, because a
// client that could set them would be choosing which policy governs its own
// row:
//
//   author_user_id  — set by the trigger from auth.uid()
//   owner_team_id   — set by the trigger, read off the tag
//   squad_id        — resolved here, from the squad the two teams share
//
// The caller supplies only `body` and which of THEIR OWN teams they are
// speaking for; `has_team_role(author_team_id, …)` in the policy refuses a
// team they do not belong to.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '@/lib/supabase/server'

type Params = { params: { tagId: string } }

const SELECT =
  'id, tag_event_id, owner_team_id, author_user_id, author_team_id, body, created_at, updated_at,' +
  ' author:users!squad_comments_author_user_id_fkey(name, email),' +
  ' team:teams!squad_comments_author_team_id_fkey(name)'

const MAX_BODY = 4000

/** A missing table means 0074 has not been applied — say so rather than "500". */
function dbError(error: { code?: string; message?: string }) {
  if (['42P01', 'PGRST205', 'PGRST204', '42703'].includes(error.code || '')) {
    return NextResponse.json({ comments: [], needsMigration: true })
  }
  return NextResponse.json({ error: error.message }, { status: 500 })
}

export async function GET(_req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('squad_comments')
    .select(SELECT)
    .eq('tag_event_id', params.tagId)
    .order('created_at', { ascending: true })

  if (error) return dbError(error)
  return NextResponse.json({ comments: data || [], viewerId: uid })
}

export async function POST(req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const payload = await req.json().catch(() => null)
  const body = String(payload?.body ?? '').trim()
  const authorTeamId = payload?.author_team_id
  if (!body) return NextResponse.json({ error: 'a comment needs some words' }, { status: 400 })
  if (body.length > MAX_BODY) {
    return NextResponse.json({ error: `keep it under ${MAX_BODY} characters` }, { status: 400 })
  }
  if (!authorTeamId) {
    return NextResponse.json({ error: 'author_team_id required' }, { status: 400 })
  }

  // The tag tells us whose it is. Reading it runs through the tag's OWN
  // policies, so a tag the caller cannot see is simply not found — the comment
  // route never becomes a way to probe for tags.
  const { data: tag, error: tagErr } = await supabase
    .from('ssa_tag_events')
    .select('id, team_id')
    .eq('id', params.tagId)
    .maybeSingle()
  if (tagErr) return dbError(tagErr)
  if (!tag) return NextResponse.json({ error: 'no such tag, or not visible to you' }, { status: 404 })

  // Which squad is this conversation happening in? The one both teams are
  // active in. Commenting on your OWN team's tag needs no squad relationship,
  // so fall back to any squad the author's team is in — the row still has to
  // satisfy squad_comments_insert either way.
  const { data: mine } = await supabase
    .from('squad_members')
    .select('squad_id')
    .eq('team_id', authorTeamId)
    .eq('status', 'active')
  const myIds = (mine || []).map((m) => m.squad_id)
  if (!myIds.length) {
    return NextResponse.json(
      { error: 'your team is not in a squad, so there is nobody to comment to' },
      { status: 403 }
    )
  }

  let squadId = myIds[0]
  if (tag.team_id !== authorTeamId) {
    const { data: theirs } = await supabase
      .from('squad_members')
      .select('squad_id')
      .eq('team_id', tag.team_id)
      .eq('status', 'active')
      .in('squad_id', myIds)
    if (!theirs?.length) {
      return NextResponse.json(
        { error: 'you do not share a squad with the team that owns this tag' },
        { status: 403 }
      )
    }
    squadId = theirs[0].squad_id
  }

  const { data, error } = await supabase
    .from('squad_comments')
    .insert({
      squad_id: squadId,
      tag_event_id: params.tagId,
      author_team_id: authorTeamId,
      body,
      // owner_team_id and author_user_id are set by the trigger (0074).
      owner_team_id: tag.team_id,
      author_user_id: uid,
    })
    .select(SELECT)
    .single()

  if (error) {
    const denied = /row-level security/i.test(error.message || '')
    return NextResponse.json(
      {
        error: denied
          ? 'that team does not share comments with your squad, or you may not post for this team'
          : error.message,
      },
      { status: denied ? 403 : 500 }
    )
  }
  return NextResponse.json({ comment: data })
}

// DELETE ?id=… — your own words only. The policy enforces it; this just names
// which row. A team that dislikes a comment on its tag un-shares the category
// rather than deleting somebody else's sentence.
export async function DELETE(req: NextRequest, { params }: Params) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { data, error } = await supabase
    .from('squad_comments')
    .delete()
    .eq('id', id)
    .eq('tag_event_id', params.tagId)
    .select('id')
  if (error) return dbError(error)
  if (!data?.length) {
    return NextResponse.json({ error: 'not found, or not yours to delete' }, { status: 403 })
  }
  return NextResponse.json({ deleted: data[0].id })
}

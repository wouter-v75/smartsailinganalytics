// The day's comments — what the crew actually said, with who said it.
//
//   GET ?boat_id=…&date=YYYY-MM-DD  → { comments, me }
//
// A comment is not its own table and should not be: somebody presses "Team
// comment" and types, or types a line onto the tack they made a mess of. Both
// are a person saying something about a moment, so a comment is any hand-placed
// tag carrying text (see src/lib/tagging/comments.ts) rather than a particular
// slug — a rule that cannot be broken by adding a button.
//
// This route exists for the ONE thing the client cannot do for itself: turn a
// created_by_user_id into a name. The tagger's own views never needed it (you
// know what you tagged), but a timeline column headed "Sam" is a different fact
// from one headed "somebody", and RLS lets a member read a teammate's name
// (users_select_teammate, 0002) — so the join happens here, once, rather than
// as one fetch per card.
//
// Nothing is widened: the tag rows come back through the same RLS as everywhere
// else, so a personal note reaches its author and nobody else.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { TAG_EVENT_COLUMNS, toTagEvent } from '@/lib/tagging/rowMap'
import { commentsOf, authorOf } from '@/lib/tagging/comments'

export async function GET(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const boatId = searchParams.get('boat_id')
  const date = searchParams.get('date')
  if (!boatId) return NextResponse.json({ error: 'boat_id required' }, { status: 400 })

  let q = supabase
    .from('ssa_tag_events').select(TAG_EVENT_COLUMNS)
    .eq('team_id', params.teamId).eq('boat_id', boatId)
    .eq('rejected', false)
  if (date) q = q.eq('session_date', date)

  const { data, error } = await q.order('t0', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const events = (data || []).map(toTagEvent)
  // Only the authors of rows that survived the comment filter, so a day of 140
  // detections does not turn into a 140-id lookup.
  const ids = Array.from(new Set(
    events.filter((e) => !e.rejected && e.source === 'human' && String(e.note ?? '').trim())
      .map(authorOf).filter((id): id is string => !!id)
  ))
  const names = new Map<string, string>()
  if (ids.length) {
    const { data: people } = await supabase.from('users').select('id,name,email').in('id', ids)
    for (const p of people || []) {
      // A member who never set a name still has an email, and firstName() reads
      // its local part rather than rendering a card with nobody on it.
      names.set(p.id, String(p.name || p.email || '').trim())
    }
  }

  return NextResponse.json({
    comments: commentsOf(events, (id) => names.get(id) ?? null),
    me: user.id,
  })
}

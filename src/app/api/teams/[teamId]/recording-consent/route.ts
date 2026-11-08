// /api/teams/[teamId]/recording-consent
//
//   GET  → has everyone who will be in this team's debrief agreed to be recorded?
//   POST → set MY OWN consent (body { consent: boolean }), then answer the same
//          question again.
//
// Uses the user's own session rather than the service role, so the membership
// check inside team_recording_consent() fires against the real auth.uid(). That
// function is SECURITY DEFINER (it has to read teammates' consent flags) and
// raises for a caller who is not in the team, which is why this route does not
// need a team guard of its own beyond requiring a live session.
//
// It deliberately returns the NAMES of people who have not answered. A coach who
// is told "someone has not agreed" and cannot find out who is being given a
// puzzle rather than a next step — and those names are already visible to any
// teammate through users_select_teammate.
//
// WHY THE WRITE LIVES ON A TEAM URL. It writes one column of the caller's own
// row, which is the profile page's job; but the only reason to call it here is to
// unblock THIS team's recorder, and the useful answer is the recomputed gate, not
// "ok". Migration 0078's trigger owns recording_consent_at, so no timestamp is
// sent and none can be forged. The write goes through users_update_self under
// RLS: a caller can only ever change their own flag, whatever they put in the URL.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../lib/supabase/server'

type Supa = ReturnType<typeof getServerSupabase>

async function answer(supabase: Supa, teamId: string) {
  const { data, error } = await supabase
    .rpc('team_recording_consent', { p_team_id: teamId })
    .maybeSingle()

  if (error) {
    // The function raises for a non-member; that is a 403, not a server fault.
    const denied = /not a member/i.test(error.message)
    return NextResponse.json(
      { error: denied ? 'forbidden' : error.message },
      { status: denied ? 403 : 500 },
    )
  }

  const row = (data ?? { total: 0, consented: 0, pending_names: [] }) as {
    total: number; consented: number; pending_names: string[] | null; you_consented?: boolean | null
  }

  // null, NOT false, when the database has not got 0105 yet: the column is
  // simply absent from the row. The recorder reads a false as "the person still
  // to agree is YOU" and offers them the tick box — which, against the old
  // function, would write a consent they already had and then refuse them again
  // on the same screen, for ever. Unknown has to stay unknown, so a deploy that
  // lands before the migration falls back to the message that at least points
  // somewhere.
  const you = 'you_consented' in row ? row.you_consented === true : null

  return NextResponse.json({
    total: row.total,
    consented: row.consented,
    // The OTHER people still to answer. The caller's own flag is separate
    // (youConsented) so the recorder can offer them the tick box instead of
    // listing their own name back at them.
    pending: row.pending_names ?? [],
    youConsented: you,
    // A team with nobody in it is not "all consented" — there is nobody to have
    // consented. Since 0105 counts the caller, a real member never sees total 0;
    // this is left as the belt for an admin probing a team they are not in.
    // The recorder treats false as "do not run".
    allConsented: row.total > 0 && row.consented === row.total,
  })
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  return answer(supabase, params.teamId)
}

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { consent?: unknown } | null
  // Consent is affirmative, so it is only ever an explicit boolean. Anything
  // else — missing, a string, null — is refused rather than read as agreement.
  if (typeof body?.consent !== 'boolean') {
    return NextResponse.json({ error: 'consent must be true or false' }, { status: 400 })
  }

  const { error } = await supabase
    .from('users')
    .update({ recording_consent: body.consent })
    .eq('id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return answer(supabase, params.teamId)
}

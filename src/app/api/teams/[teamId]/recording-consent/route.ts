// GET /api/teams/[teamId]/recording-consent
//
// Answers one question for the team debrief recorder: has everyone who could be
// in the room agreed to be recorded?
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

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../lib/supabase/server'

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .rpc('team_recording_consent', { p_team_id: params.teamId })
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
    total: number; consented: number; pending_names: string[] | null
  }
  const pending = row.pending_names ?? []

  return NextResponse.json({
    total: row.total,
    consented: row.consented,
    pending,
    // A team with no active members yet is not "all consented" — there is
    // nobody to have consented. The recorder treats false as "do not run".
    allConsented: row.total > 0 && row.consented === row.total,
  })
}

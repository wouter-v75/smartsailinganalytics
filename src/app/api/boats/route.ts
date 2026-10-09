// Every boat this caller can see, for choosing one in SailTrim.
//
//   GET → { boats: [{ id, name, sailNumber, teamName, hasRigModel }] }
//
// Across teams, not one team's: the tab is opened from the Tools list, from a
// photo and from the timeline, and only some of those know a team. RLS does the
// gating — boats_select returns what the caller may see and nothing else.
//
// `hasRigModel` is the point of the list. A boat with one can be measured; a
// boat without gives generic maxi estimates and no twist, and the picker says
// which is which BEFORE the operator marks fifty points on a photograph.
//
// Competitors are in here because a rival's IRC certificate is public and their
// rig model comes straight off it — that is the whole reason a boat we do not
// own is measurable at all.
//
// `logProfile` rides along for the Upload tab. A boat's channel-label aliases
// were documented as living on `boats.specs.log_profile` from the day the
// profile was designed, but nothing ever read them: the editor panel saved to
// one device-wide localStorage key instead, so a boat with a differently
// labelled channel needed every laptop set up by hand, and the setting followed
// whoever's browser it was into every other boat. Sending it with the boat is
// what makes the stored profile the boat's.

import { NextResponse } from 'next/server'
import { getServerSupabase } from '../../../lib/supabase/server'
import { getBoatLogProfile } from '../../../lib/logProfile'

export async function GET() {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const [{ data: boats, error }, { data: teams }] = await Promise.all([
    supabase.from('boats').select('id, team_id, name, sail_number, rig_model, is_competitor, specs').order('name'),
    supabase.from('teams').select('id, name'),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const teamName = new Map((teams || []).map((t) => [t.id, t.name as string]))
  return NextResponse.json({
    boats: (boats || []).map((b) => ({
      id: b.id,
      name: b.name,
      sailNumber: b.sail_number ?? null,
      teamName: teamName.get(b.team_id) ?? null,
      hasRigModel: !!b.rig_model && Object.keys(b.rig_model as object).length > 0,
      isCompetitor: b.is_competitor === true,
      // Only the log profile, not the whole specs blob: the rest of specs is
      // nobody's business on a list of fifty boats.
      logProfile: getBoatLogProfile(b.specs),
    })),
  })
}

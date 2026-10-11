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

  // `specs` is OPTIONAL here, and that is load-bearing. It was selected before
  // the column existed (it lives on `sails`, not `boats`), and PostgREST refuses
  // the whole SELECT over one unknown column — so this route answered 500,
  // fetchBoats() returned [], and every boat vanished from SailTrim's picker and
  // the Upload tab. The symptom reads as "my boat is missing", not as an outage,
  // which is why it took a 500 in the console to find.
  //
  // So: ask for it, and if the column is not there, ask again without it. A log
  // profile nobody has set is worth exactly nothing next to a boat list that
  // works.
  const COLS = 'id, team_id, name, sail_number, rig_model, is_competitor'
  const [full, { data: teams }] = await Promise.all([
    supabase.from('boats').select(`${COLS}, specs`).order('name'),
    supabase.from('teams').select('id, name'),
  ])

  let boats = full.data as Record<string, unknown>[] | null
  let error = full.error
  // 42703 = undefined column (Postgres), PGRST204 = not in PostgREST's cache.
  if (error && ['42703', 'PGRST204'].includes(error.code || '')) {
    console.warn('[api/boats] boats.specs is missing — serving the list without log profiles. Run migration 0099.')
    const retry = await supabase.from('boats').select(COLS).order('name')
    boats = retry.data as Record<string, unknown>[] | null
    error = retry.error
  }
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
      logProfile: getBoatLogProfile((b as { specs?: unknown }).specs),
    })),
  })
}

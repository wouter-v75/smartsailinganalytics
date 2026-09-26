// The rig model for one boat — the handful of dimensions that turn pixels into
// millimetres for SailTrim.
//
//   GET  ?boat=Northstar%2076   → { boat, boatId, rigModel, canEdit }
//   GET  ?boat_id=<uuid>        → the same, and the NAME, which is what the tab
//                                 needs: two of its three call sites have the
//                                 boat's id in hand and no name at all.
//   PUT  { boat | boat_id, model } → { ok, rigModel }   coach only, per boats_update
//
// WHY IT IS A ROUTE AND NOT JUST localStorage. The model used to live in a
// hardcoded map plus each browser's own storage, so a dimension measured on the
// dock was present for whoever typed it and absent for everyone else — the same
// failure that makes a photo's instrument data vanish off the importing machine
// (CLAUDE.md). boats.rig_model is per boat and shared, so one tape measure
// serves the whole team.
//
// The boat is addressed by NAME because that is all the SailTrim tab knows: it
// can be opened on a photo, or from /dev/sailtrim with no session at all, so
// there is no boat id in scope. RLS still does the gating — boats_select only
// returns boats the caller may see, so a name cannot be used to fish.
//
// `canEdit` is returned rather than left to be discovered by a failed save.
// boats_update is coach-only, and a viewer whose edits silently went nowhere
// would have no way to tell that from a save that worked.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../lib/supabase/server'

const norm = (s: string) => s.trim().toLowerCase()

type BoatRow = { id: string; team_id: string; name: string; rig_model: unknown }

/**
 * The caller's accessible boats, by id when there is one and by name otherwise.
 *
 * The id is preferred wherever a caller has it: a name is what somebody typed,
 * and two boats in a programme can be a keystroke apart ("Northstar 76" /
 * "Northstar72"). RLS does the gating either way — boats_select only returns
 * boats this caller may see, so neither a name nor an id can be used to fish.
 */
async function findBoat(supabase: ReturnType<typeof getServerSupabase>, boat: string, boatId?: string | null) {
  const { data, error } = await supabase.from('boats').select('id, team_id, name, rig_model')
  if (error) return { error: error.message, boat: null as null | BoatRow }
  if (boatId) {
    const byId = (data || []).find((b) => b.id === boatId)
    return { error: null, boat: (byId as BoatRow | undefined) ?? null }
  }
  const want = norm(boat)
  const hit = (data || []).find((b) => norm(b.name) === want)
    // The certificate calls it NORTHSTAR III and the app calls it Northstar 76,
    // so an exact match is not always available. Fall back to a containment
    // match, but only when it is unambiguous.
    ?? ((data || []).filter((b) => norm(b.name).includes(want) || want.includes(norm(b.name))).length === 1
      ? (data || []).find((b) => norm(b.name).includes(want) || want.includes(norm(b.name)))!
      : null)
  return { error: null, boat: hit ?? null }
}

export async function GET(req: NextRequest) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const sp = new URL(req.url).searchParams
  const boat = sp.get('boat') || ''
  const boatId = sp.get('boat_id') || ''
  if (!boat.trim() && !boatId.trim()) {
    return NextResponse.json({ error: 'boat or boat_id required' }, { status: 400 })
  }

  const { error, boat: row } = await findBoat(supabase, boat, boatId || null)
  if (error) return NextResponse.json({ error }, { status: 500 })
  if (!row) return NextResponse.json({ boat, boatId: null, rigModel: null, canEdit: false })

  // Whether this caller may write it, asked the only way that cannot disagree
  // with the policy: the policy itself, via the same role helper it uses.
  const { data: canEdit } = await supabase.rpc('has_team_role', {
    p_team_id: row.team_id, p_roles: ['coach'],
  }).then((r) => r, () => ({ data: null }))

  const model = row.rig_model && Object.keys(row.rig_model as object).length ? row.rig_model : null
  return NextResponse.json({ boat: row.name, boatId: row.id, rigModel: model, canEdit: canEdit === true })
}

export async function PUT(req: NextRequest) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null) as { boat?: string; boat_id?: string; model?: unknown } | null
  if ((!body?.boat && !body?.boat_id) || !body.model || typeof body.model !== 'object') {
    return NextResponse.json({ error: 'boat (or boat_id) and model required' }, { status: 400 })
  }

  const { error, boat: row } = await findBoat(supabase, body.boat || '', body.boat_id || null)
  if (error) return NextResponse.json({ error }, { status: 500 })
  if (!row) return NextResponse.json({ error: 'no such boat, or no access to it' }, { status: 404 })

  const { data, error: upErr } = await supabase
    .from('boats').update({ rig_model: body.model }).eq('id', row.id).select('rig_model')
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
  // RLS makes a forbidden UPDATE match no rows rather than fail: without this
  // the caller would be told the save worked.
  if (!data || data.length === 0) {
    return NextResponse.json({ error: 'not allowed to edit this boat — a coach can' }, { status: 403 })
  }
  return NextResponse.json({ ok: true, rigModel: data[0].rig_model })
}

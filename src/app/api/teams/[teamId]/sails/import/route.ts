// Bulk sail-inventory import from an Expedition event-file <saillist>.
//
//   POST { boat_id, sails: [{ name, kind?, sailType?, sailGroup?, weightKg? }],
//          boat_name?, reconcile? }
//     → upsert each sail by (boat_id, name): existing sails are updated
//       (kind/category + merged specs) and marked active; new ones inserted.
//       The event file's <saillist> is the current inventory, so unless
//       reconcile===false, any previously event-file-imported sail NOT in the
//       list is marked retired (manual sails are left untouched). Nothing is
//       ever deleted.
//
// Matching is by nameKey — trimmed and lower-cased — and by the ALIASES a crew
// has linked to a sail in the tagger. Both matter for the same reason: an event
// file's spelling of a sail is not under anybody's control. Matching on the raw
// string made "J2 " a second J2, and made the next upload of a file saying
// "J4_A 2026" insert a sail the crew had already said was J4_A_2026 — undoing
// the link, silently, every time the file was re-read.
//
// sailType / sailGroup / weightKg are kept under `specs` (no schema change).
// RLS gates writes to the TL3+ leadership set via the user's server session.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../../lib/supabase/server'
import { planSailImport } from '../../../../../../lib/sailImport'

const SELECT =
  'id,boat_id,name,kind,category,sailmaker,build_date,retired,certificate_key,certificate_name,specs,updated_at'

const KINDS = new Set(['mainsail', 'jib', 'genoa', 'staysail', 'spinnaker', 'gennaker', 'code', 'other'])

// "A1.5_2026" → "A1.5", "J3+_2026" → "J3+", "MAIN_2026" → "MAIN"
const categoryFromName = (name: string): string => name.replace(/_\d{4}$/, '').trim() || name

export async function POST(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const boatId = body?.boat_id
  const incoming: any[] = Array.isArray(body?.sails) ? body.sails : []
  if (!boatId) return NextResponse.json({ error: 'boat_id required' }, { status: 400 })
  if (!incoming.length) return NextResponse.json({ error: 'no sails to import' }, { status: 400 })

  // Existing inventory for this boat → map by name for upsert.
  const { data: existing, error: exErr } = await supabase
    .from('sails')
    .select('id,name,specs,kind,category,retired')
    .eq('team_id', params.teamId)
    .eq('boat_id', boatId)
  if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 })
  // Who matches what, and what the file no longer mentions — in lib/sailImport,
  // where it is under test, because getting it wrong retires a sail locker.
  const plan = planSailImport(existing || [], incoming, { reconcile: body?.reconcile !== false })

  const specsOf = (s: any) => ({
    sail_type: s?.sailType ?? null,
    sail_group: s?.sailGroup ?? null,
    weight_kg: typeof s?.weightKg === 'number' ? s.weightKg : null,
    source: 'event-file',
  })
  const kindOf = (s: any) => (KINDS.has(s?.kind) ? s.kind : 'other')

  let updated = 0
  for (const { sail, incoming: row } of plan.update) {
    // In the list ⇒ current inventory ⇒ active again (un-retire if needed).
    // The spread keeps everything else in the bag — the design shapes, and the
    // aliases that are how this sail was matched in the first place.
    const { error } = await supabase
      .from('sails')
      .update({
        kind: kindOf(row),
        category: (sail as any).category || categoryFromName(sail.name),
        retired: false,
        specs: { ...(sail.specs || {}), ...specsOf(row) },
      })
      .eq('id', sail.id)
      .eq('team_id', params.teamId)
    if (!error) updated++
  }

  const toInsert = plan.insert.map(({ name, incoming: row }) => ({
    team_id: params.teamId,
    boat_id: boatId,
    name,
    kind: kindOf(row),
    category: categoryFromName(name),
    retired: false,
    specs: specsOf(row),
    created_by_user_id: user.id,
  }))

  let inserted = 0
  if (toInsert.length) {
    const { data, error } = await supabase.from('sails').insert(toInsert).select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    inserted = data?.length || 0
  }

  // Reconcile: a previously event-file-imported sail that's no longer in the
  // list is retired (not deleted). Manually-added sails (no event-file source)
  // are left alone so the inventory file doesn't wipe hand-entered tags.
  let retired = 0
  for (const s of plan.retire) {
    const { error } = await supabase
      .from('sails')
      .update({ retired: true })
      .eq('id', s.id)
      .eq('team_id', params.teamId)
    if (!error) retired++
  }

  const { data: sails } = await supabase
    .from('sails')
    .select(SELECT)
    .eq('team_id', params.teamId)
    .eq('boat_id', boatId)
    .order('retired', { ascending: true })
    .order('category', { ascending: true })

  return NextResponse.json({ inserted, updated, retired, count: incoming.length, sails: sails || [] })
}

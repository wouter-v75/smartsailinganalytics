// Bulk sail-inventory import from an Expedition event-file <saillist>.
//
//   POST { boat_id, sails: [{ name, kind?, sailType?, sailGroup?, weightKg? }], boat_name? }
//     → upsert each sail by (boat_id, name): existing sails are updated
//       (kind/category + merged specs), new ones inserted. Never deletes — sails
//       not in the list are left alone (a sail can be retired manually).
//
// sailType / sailGroup / weightKg are kept under `specs` (no schema change).
// RLS gates writes to the TL3+ leadership set via the user's server session.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../../lib/supabase/server'

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
    .select('id,name,specs,kind,category')
    .eq('team_id', params.teamId)
    .eq('boat_id', boatId)
  if (exErr) return NextResponse.json({ error: exErr.message }, { status: 500 })
  const byName = new Map<string, any>((existing || []).map((s) => [s.name, s]))

  const toInsert: any[] = []
  let updated = 0
  for (const s of incoming) {
    const name = String(s?.name || '').trim()
    if (!name) continue
    const kind = KINDS.has(s?.kind) ? s.kind : 'other'
    const specsPatch = {
      sail_type: s?.sailType ?? null,
      sail_group: s?.sailGroup ?? null,
      weight_kg: typeof s?.weightKg === 'number' ? s.weightKg : null,
      source: 'event-file',
    }
    const found = byName.get(name)
    if (found) {
      const { error } = await supabase
        .from('sails')
        .update({ kind, category: found.category || categoryFromName(name), specs: { ...(found.specs || {}), ...specsPatch } })
        .eq('id', found.id)
        .eq('team_id', params.teamId)
      if (!error) updated++
    } else {
      toInsert.push({
        team_id: params.teamId,
        boat_id: boatId,
        name,
        kind,
        category: categoryFromName(name),
        specs: specsPatch,
        created_by_user_id: user.id,
      })
    }
  }

  let inserted = 0
  if (toInsert.length) {
    const { data, error } = await supabase.from('sails').insert(toInsert).select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    inserted = data?.length || 0
  }

  const { data: sails } = await supabase
    .from('sails')
    .select(SELECT)
    .eq('team_id', params.teamId)
    .eq('boat_id', boatId)
    .order('retired', { ascending: true })
    .order('category', { ascending: true })

  return NextResponse.json({ inserted, updated, count: incoming.length, sails: sails || [] })
}

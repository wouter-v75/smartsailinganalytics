// The tag vocabulary.
//
//   GET    ?boat_id=…[&scope=…]  → { defs, buttonBar }
//   POST   { scope, slug, label, … }  → create one
//   PATCH  { id, … }                  → edit one
//   DELETE ?id=…                      → archive it (or delete an unused personal one)
//
// Reads return everything the caller can SEE, which deliberately includes other
// sections' tags: you should be able to read what the bow called a moment even
// if you cannot apply their vocabulary yourself. Only personal tags are private,
// and RLS enforces that rather than this route.
//
// `buttonBar` is split out because it is a different object from the full list —
// around eight curated buttons, because a long tail of rarely-used codes
// measurably damages how consistently a squad tags.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { canApplyTagDef, canCurateVocabulary } from '@/lib/tagging/gating'
import { TAG_DEF_COLUMNS, toTagDef, toTagDefPatch } from '@/lib/tagging/rowMap'
import { slugify } from '@/lib/tagging/baseTags'
import { isCrewSection } from '@/lib/tagging/sections'
import { identityFor } from '@/lib/tagging/identity'
import type { TagScope } from '@/lib/tagging/types'

export async function GET(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const boatId = searchParams.get('boat_id')
  const scope = searchParams.get('scope')

  let q = supabase.from('ssa_tag_defs').select(TAG_DEF_COLUMNS).eq('team_id', params.teamId)
  if (scope) q = q.eq('scope', scope)
  if (searchParams.get('include_archived') !== '1') q = q.eq('archived', false)

  const { data, error } = await q.order('sort', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const me = await identityFor(supabase, user.id, params.teamId, boatId)
  const defs = (data || []).map(toTagDef)
    // A definition scoped to another boat is not this boat's vocabulary.
    .filter((d) => !d.boatId || !boatId || d.boatId === boatId)

  return NextResponse.json({
    defs: defs.map((d) => ({ ...d, canApply: canApplyTagDef(d, me) })),
    buttonBar: defs.filter((d) => d.onButtonBar && canApplyTagDef(d, me)).map((d) => d.id),
    me: { role: me.role, sections: me.sections },
  })
}

export async function POST(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const scope = (body?.scope || 'general') as TagScope
  const boatId = body?.boat_id ?? null
  const section = body?.section ?? null
  const label = String(body?.label || '').trim()
  const slug = slugify(body?.slug || label)

  if (!label || !slug) return NextResponse.json({ error: 'label required' }, { status: 400 })
  if (scope === 'section' && !isCrewSection(section)) {
    return NextResponse.json({ error: 'A section tag needs a valid crew section' }, { status: 400 })
  }

  const me = await identityFor(supabase, user.id, params.teamId, boatId)
  if (!canCurateVocabulary(scope, section, me)) {
    return NextResponse.json(
      { error: scope === 'general'
          ? 'Editing the shared vocabulary is a coach / TL3 / team-manager job.'
          : 'You can only add tags for a section you sail in.' },
      { status: 403 }
    )
  }

  const row = {
    team_id: params.teamId,
    boat_id: boatId,
    scope,
    section: scope === 'section' ? section : null,
    owner_user_id: scope === 'personal' ? user.id : null,
    slug,
    label,
    color: body?.color || '#06B6D4',
    min_role: body?.min_role || 'tl1',
    kind: body?.kind === 'range' ? 'range' : 'point',
    lead_sec: Number.isFinite(Number(body?.lead_sec)) ? Number(body.lead_sec) : 10,
    lag_sec: Number.isFinite(Number(body?.lag_sec)) ? Number(body.lag_sec) : 10,
    label_groups: Array.isArray(body?.label_groups) ? body.label_groups : [],
    lane: body?.lane ?? null,
    on_button_bar: !!body?.on_button_bar,
    sort: Number.isFinite(Number(body?.sort)) ? Number(body.sort) : 400,
    builtin: false,
    created_by_user_id: user.id,
  }

  const { data, error } = await supabase
    .from('ssa_tag_defs').insert(row).select(TAG_DEF_COLUMNS).single()
  if (error) {
    const dupe = error.code === '23505'
    return NextResponse.json(
      { error: dupe ? `"${label}" already exists in this list` : error.message },
      { status: dupe ? 409 : 500 }
    )
  }
  return NextResponse.json({ def: toTagDef(data) }, { status: 201 })
}

export async function PATCH(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const id = String(body?.id || '')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { data: existing } = await supabase
    .from('ssa_tag_defs').select(TAG_DEF_COLUMNS)
    .eq('team_id', params.teamId).eq('id', id).maybeSingle()
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const def = toTagDef(existing)
  const me = await identityFor(supabase, user.id, params.teamId, def.boatId)
  if (!canCurateVocabulary(def.scope, def.section, me)) {
    return NextResponse.json({ error: 'Not yours to edit' }, { status: 403 })
  }

  const patch = toTagDefPatch({
    label: body?.label, color: body?.color, minRole: body?.min_role,
    kind: body?.kind, leadSec: body?.lead_sec, lagSec: body?.lag_sec,
    labelGroups: body?.label_groups, lane: body?.lane,
    onButtonBar: body?.on_button_bar, archived: body?.archived, sort: body?.sort,
  })
  // toTagDefPatch only emits keys that were present, but an all-undefined body
  // would still reach it, so guard the empty update.
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k]
  if (!Object.keys(patch).length) return NextResponse.json({ def, changed: false })

  const { data, error } = await supabase
    .from('ssa_tag_defs').update(patch).eq('id', id).select(TAG_DEF_COLUMNS).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ def: toTagDef(data), changed: true })
}

export async function DELETE(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { data: existing } = await supabase
    .from('ssa_tag_defs').select(TAG_DEF_COLUMNS)
    .eq('team_id', params.teamId).eq('id', id).maybeSingle()
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const def = toTagDef(existing)

  // Archive rather than delete: tags already applied denormalise their label and
  // colour, but a season's filters read better when the vocabulary they refer to
  // still exists. Archiving takes it out of the picker and leaves history intact.
  const { count } = await supabase
    .from('ssa_tag_events')
    .select('id', { count: 'exact', head: true })
    .eq('tag_def_id', id)

  if (count && count > 0) {
    const { data, error } = await supabase
      .from('ssa_tag_defs').update({ archived: true }).eq('id', id)
      .select(TAG_DEF_COLUMNS).single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ archived: true, usedBy: count, def: toTagDef(data) })
  }

  const { error } = await supabase.from('ssa_tag_defs').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ deleted: true, slug: def.slug })
}

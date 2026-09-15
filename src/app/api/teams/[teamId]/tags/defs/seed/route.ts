// Seed a boat's tag vocabulary.
//
//   POST { boat_id?: string | null }  → upsert the base vocabulary
//
// A team that opens the tagger to an empty list will invent one on the dock, and
// a vocabulary invented twice is two vocabularies. So we ship a base set: the
// tags SSA already uses (racingTags, computeAutoTags, the shape of a day) plus a
// starter list per crew section, and whatever the team had in the legacy
// `tag_lists` row so nothing they already type is lost.
//
// Idempotent — upserts on (team, boat, scope, section, owner, slug), so running
// it again after a base-vocabulary change updates in place rather than
// duplicating. It never touches a tag someone has edited away from the default:
// only `builtin` rows are updated, and only their presentation.
//
// Seeding is a CURATOR action (coach / tl3 / team_manager / admin). RLS enforces
// that; we check first only so the caller gets a sentence instead of a 403 wall.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { BASE_TAGS, migrateLegacyTagList, type BaseTag } from '@/lib/tagging/baseTags'

const CURATOR_ROLES = ['coach', 'tl3', 'team_manager']

/** The unique index the upsert arbitrates on — plain columns, so PostgREST can
 *  name it (see migration 0062: it is NULLS NOT DISTINCT, not an expression). */
const ON_CONFLICT = 'team_id,boat_id,scope,section,owner_user_id,slug'

function rowFor(t: BaseTag, teamId: string, boatId: string | null, userId: string) {
  return {
    team_id: teamId,
    boat_id: boatId,
    scope: t.scope,
    section: t.section,
    owner_user_id: null,
    slug: t.slug,
    label: t.label,
    color: t.color,
    min_role: t.minRole,
    kind: t.kind,
    lead_sec: t.leadSec,
    lag_sec: t.lagSec,
    label_groups: t.labelGroups,
    on_button_bar: t.onButtonBar,
    private_by_default: !!t.privateByDefault,
    sort: t.sort,
    builtin: true,
    created_by_user_id: userId,
  }
}

export async function POST(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { boat_id?: string | null } | null
  const boatId = body?.boat_id || null

  // Is the caller allowed to curate? Admin passes; otherwise they need a
  // curator-tier membership in this team.
  const [{ data: me }, { data: memberships }] = await Promise.all([
    supabase.from('users').select('global_role').eq('id', user.id).maybeSingle(),
    supabase.from('memberships').select('role').eq('user_id', user.id).eq('team_id', params.teamId),
  ])
  const isAdmin = me?.global_role === 'admin'
  const isCurator = (memberships || []).some((m) => CURATOR_ROLES.includes(String(m.role)))
  if (!isAdmin && !isCurator) {
    return NextResponse.json(
      { error: 'Seeding the tag vocabulary is a coach / TL3 / team-manager job.' },
      { status: 403 }
    )
  }

  // The team's existing free-typed vocabulary, so nothing they already use is
  // lost in the move to the tagger. Base tags win on a slug clash.
  const { data: legacy } = await supabase
    .from('tag_lists')
    .select('tags')
    .eq('team_id', params.teamId)
    .maybeSingle()
  const carriedOver = migrateLegacyTagList((legacy?.tags as string[] | undefined) || [])

  const rows = [...BASE_TAGS, ...carriedOver].map((t) => rowFor(t, params.teamId, boatId, user.id))

  const { data, error } = await supabase
    .from('ssa_tag_defs')
    .upsert(rows, { onConflict: ON_CONFLICT, ignoreDuplicates: false })
    .select('id,scope,section,slug')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const seeded = data || []
  return NextResponse.json({
    ok: true,
    seeded: seeded.length,
    general: seeded.filter((r) => r.scope === 'general').length,
    section: seeded.filter((r) => r.scope === 'section').length,
    carriedOver: carriedOver.length,
  })
}

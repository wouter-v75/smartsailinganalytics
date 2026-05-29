// POST → create a sub-team for this team. Body: { category, label, key?, seq? }
//
// category ∈ racing | technical | whole-team. `key` is the machine slug; if
// omitted it's derived from the label. The vocabulary is normally seeded by
// migration 0014, but coaches can add areas here without a migration.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../lib/supabase/admin-guard'

const CATEGORIES = ['racing', 'technical', 'whole-team'] as const
type Category = (typeof CATEGORIES)[number]

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const body = (await req.json().catch(() => null)) as
    | { category?: Category; label?: string; key?: string; seq?: number }
    | null
  if (!body?.category || !body?.label) {
    return NextResponse.json(
      { error: 'category and label required' },
      { status: 400 }
    )
  }
  if (!CATEGORIES.includes(body.category)) {
    return NextResponse.json({ error: 'invalid category' }, { status: 400 })
  }
  const key = (body.key && slugify(body.key)) || slugify(body.label)
  if (!key) {
    return NextResponse.json({ error: 'could not derive key' }, { status: 400 })
  }

  const service = getServiceSupabase()
  const { data, error } = await service
    .from('subteams')
    .insert({
      team_id: params.teamId,
      category: body.category,
      key,
      label: body.label.trim(),
      seq: typeof body.seq === 'number' ? body.seq : 0,
      created_by_user_id: guard.userId,
    })
    .select('id, category, key, label, seq, active')
    .single()
  if (error) {
    // 23505 = unique_violation on (team_id, key)
    const dup = (error as { code?: string }).code === '23505'
    return NextResponse.json(
      { error: dup ? `a sub-team with key "${key}" already exists` : error.message },
      { status: dup ? 409 : 500 }
    )
  }

  await service.from('events').insert({
    user_id: guard.userId,
    action: 'subteam.create',
    details: { team_id: params.teamId, subteam_id: data.id, key },
  })
  return NextResponse.json({ subteam: data })
}

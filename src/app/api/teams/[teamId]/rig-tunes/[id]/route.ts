// Update one rig baseline.
//
//   PATCH  body { settingsTable?, notes? }
//          → merges `settingsTable` (the editable Upwind/Reaching TWS-band rig
//            settings grid) into the row's `data` JSONB, leaving the parsed
//            `columns` untouched. RLS gates the write to the TL3+ set.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../../lib/supabase/server'

const SELECT =
  'id,boat_id,name,source,revision,effective_date,is_active,data,report_ref,report_key,notes,created_at,updated_at'

export async function PATCH(
  req: NextRequest,
  { params }: { params: { teamId: string; id: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as
    | { settingsTable?: unknown; notes?: string | null }
    | null
  if (!body) return NextResponse.json({ error: 'body required' }, { status: 400 })

  // Read the current row (RLS-scoped) so we can merge rather than clobber `data`.
  const { data: row, error: readErr } = await supabase
    .from('rig_tunes')
    .select('id,data')
    .eq('id', params.id)
    .eq('team_id', params.teamId)
    .maybeSingle()
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })
  if (!row) return NextResponse.json({ error: 'rig tune not found' }, { status: 404 })

  const patch: Record<string, unknown> = {}
  if ('settingsTable' in body) {
    patch.data = { ...((row.data as Record<string, unknown>) || {}), settingsTable: body.settingsTable ?? null }
  }
  if ('notes' in body) patch.notes = body.notes ?? null
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: 'no writable fields' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('rig_tunes')
    .update(patch)
    .eq('id', params.id)
    .eq('team_id', params.teamId)
    .select(SELECT)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rigTune: data })
}

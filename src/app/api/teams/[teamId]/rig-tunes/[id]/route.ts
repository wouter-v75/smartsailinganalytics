// Update one rig baseline.
//
//   PATCH  body { settingsTable?, settingsNotes?, notes? }
//          → merges `settingsTable` (the editable Upwind/Reaching TWS-band rig
//            settings grid) into the row's `data` JSONB, leaving the parsed
//            `columns` untouched. RLS gates the write to the TL3+ set.
//
// HISTORY. A save is no longer destructive. Every settingsTable save also APPENDS
// the table to rig_settings_versions with its notes and a timestamp, so the boat
// keeps a record of what it was tuned to and why. The newest version row is, by
// construction, the current table — data.settingsTable stays as the read path.
//
// The row's own data carries the stamp too (settingsSavedAt / settingsNotes), so
// the UI can show "as of <date>" without a second fetch.
//
//   GET (via ./versions) → the list.

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
    | { settingsTable?: unknown; settingsNotes?: string | null; notes?: string | null }
    | null
  if (!body) return NextResponse.json({ error: 'body required' }, { status: 400 })

  // Read the current row (RLS-scoped) so we can merge rather than clobber `data`.
  const { data: row, error: readErr } = await supabase
    .from('rig_tunes')
    .select('id,boat_id,data,updated_at')
    .eq('id', params.id)
    .eq('team_id', params.teamId)
    .maybeSingle()
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })
  if (!row) return NextResponse.json({ error: 'rig tune not found' }, { status: 404 })

  const prev = (row.data as Record<string, unknown>) || {}
  const savingTable = 'settingsTable' in body && body.settingsTable != null
  const savedAt = new Date().toISOString()
  const settingsNotes = typeof body.settingsNotes === 'string' ? body.settingsNotes.trim() || null : null

  const patch: Record<string, unknown> = {}
  if ('settingsTable' in body) {
    patch.data = {
      ...prev,
      settingsTable: body.settingsTable ?? null,
      ...(savingTable ? { settingsSavedAt: savedAt, settingsNotes } : {}),
    }
  }
  if ('notes' in body) patch.notes = body.notes ?? null
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: 'no writable fields' }, { status: 400 })
  }

  // ── history ───────────────────────────────────────────────────────────────
  // Before overwriting, make sure the table that is ABOUT to be replaced is not
  // lost. Rows edited before this feature existed have no version row at all, so
  // the first save after deploy backfills the outgoing table as version 1 —
  // otherwise the oldest settings would be the one thing history never captured.
  if (savingTable) {
    const { count } = await supabase
      .from('rig_settings_versions')
      .select('id', { count: 'exact', head: true })
      .eq('rig_tune_id', params.id)

    const rows: Record<string, unknown>[] = []
    if (!count && prev.settingsTable) {
      rows.push({
        team_id: params.teamId, boat_id: row.boat_id, rig_tune_id: params.id,
        settings: prev.settingsTable,
        notes: (prev.settingsNotes as string) || 'Table as it stood before history was kept.',
        saved_by_user_id: null,
        saved_at: (prev.settingsSavedAt as string) || row.updated_at || savedAt,
      })
    }
    rows.push({
      team_id: params.teamId, boat_id: row.boat_id, rig_tune_id: params.id,
      settings: body.settingsTable, notes: settingsNotes,
      saved_by_user_id: user.id, saved_at: savedAt,
    })
    // A failure to archive must NOT silently become a destructive save.
    const { error: histErr } = await supabase.from('rig_settings_versions').insert(rows)
    if (histErr) return NextResponse.json({ error: `history not saved (nothing overwritten): ${histErr.message}` }, { status: 500 })
  }

  const { data, error } = await supabase
    .from('rig_tunes')
    .update(patch)
    .eq('id', params.id)
    .eq('team_id', params.teamId)
    .select(SELECT)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rigTune: data, savedAt: savingTable ? savedAt : null })
}

// Reconcile a day's detections with what is already tagged.
//
//   POST { boat_id, session_date, session_id?, detections: Detection[], dry_run? }
//     → { summary, events }   (or { summary, plan } when dry_run)
//
// The client runs `detectDay()` — it already holds the day's log and event file,
// and detection is pure — then posts what it found. Same division of labour as
// /api/teams/[teamId]/timeline, which has producers build nodes client-side.
//
// But planSync runs HERE, not there. The merge rules are the tagger's central
// promise (a human edit is never lost, a rejected detection never comes back),
// and a promise enforced in the browser is a promise anyone can skip by posting
// their own rows. So the client says what it SAW; the server decides what that
// MEANS for the rows that exist.
//
// This is the route that makes a day tagged within minutes of the boat docking:
// the crew open the day, detection runs, and the starts, roundings and
// manoeuvres are already there to be confirmed rather than typed.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { planSync, type SyncContext } from '@/lib/tagging/merge'
import {
  TAG_EVENT_COLUMNS, TAG_DEF_COLUMNS, toTagEvent, toTagDef,
  toTagEventInsert, toTagEventPatch,
} from '@/lib/tagging/rowMap'
import type { Detection } from '@/lib/tagging/detect'

export async function POST(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const boatId: string | undefined = body?.boat_id
  const sessionDate: string | undefined = body?.session_date
  const detections: Detection[] = Array.isArray(body?.detections) ? body.detections : []
  if (!boatId || !sessionDate) {
    return NextResponse.json({ error: 'boat_id and session_date required' }, { status: 400 })
  }

  // Everything already on this day, tombstones included — planSync needs to see
  // a rejected row to know not to recreate it.
  const { data: rows, error: readErr } = await supabase
    .from('ssa_tag_events')
    .select(TAG_EVENT_COLUMNS)
    .eq('team_id', params.teamId)
    .eq('boat_id', boatId)
    .eq('session_date', sessionDate)
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })

  // The vocabulary, so a detection picks up the crew's own label and colour
  // rather than the detector's stock one.
  const { data: defRows } = await supabase
    .from('ssa_tag_defs')
    .select(TAG_DEF_COLUMNS)
    .eq('team_id', params.teamId)
    .eq('scope', 'general')
    .eq('archived', false)
  const byslug = new Map((defRows || []).map(toTagDef).map((d) => [d.slug, d]))

  const ctx: SyncContext = {
    teamId: params.teamId,
    boatId,
    sessionId: body?.session_id ?? null,
    sessionDate,
    lookup: (slug) => {
      const d = byslug.get(slug)
      return d ? { label: d.label, color: d.color } : null
    },
  }

  const plan = planSync((rows || []).map(toTagEvent), detections, ctx)

  if (body?.dry_run) {
    // The sync preview: what WOULD change. Worth having before a crew watches a
    // re-import quietly move forty tags.
    return NextResponse.json({
      summary: plan.summary,
      plan: {
        insert: plan.insert.map((i) => ({ detectionKey: i.detectionKey, slug: i.slug, t0: i.t0 })),
        update: plan.update.map((u) => ({ id: u.id, detectionKey: u.detectionKey, reasons: u.reasons })),
        remove: plan.remove,
        skipped: plan.skipped,
      },
    })
  }

  const errors: string[] = []

  if (plan.insert.length) {
    const payload = plan.insert.map((i) => ({
      ...toTagEventInsert(i),
      created_by_user_id: user.id,
    }))
    const { error } = await supabase.from('ssa_tag_events').insert(payload)
    if (error) errors.push(`insert: ${error.message}`)
  }

  // Updates are per-row because each carries a different patch. A day's sync
  // touches a handful of rows in practice — the common case is zero.
  for (const u of plan.update) {
    const { error } = await supabase
      .from('ssa_tag_events').update(toTagEventPatch(u.patch)).eq('id', u.id)
    if (error) errors.push(`update ${u.id}: ${error.message}`)
  }

  if (plan.remove.length) {
    const { error } = await supabase.from('ssa_tag_events').delete().in('id', plan.remove)
    if (error) errors.push(`delete: ${error.message}`)
  }

  const { data: after, error: afterErr } = await supabase
    .from('ssa_tag_events')
    .select(TAG_EVENT_COLUMNS)
    .eq('team_id', params.teamId)
    .eq('boat_id', boatId)
    .eq('session_date', sessionDate)
    .eq('rejected', false)
    .order('t0', { ascending: true })
  if (afterErr) errors.push(`reread: ${afterErr.message}`)

  return NextResponse.json({
    summary: plan.summary,
    skipped: plan.skipped,
    events: (after || []).map(toTagEvent),
    // Partial failure is reported rather than swallowed: RLS may refuse some
    // writes (a guest syncing, say) while allowing the reads.
    errors: errors.length ? errors : undefined,
  }, { status: errors.length ? 207 : 200 })
}

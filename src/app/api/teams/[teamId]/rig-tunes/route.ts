// Rig tuning baselines per (team, boat). The boat's rig tuning sheet (JV76
// "Sailing Info Summary") parsed into per-sail-combination settings, dated so a
// session can later be matched to the baseline current that day.
//
//   GET   ?boat_id=…[&active=1]  → the boat's rig baselines (or just the active one).
//   POST  multipart { boat_id, file: <rig PDF>, effective_date?, name?, notes? }
//         or json    { boat_id, data, effective_date?, name?, ... }
//         → parse + file a rig_tunes row; effective_date defaults to today;
//           the new baseline becomes active (deactivating the rest).
//
// RLS gates writes to the TL3+ leadership set via the user's server session.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../lib/supabase/server'
import { parseRigTune } from '../../../../../lib/rigTuneParse'
import { extractPdfItems } from '../../../../../lib/pdfText'

const SELECT =
  'id,boat_id,name,source,revision,effective_date,is_active,data,report_ref,report_key,notes,created_at,updated_at'

export async function GET(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const boatId = searchParams.get('boat_id')
  const onlyActive = searchParams.get('active') === '1'

  let q = supabase.from('rig_tunes').select(SELECT).eq('team_id', params.teamId)
  if (boatId) q = q.eq('boat_id', boatId)
  if (onlyActive) q = q.eq('is_active', true)
  q = q.order('is_active', { ascending: false }).order('effective_date', { ascending: false, nullsFirst: false })

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rigTunes: data || [] })
}

export async function POST(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const ctype = req.headers.get('content-type') || ''
  let boatId: string | null = null
  let effectiveDate: string | null = null
  let name: string | null = null
  let notes: string | null = null
  let reportRef: string | null = null
  let reportKey: string | null = null
  let data: any = null

  if (ctype.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null)
    if (!form) return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 })
    boatId = (form.get('boat_id') as string) || null
    effectiveDate = (form.get('effective_date') as string) || null
    name = (form.get('name') as string) || null
    notes = (form.get('notes') as string) || null
    reportKey = (form.get('report_key') as string) || null // PDF already stored in Bunny by the client
    const file = form.get('file') as File | null
    if (file) {
      reportRef = file.name || null
      try {
        const buf = Buffer.from(await file.arrayBuffer())
        const pages = await extractPdfItems(buf)
        data = parseRigTune(pages)
      } catch (e: any) {
        return NextResponse.json({ error: 'PDF parsing failed: ' + (e?.message || e) }, { status: 422 })
      }
    }
  } else {
    const body = await req.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 })
    boatId = body.boat_id || null
    effectiveDate = body.effective_date || null
    name = body.name || null
    notes = body.notes || null
    data = body.data || null
  }

  if (!boatId) return NextResponse.json({ error: 'boat_id required' }, { status: 400 })
  if (!data || !Array.isArray(data.columns) || !data.columns.length) {
    return NextResponse.json({ error: 'no rig settings parsed from the sheet' }, { status: 422 })
  }

  // Default the effective date to today (server date, YYYY-MM-DD).
  if (!effectiveDate) effectiveDate = new Date().toISOString().slice(0, 10)

  // One active baseline per boat — clear the current active one first.
  const { error: deErr } = await supabase
    .from('rig_tunes')
    .update({ is_active: false })
    .eq('team_id', params.teamId)
    .eq('boat_id', boatId)
    .eq('is_active', true)
  if (deErr) return NextResponse.json({ error: deErr.message }, { status: 500 })

  const row = {
    team_id: params.teamId,
    boat_id: boatId,
    name: name || (data.revision ? `JV76 Sailing Info ${data.revision}` : 'Rig tuning sheet'),
    source: 'jv76-sheet',
    revision: data.revision ?? null,
    effective_date: effectiveDate,
    is_active: true,
    data,
    report_ref: reportRef,
    report_key: reportKey,
    notes: notes ?? null,
    created_by_user_id: user.id,
  }
  const { data: saved, error } = await supabase.from('rig_tunes').insert(row).select(SELECT).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rigTune: saved })
}

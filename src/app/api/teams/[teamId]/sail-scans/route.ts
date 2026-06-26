// Structured sail scans per (team, boat).
//
//   GET  ?boat_id=…[&sail_id=…][&limit=…]  → recent structured trim-stripe scans.
//   POST  multipart { file: <North PDF> | text: <extracted text>,
//                     boat_id, sail_id?, session_id? }
//        → parse a North SailScan report and file a structured sail_scans row.
//
// SSA ingests from North / thesailcloud; it does not author the numbers. RLS
// gates via the user session.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '../../../../../lib/supabase/server'
import { parseSailScanReport, ParsedScan } from '../../../../../lib/sailScanParse'
import { extractPdfText } from '../../../../../lib/pdfText'
import { signBunnyUrl, bunnyConfigured } from '../../../../../lib/bunny-signed-url'

export async function GET(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const boatId = searchParams.get('boat_id')
  const sailId = searchParams.get('sail_id')
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10) || 50, 200)

  let q = supabase
    .from('sail_scans')
    .select(
      'id,sail_id,session_id,run_id,captured_at,source,tws_kn,twa_deg,' +
        'conditions,stripes,summary,report_ref,notes,updated_at'
    )
    .eq('team_id', params.teamId)
  if (boatId) q = q.eq('boat_id', boatId)
  if (sailId) q = q.eq('sail_id', sailId)
  q = q.order('captured_at', { ascending: false, nullsFirst: false }).limit(limit)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Attach a signed thumbnail URL per scan that has a stored photo (one round
  // trip for the whole list).
  const scans = (data || []).map((s: any) => {
    const key = s?.conditions?.photo_key
    if (key && bunnyConfigured()) {
      const signed = signBunnyUrl({ path: key, ttlSec: 3600 })
      if (signed) return { ...s, photo_url: signed.url }
    }
    return s
  })
  return NextResponse.json({ scans })
}

// ── POST: ingest a North SailScan report → structured sail_scans row ──────────
export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 })
  }
  const boatId = (form.get('boat_id') as string) || null
  const sailId = (form.get('sail_id') as string) || null
  const sessionId = (form.get('session_id') as string) || null
  const photoKey = (form.get('photo_key') as string) || null // sail photo already in Bunny (client-extracted)
  const file = form.get('file') as File | null
  let text = (form.get('text') as string) || ''
  let reportRef: string | null = null

  if (!boatId) return NextResponse.json({ error: 'boat_id required' }, { status: 400 })

  // Get the report text: pre-extracted (preferred — no server dep) or from a
  // PDF via the spacing-aware extractor (so column numbers don't concatenate).
  if (!text && file) {
    reportRef = file.name || null
    try {
      const buf = Buffer.from(await file.arrayBuffer())
      text = await extractPdfText(buf)
    } catch (e: any) {
      return NextResponse.json(
        { error: 'PDF parsing unavailable — install pdf-parse, or POST extracted text. ' + (e?.message || '') },
        { status: 422 }
      )
    }
  }
  if (!text) return NextResponse.json({ error: 'provide a SailScan PDF file or extracted text' }, { status: 400 })

  // One report may yield several scans: a two-sail thesailcloud overlay holds
  // two columns → two scans. Each becomes its own sail_scans row. The chosen
  // sail_id is only applied when the report has a single scan (otherwise we'd
  // mis-tag both columns with the same sail — leave them for later assignment).
  const report = parseSailScanReport(text)
  const parsedScans = report.scans.filter((s) => s.stripes.length)
  if (!parsedScans.length) {
    return NextResponse.json(
      { error: report.format === 'unknown' ? 'unrecognised report format' : 'no stripe rows found in the report' },
      { status: 422 }
    )
  }
  const applySailId = parsedScans.length === 1 ? sailId : null

  const rows = parsedScans.map((s: ParsedScan) => ({
    team_id: params.teamId,
    boat_id: boatId,
    sail_id: applySailId,
    session_id: sessionId,
    source: s.source,
    captured_at: s.capturedAt,
    tws_kn: s.tws,
    twa_deg: s.twa,
    conditions: {
      sail_name_in_report: s.sailName,
      sail_type: s.sailType, // 'main' | 'headsail'
      sail_code: s.sailCode, // North "Code:" e.g. "J1.5 A"
      oe_number: s.oeNumber, // North order number
      image_name: s.imageName,
      captured_local: s.capturedLocal, // wall-clock as written (captured_at is UTC)
      tags: s.tags,
      venue: s.venue,
      event: s.event,
      awa_deg: s.awa,
      bsp_kn: s.bsp,
      forestay_t: s.forestayT, // measured rig loads at capture (NS Sailscan)
      rake_deg: s.rakeDeg,
      jib_tack_t: s.jibTackT,
      report_format: s.format,
      photo_key: photoKey, // sail photo (Bunny key) for the detail view
    },
    stripes: s.stripes,
    summary: s.summary,
    report_ref: reportRef || s.imageName,
    created_by_user_id: user.id,
  }))

  const { data, error } = await supabase.from('sail_scans').insert(rows).select()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ scans: data, parsed: parsedScans, format: report.format, count: rows.length })
}

// ── PATCH: reassign a scan's sail (or notes) ──────────────────────────────────
export async function PATCH(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  if (!body?.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const patch: Record<string, any> = {}
  if ('sail_id' in body) patch.sail_id = body.sail_id || null
  if ('notes' in body) patch.notes = body.notes
  if (!Object.keys(patch).length) return NextResponse.json({ error: 'no writable fields' }, { status: 400 })

  const { data, error } = await supabase
    .from('sail_scans')
    .update(patch)
    .eq('id', body.id)
    .eq('team_id', params.teamId)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ scan: data })
}

// ── DELETE: remove a scan (?id=) ──────────────────────────────────────────────
export async function DELETE(req: NextRequest, { params }: { params: { teamId: string } }) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const { error } = await supabase.from('sail_scans').delete().eq('id', id).eq('team_id', params.teamId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

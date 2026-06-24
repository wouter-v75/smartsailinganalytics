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
import { parseNorthScan } from '../../../../../lib/northScanParse'

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
  return NextResponse.json({ scans: data || [] })
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
  const file = form.get('file') as File | null
  let text = (form.get('text') as string) || ''
  let reportRef: string | null = null

  if (!boatId) return NextResponse.json({ error: 'boat_id required' }, { status: 400 })

  // Get the report text: pre-extracted (preferred — no server dep) or from a
  // PDF via a dynamic pdf-parse import (so the build never hard-depends on it).
  if (!text && file) {
    reportRef = file.name || null
    try {
      const buf = Buffer.from(await file.arrayBuffer())
      // optional dep — handled at runtime; suppress missing-types if not installed
      // @ts-ignore
      const mod: any = await import('pdf-parse/lib/pdf-parse.js')
      const pdf = mod.default || mod
      const parsed = await pdf(buf)
      text = parsed.text || ''
    } catch (e: any) {
      return NextResponse.json(
        { error: 'PDF parsing unavailable — install pdf-parse, or POST extracted text. ' + (e?.message || '') },
        { status: 422 }
      )
    }
  }
  if (!text) return NextResponse.json({ error: 'provide a North PDF file or extracted text' }, { status: 400 })

  const scan = parseNorthScan(text)
  if (!scan.stripes.length) {
    return NextResponse.json({ error: 'no stripe rows found in the report' }, { status: 422 })
  }

  const row = {
    team_id: params.teamId,
    boat_id: boatId,
    sail_id: sailId,
    session_id: sessionId,
    source: 'north' as const,
    captured_at: scan.capturedAt,
    tws_kn: scan.tws,
    conditions: { sail_name_in_report: scan.sailName },
    stripes: scan.stripes,
    summary: scan.summary,
    report_ref: reportRef || scan.imageRef,
    created_by_user_id: user.id,
  }
  const { data, error } = await supabase.from('sail_scans').insert(row).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ scan: data, parsed: scan })
}

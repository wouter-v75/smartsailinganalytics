// Single session per (boat, date).
//
//   GET    → fetch full session including log_data + xml_data jsonb.
//   PUT    → upsert. Body: { title?, log_data?, xml_data?, tz_offset_minutes? }
//            Only the fields you provide are updated — existing values
//            preserved. To clear a field, pass null explicitly.
//   DELETE → drop the session (RLS: coach + admin only).
//
// RLS gates everything; we use the user's session, not service-role.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase, authedUserId } from '../../../../../../../../lib/supabase/server'

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string; boatId: string; date: string } }
) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase
    .from('sessions')
    .select(
      'id, date, title, log_data, xml_data, tz_offset_minutes, created_at, updated_at, created_by_user_id'
    )
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .eq('date', params.date)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ session: data })
}

interface PutBody {
  title?: string | null
  log_data?: unknown
  xml_data?: unknown
  tz_offset_minutes?: number | null
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string; date: string } }
) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as PutBody | null
  if (!body) {
    return NextResponse.json({ error: 'body required' }, { status: 400 })
  }

  // Build the upsert row. team_id + boat_id + date are the natural key.
  const row: Record<string, unknown> = {
    team_id: params.teamId,
    boat_id: params.boatId,
    date: params.date,
    created_by_user_id: uid,
  }
  if ('title' in body) row.title = body.title
  if ('log_data' in body) row.log_data = body.log_data
  if ('xml_data' in body) row.xml_data = body.xml_data
  if ('tz_offset_minutes' in body) row.tz_offset_minutes = body.tz_offset_minutes

  // Upsert by (boat_id, date) — that's the unique constraint from 0003.
  // If the row already exists we don't overwrite created_by; PostgREST
  // honours `ignoreDuplicates: false` so the update keeps the original.
  const { data, error } = await supabase
    .from('sessions')
    .upsert(row, { onConflict: 'boat_id,date' })
    .select(
      'id, date, title, log_data, xml_data, tz_offset_minutes, updated_at'
    )
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ session: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { teamId: string; boatId: string; date: string } }
) {
  const supabase = getServerSupabase()
  const uid = await authedUserId(supabase)
  if (!uid) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { error } = await supabase
    .from('sessions')
    .delete()
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .eq('date', params.date)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

// "Details for today" — structured forecast data for a session, stored in
// sessions.conditions.details_today ({ comments, rows:[{time,twd,tws,range}] }).
//
// GET   ?date=YYYY-MM-DD → { details }
// PATCH  body { date, details } → upsert into the session's conditions JSONB.
//
// RLS enforces the session write gate; the UI restricts editing to TL2+.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

async function findSession(
  supabase: ReturnType<typeof getServerSupabase>,
  teamId: string,
  boatId: string,
  date: string
): Promise<{ id: string; conditions: Record<string, unknown> } | null> {
  const { data } = await supabase
    .from('sessions')
    .select('id, conditions')
    .eq('team_id', teamId)
    .eq('boat_id', boatId)
    .eq('date', date)
    .maybeSingle()
  if (!data) return null
  return { id: data.id, conditions: (data.conditions as Record<string, unknown>) || {} }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const date = req.nextUrl.searchParams.get('date') || ''
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ error: 'valid ?date= required' }, { status: 400 })
  }
  const sess = await findSession(supabase, params.teamId, params.boatId, date)
  return NextResponse.json({
    details: (sess?.conditions?.details_today as unknown) || null,
    timings: (sess?.conditions?.timings as string) || '',
    plan: (sess?.conditions?.plan as string) || '',
    sailList: (sess?.conditions?.sail_list as unknown) || null,
  })
}

// Shape of the day's sail list stored in sessions.conditions.sail_list:
//   { source: 'manual' | 'uploaded', sails: [{ id?: string, name: string }],
//     updated_at: ISO }
// Entered manually at the start of the day; overwritten by the actual list
// once the day's boat config (event file) is uploaded.

export async function PATCH(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as
    | {
        date?: string
        details?: { comments?: string; rows?: unknown[] } | null
        timings?: string | null
        plan?: string | null
        sailList?: { source?: string; sails?: Array<{ id?: string; name: string }> } | null
      }
    | null
  if (!body?.date || !DATE_RE.test(body.date)) {
    return NextResponse.json({ error: 'valid date required' }, { status: 400 })
  }

  let sess = await findSession(supabase, params.teamId, params.boatId, body.date)
  if (!sess) {
    const { data: ins, error: insErr } = await supabase
      .from('sessions')
      .insert({ team_id: params.teamId, boat_id: params.boatId, date: body.date, created_by_user_id: user.id })
      .select('id, conditions')
      .single()
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
    sess = { id: ins.id, conditions: (ins.conditions as Record<string, unknown>) || {} }
  }

  const conditions = { ...sess.conditions }
  if ('details' in body) conditions.details_today = body.details ?? null
  if ('timings' in body) conditions.timings = body.timings ?? null
  if ('plan' in body) conditions.plan = body.plan ?? null
  if ('sailList' in body) {
    conditions.sail_list = body.sailList
      ? { ...body.sailList, updated_at: new Date().toISOString() }
      : null
  }
  const { error } = await supabase.from('sessions').update({ conditions }).eq('id', sess.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

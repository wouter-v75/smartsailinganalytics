// Day-level debrief notes for a session (by date).
//
// GET   ?date=YYYY-MM-DD → { debrief: { learnings, next_focus, documents:[{...,url}] } | null }
//        Document URLs are Bunny-signed (1h TTL) so they're viewable inline.
// PATCH  body { date, learnings?, next_focus? } → upsert. Ensures the session
//        row exists first (so you can debrief a day created in the Plan tab,
//        or any date). RLS enforces the coach/tl1/tl2 write gate.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { signBunnyUrl } from '@/lib/bunny-signed-url'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function signDocs(documents: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(documents) ? documents : []
  return list.map((d) => {
    const doc = d as Record<string, unknown>
    const key = typeof doc.key === 'string' ? doc.key : null
    const signed = key ? signBunnyUrl({ path: key, ttlSec: 3600 }) : null
    return { ...doc, url: signed?.url || null }
  })
}

async function findSessionId(
  supabase: ReturnType<typeof getServerSupabase>,
  teamId: string,
  boatId: string,
  date: string
): Promise<string | null> {
  const { data } = await supabase
    .from('sessions')
    .select('id')
    .eq('team_id', teamId)
    .eq('boat_id', boatId)
    .eq('date', date)
    .maybeSingle()
  return data?.id || null
}

export async function GET(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const date = req.nextUrl.searchParams.get('date') || ''
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ error: 'valid ?date= required' }, { status: 400 })
  }
  const sessionId = await findSessionId(supabase, params.teamId, params.boatId, date)
  if (!sessionId) return NextResponse.json({ debrief: null })

  const { data, error } = await supabase
    .from('debriefs')
    .select('learnings, next_focus, speed_learnings, speed_focus_today, speed_long_term, documents, updated_at')
    .eq('session_id', sessionId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ debrief: null })

  return NextResponse.json({
    debrief: { ...data, documents: signDocs(data.documents) },
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as
    | {
        date?: string
        learnings?: string | null
        next_focus?: string | null
        speed_learnings?: string | null
        speed_focus_today?: string | null
        speed_long_term?: string | null
      }
    | null
  if (!body?.date || !DATE_RE.test(body.date)) {
    return NextResponse.json({ error: 'valid date required' }, { status: 400 })
  }

  // Ensure the session exists for this date.
  let sessionId = await findSessionId(supabase, params.teamId, params.boatId, body.date)
  if (!sessionId) {
    const { data: ins, error: insErr } = await supabase
      .from('sessions')
      .insert({
        team_id: params.teamId,
        boat_id: params.boatId,
        date: body.date,
        created_by_user_id: user.id,
      })
      .select('id')
      .single()
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
    sessionId = ins.id
  }

  const FIELDS = ['learnings', 'next_focus', 'speed_learnings', 'speed_focus_today', 'speed_long_term'] as const
  const patch: Record<string, unknown> = {}
  for (const f of FIELDS) {
    if (f in body) patch[f] = (body as Record<string, unknown>)[f] ?? null
  }

  const { data: existing } = await supabase
    .from('debriefs')
    .select('id')
    .eq('session_id', sessionId)
    .maybeSingle()

  if (existing) {
    if (Object.keys(patch).length) {
      const { error } = await supabase
        .from('debriefs')
        .update(patch)
        .eq('id', existing.id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
  } else {
    const { error } = await supabase.from('debriefs').insert({
      session_id: sessionId,
      team_id: params.teamId,
      boat_id: params.boatId,
      ...patch,
      created_by_user_id: user.id,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

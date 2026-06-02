// Create or update a test day (session) for the campaign calendar.
//
// POST → body { date: 'YYYY-MM-DD', objective?, title? }
// Sessions are unique per (boat, date). If one exists we update its objective/
// title; otherwise we insert. RLS enforces the coach/tl1/tl2 write gate.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as
    | { date?: string; objective?: string | null; title?: string | null; event?: string | null; location?: string | null }
    | null
  if (!body?.date || !DATE_RE.test(body.date)) {
    return NextResponse.json({ error: 'valid date (YYYY-MM-DD) required' }, { status: 400 })
  }

  const { data: existing } = await supabase
    .from('sessions')
    .select('id')
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
    .eq('date', body.date)
    .maybeSingle()

  // Normalise text inputs: trim, treat empty string as null. CHECK
  // constraints cap event/location at 80 chars (0028 / 0032).
  const normShortText = (v: string | null | undefined) => {
    if (v == null) return null
    const t = String(v).trim()
    return t ? t.slice(0, 80) : null
  }

  const patch: Record<string, unknown> = {}
  if ('objective' in body) patch.objective = body.objective ?? null
  if ('title' in body) patch.title = body.title ?? null
  if ('event' in body) patch.event = normShortText(body.event)
  if ('location' in body) patch.location = normShortText(body.location)

  if (existing) {
    if (Object.keys(patch).length) {
      const { error } = await supabase
        .from('sessions')
        .update(patch)
        .eq('id', existing.id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ session: { id: existing.id, date: body.date } })
  }

  const { data, error } = await supabase
    .from('sessions')
    .insert({
      team_id: params.teamId,
      boat_id: params.boatId,
      date: body.date,
      objective: body.objective ?? null,
      title: body.title ?? null,
      event: normShortText(body.event),
      location: normShortText(body.location),
      created_by_user_id: user.id,
    })
    .select('id, date, objective, title, event, location')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ session: data })
}

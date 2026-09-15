// A crew member's own notes on a day — the notebook behind Campaign → Day.
//
//   GET ?date=YYYY-MM-DD[&kind=debrief]  → { note: { body, updatedAt } | null }
//   PUT { date, kind?, body }            → { note }
//
// Private by construction rather than by this file: 0066's RLS names auth.uid()
// and nothing else, so the filters below are about fetching the right row, not
// about keeping anybody out. A request for somebody else's page returns nothing
// because the database has nothing to give it.
//
// One row per person per day per kind, so the PUT is an UPSERT and saving twice
// is editing rather than appending. An empty body is a legitimate save: clearing
// what you wrote is a thing people do, and it must not resurrect the old text on
// the next load.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'

const KINDS = new Set(['debrief', 'speed', 'general'])
const kindOf = (v: unknown) => (typeof v === 'string' && KINDS.has(v) ? v : 'debrief')
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

interface Ctx { params: { teamId: string; boatId: string } }

const shape = (row: any) =>
  row ? { body: String(row.body ?? ''), updatedAt: Date.parse(row.updated_at) || null } : null

export async function GET(req: NextRequest, { params }: Ctx) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')
  if (!date || !ISO_DATE.test(date)) {
    return NextResponse.json({ error: 'date required (YYYY-MM-DD)' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('ssa_day_notes').select('body,updated_at')
    .eq('team_id', params.teamId).eq('boat_id', params.boatId)
    .eq('session_date', date).eq('kind', kindOf(searchParams.get('kind')))
    .eq('user_id', user.id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ note: shape(data) })
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const date: string | undefined = body?.date
  if (!date || !ISO_DATE.test(date)) {
    return NextResponse.json({ error: 'date required (YYYY-MM-DD)' }, { status: 400 })
  }
  // Long enough for anything anyone types into a day's notes, short enough that
  // a runaway paste cannot be used to fill the table.
  const text = String(body?.body ?? '').slice(0, 20000)

  const { data, error } = await supabase
    .from('ssa_day_notes')
    .upsert(
      {
        team_id: params.teamId,
        boat_id: params.boatId,
        session_date: date,
        user_id: user.id,
        kind: kindOf(body?.kind),
        body: text,
      },
      // The unique index from 0066. Without naming it, a second save inserts a
      // second page instead of editing the first.
      { onConflict: 'team_id,boat_id,session_date,user_id,kind' }
    )
    .select('body,updated_at')
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ note: shape(data) })
}

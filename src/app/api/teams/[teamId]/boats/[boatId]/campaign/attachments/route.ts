// Per-session file attachments (weather decks etc.). Files are uploaded
// straight to Bunny Storage from the browser; these endpoints register /
// list / remove the records and hand back Bunny-signed view URLs.
//
// GET    ?date=YYYY-MM-DD&kind=weather → { attachments: [{...,url}] }
// POST   body { date, kind, name, key, bytes?, content_type? }
// DELETE body { id }
//
// RLS enforces the write gate.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { signBunnyUrl } from '@/lib/bunny-signed-url'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const KINDS = ['weather', 'debrief', 'other']

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
  const kind = req.nextUrl.searchParams.get('kind') || 'weather'
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ error: 'valid ?date= required' }, { status: 400 })
  }
  const sessionId = await findSessionId(supabase, params.teamId, params.boatId, date)
  if (!sessionId) return NextResponse.json({ attachments: [] })

  const { data, error } = await supabase
    .from('session_attachments')
    .select('id, kind, name, key, bytes, content_type, created_at')
    .eq('session_id', sessionId)
    .eq('kind', kind)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const attachments = (data || []).map((a) => {
    const signed = a.key ? signBunnyUrl({ path: a.key, ttlSec: 3600 }) : null
    return { ...a, url: signed?.url || null }
  })
  return NextResponse.json({ attachments })
}

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
    | { date?: string; kind?: string; name?: string; key?: string; bytes?: number; content_type?: string }
    | null
  if (!body?.date || !DATE_RE.test(body.date) || !body?.name || !body?.key) {
    return NextResponse.json({ error: 'date, name and key required' }, { status: 400 })
  }
  const kind = KINDS.includes(body.kind as string) ? (body.kind as string) : 'other'

  // Ensure the session exists for this date.
  let sessionId = await findSessionId(supabase, params.teamId, params.boatId, body.date)
  if (!sessionId) {
    const { data: ins, error: insErr } = await supabase
      .from('sessions')
      .insert({ team_id: params.teamId, boat_id: params.boatId, date: body.date, created_by_user_id: user.id })
      .select('id')
      .single()
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
    sessionId = ins.id
  }

  const { data, error } = await supabase
    .from('session_attachments')
    .insert({
      session_id: sessionId,
      team_id: params.teamId,
      boat_id: params.boatId,
      kind,
      name: body.name,
      key: body.key,
      bytes: typeof body.bytes === 'number' ? body.bytes : null,
      content_type: body.content_type || null,
      created_by_user_id: user.id,
    })
    .select('id, kind, name, key, bytes, content_type')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const signed = signBunnyUrl({ path: body.key, ttlSec: 3600 })
  return NextResponse.json({ attachment: { ...data, url: signed?.url || null } })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { teamId: string; boatId: string } }
) {
  const supabase = getServerSupabase()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { id?: string } | null
  if (!body?.id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await supabase
    .from('session_attachments')
    .delete()
    .eq('id', body.id)
    .eq('team_id', params.teamId)
    .eq('boat_id', params.boatId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

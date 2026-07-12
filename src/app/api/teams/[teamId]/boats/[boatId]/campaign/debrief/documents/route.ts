// Debrief document records. The browser uploads the file straight to Bunny
// Storage (via uploadBlobToStorage), then calls POST here to register it.
//
// POST   body { date, name, key, thumb_key?, bytes?, content_type? } → append to documents[]
//        thumb_key = a small pre-scaled JPEG for pictures, so grids don't download
//        the multi-MB original just to paint a 94px box.
// DELETE body { date, key } → remove the record (the Bunny object is left in
//        place; storage cleanup is a separate housekeeping concern).
//
// RLS enforces the write gate on the debriefs row.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

async function getDebrief(
  supabase: ReturnType<typeof getServerSupabase>,
  teamId: string,
  boatId: string,
  date: string
): Promise<{ id: string; documents: unknown[] } | null> {
  const { data: sess } = await supabase
    .from('sessions')
    .select('id')
    .eq('team_id', teamId)
    .eq('boat_id', boatId)
    .eq('date', date)
    .maybeSingle()
  if (!sess) return null
  const { data } = await supabase
    .from('debriefs')
    .select('id, documents')
    .eq('session_id', sess.id)
    .maybeSingle()
  if (!data) return null
  return { id: data.id, documents: Array.isArray(data.documents) ? data.documents : [] }
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
    | { date?: string; name?: string; key?: string; thumb_key?: string; bytes?: number; content_type?: string; scope?: string }
    | null
  if (!body?.date || !DATE_RE.test(body.date) || !body?.key || !body?.name) {
    return NextResponse.json({ error: 'date, name and key required' }, { status: 400 })
  }
  // Scope separates debrief docs from speed-meeting docs (and any future
  // notes card). Older rows without a scope are treated as 'debrief'.
  const scope = body.scope === 'speed' ? 'speed' : 'debrief'

  // Ensure session + debrief row exist.
  let dbf = await getDebrief(supabase, params.teamId, params.boatId, body.date)
  if (!dbf) {
    let { data: sess } = await supabase
      .from('sessions')
      .select('id')
      .eq('team_id', params.teamId)
      .eq('boat_id', params.boatId)
      .eq('date', body.date)
      .maybeSingle()
    if (!sess) {
      const r = await supabase
        .from('sessions')
        .insert({ team_id: params.teamId, boat_id: params.boatId, date: body.date, created_by_user_id: user.id })
        .select('id')
        .single()
      if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 })
      sess = r.data
    }
    const ins = await supabase
      .from('debriefs')
      .insert({ session_id: sess.id, team_id: params.teamId, boat_id: params.boatId, created_by_user_id: user.id })
      .select('id, documents')
      .single()
    if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 })
    dbf = { id: ins.data.id, documents: [] }
  }

  const doc = {
    key: body.key,
    // Pre-scaled JPEG for picture grids. Null for non-images (and for older rows),
    // in which case the client falls back to the original.
    thumb_key: typeof body.thumb_key === 'string' ? body.thumb_key : null,
    name: body.name,
    bytes: typeof body.bytes === 'number' ? body.bytes : null,
    content_type: body.content_type || null,
    scope,
    uploaded_at: new Date().toISOString(),
    uploaded_by: user.id,
  }
  const next = [...dbf.documents, doc]
  const { error } = await supabase.from('debriefs').update({ documents: next }).eq('id', dbf.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, document: doc })
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

  const body = (await req.json().catch(() => null)) as { date?: string; key?: string } | null
  if (!body?.date || !DATE_RE.test(body.date) || !body?.key) {
    return NextResponse.json({ error: 'date and key required' }, { status: 400 })
  }
  const dbf = await getDebrief(supabase, params.teamId, params.boatId, body.date)
  if (!dbf) return NextResponse.json({ ok: true })

  const next = dbf.documents.filter(
    (d) => (d as { key?: string }).key !== body.key
  )
  const { error } = await supabase.from('debriefs').update({ documents: next }).eq('id', dbf.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

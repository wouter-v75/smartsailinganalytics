// The signed-in user's own favourite photos and videos — the hearts.
//
//   GET                            → { photo: string[], video: string[] }
//                                    or { available: false } before 0098 is applied
//   POST { kind, id, favourite }   → { ok: true }
//
// Personal and team-agnostic from the client's side: a heart knows only the
// photo or clip it sits on. The team is read off that media row HERE, under the
// caller's RLS — which also means nobody can favourite a photo they cannot see.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'

const KINDS = { photo: 'photos', video: 'videos' } as const
type Kind = keyof typeof KINDS

// 42P01 = undefined_table: the migration has not been pasted yet. Say so as a
// state rather than an error, so the hearts can simply stay hidden until it is.
const missingTable = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' ||
    (/media_favourites/.test(e.message || '') && /not exist|schema cache/i.test(e.message || '')))

export async function GET() {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data, error } = await supabase.from('media_favourites').select('kind,media_id').eq('user_id', user.id)
  if (missingTable(error)) return NextResponse.json({ available: false, photo: [], video: [] })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const out: Record<Kind, string[]> = { photo: [], video: [] }
  for (const r of data || []) if (r.kind === 'photo' || r.kind === 'video') out[r.kind as Kind].push(r.media_id)
  return NextResponse.json({ available: true, ...out })
}

export async function POST(req: NextRequest) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const kind = body?.kind as Kind
  const id = typeof body?.id === 'string' ? body.id : ''
  if (!(kind in KINDS) || !/^[0-9a-f-]{36}$/i.test(id) || typeof body?.favourite !== 'boolean') {
    return NextResponse.json({ error: 'kind (photo|video), id (uuid) and favourite (boolean) required' }, { status: 400 })
  }

  if (!body.favourite) {
    const { error } = await supabase.from('media_favourites').delete()
      .eq('user_id', user.id).eq('kind', kind).eq('media_id', id)
    if (missingTable(error)) return NextResponse.json({ error: 'Favourites are not set up yet (migration 0098).' }, { status: 503 })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  const { data: media, error: mErr } = await supabase.from(KINDS[kind]).select('id,team_id').eq('id', id).maybeSingle()
  if (mErr) return NextResponse.json({ error: mErr.message }, { status: 500 })
  if (!media) return NextResponse.json({ error: `No such ${kind}` }, { status: 404 })

  const { error } = await supabase.from('media_favourites')
    .upsert({ user_id: user.id, kind, media_id: id, team_id: media.team_id }, { onConflict: 'user_id,kind,media_id', ignoreDuplicates: true })
  if (missingTable(error)) return NextResponse.json({ error: 'Favourites are not set up yet (migration 0098).' }, { status: 503 })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

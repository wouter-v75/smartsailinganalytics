// Mark a photo or video NOT RELEVANT to one sail, or undo that.
//
//   POST { id, hidden: boolean }  → { hidden: string[] }  (the sail's list after)
//
// Kept on the sail, in specs.media_hidden — a mark is a fact about one sail,
// like its aliases, so it travels and dies with it and needs no table. One id
// per request, toggled here against the row as it is NOW: sending the whole
// list back from a client would let two people hiding at once erase each
// other's marks. RLS on sails (TL3+, 0036) decides who may.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { mergeSpecs } from '@/lib/sailEdit'
import { hiddenMediaOf, toggleHidden } from '@/lib/sailMedia'

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string; sailId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const id = typeof body?.id === 'string' ? body.id.trim() : ''
  if (!id || typeof body?.hidden !== 'boolean') {
    return NextResponse.json({ error: 'id and hidden (boolean) required' }, { status: 400 })
  }

  const { data: sail, error } = await supabase
    .from('sails').select('id,specs').eq('team_id', params.teamId).eq('id', params.sailId).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!sail) return NextResponse.json({ error: 'No such sail' }, { status: 404 })

  const current = hiddenMediaOf(sail.specs)
  const next = toggleHidden(current, id, body.hidden)
  if (!next) return NextResponse.json({ hidden: current })

  // .select() so a write RLS refused comes back as zero rows rather than as a
  // silent success — an update the policy filters out is not an error.
  const { data: rows, error: upErr } = await supabase
    .from('sails').update({ specs: mergeSpecs(sail.specs, { media_hidden: next }) })
    .eq('team_id', params.teamId).eq('id', params.sailId).select('id')
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
  if (!rows?.length) return NextResponse.json({ error: 'Not allowed to change this sail' }, { status: 403 })
  return NextResponse.json({ hidden: next })
}

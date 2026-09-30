// Everything that shows one sail: SailScans, SailTrim frames, 360 video, photos
// and video, each with the TWS it was taken in and the event it belongs to.
//
//   GET  → { sail, items: SailMediaItem[], events: string[], taggedDays, days }
//
// Which media belong to the sail is worked out in lib/sailMedia from the time
// each was taken — the day's sail-change tags, else its phases, else the photo's
// own sail list. Nothing is tagged per photo. The boat's media is read by
// lib/sailMediaLoad, which the inventory's counts (sails/media-counts) share.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { sailMedia } from '@/lib/sailMedia'
import { loadBoatMedia, inputFor } from '@/lib/sailMediaLoad'

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string; sailId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data: sail, error: sErr } = await supabase
    .from('sails').select('id,boat_id,name,kind,category')
    .eq('team_id', params.teamId).eq('id', params.sailId).maybeSingle()
  if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 })
  if (!sail) return NextResponse.json({ error: 'No such sail' }, { status: 404 })

  let media
  try {
    media = await loadBoatMedia(supabase, params.teamId, sail.boat_id as string)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }

  const items = sailMedia(inputFor(media, sail)).map((m) => {
    if (m.kind === 'scan') return { ...m, scan: media.scanRows.get(m.id) }
    if (m.kind === 'photo' || m.kind === 'trim') return { ...m, photo: media.photoById.get(m.id) }
    return m
  })
  const events = Array.from(new Set(items.map((i) => i.event).filter((e): e is string => !!e))).sort()
  const days = Object.values(media.base.days)

  return NextResponse.json({
    sail: { id: sail.id, name: sail.name, category: sail.category, kind: sail.kind },
    items,
    events,
    // How many days the crew's sail-change tags cover — the rest were placed
    // from the event file's sails, which the footnote says.
    taggedDays: days.filter((d) => d.tags.length).length,
    days: days.length,
  })
}

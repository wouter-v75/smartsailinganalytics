// Everything that shows one sail: SailScans, SailTrim frames, 360 video, photos
// and video, each with the TWS it was taken in and the event it belongs to.
//
//   GET  → { sail, items: SailMediaItem[], events: string[] }
//
// Which media belong to the sail is worked out in lib/sailMedia from the time
// each was taken — the day's sail-change tags, else its phases, else the photo's
// own sail list. Nothing is tagged per photo. RLS gates every read through the
// caller's session, so a role that cannot read scans simply gets none.

import { NextRequest, NextResponse } from 'next/server'
import { getServerSupabase } from '@/lib/supabase/server'
import { signBunnyUrl, bunnyConfigured } from '@/lib/bunny-signed-url'
import { TAG_EVENT_COLUMNS, toTagEvent } from '@/lib/tagging/rowMap'
import { SAIL_CHANGE_SLUG } from '@/lib/tagging/sailState'
import { sailMedia, type DayContext, type PhotoIn, type ScanIn, type VideoIn } from '@/lib/sailMedia'
import type { StoredPhase } from '@/lib/seasonCurves'
import type { TagEvent } from '@/lib/tagging/types'

const CDN_HOST = process.env.BUNNY_CDN_HOSTNAME || ''
const PAGE = 1000
const MAX_PHOTOS = 20_000

const sign = (path: string | null | undefined, ttlSec = 6 * 3600): string | null =>
  path && bunnyConfigured() ? signBunnyUrl({ path, ttlSec })?.url || null : null

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((s) => (typeof s === 'string' ? s : (s as { name?: string })?.name)).filter((s): s is string => !!s) : []

export async function GET(
  _req: NextRequest,
  { params }: { params: { teamId: string; sailId: string } }
) {
  const supabase = getServerSupabase()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauth' }, { status: 401 })

  const { data: sail, error: sErr } = await supabase
    .from('sails').select('id,boat_id,name,kind,category,retired,specs')
    .eq('team_id', params.teamId).eq('id', params.sailId).maybeSingle()
  if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 })
  if (!sail) return NextResponse.json({ error: 'No such sail' }, { status: 404 })
  const boatId = sail.boat_id as string

  const [invQ, scanQ, videoQ, tagQ] = await Promise.all([
    supabase.from('sails').select('id,name,kind,retired,specs').eq('team_id', params.teamId).eq('boat_id', boatId)
      .order('retired', { ascending: true }).order('category', { ascending: true }),
    supabase.from('sail_scans')
      .select('id,sail_id,session_id,captured_at,source,tws_kn,twa_deg,conditions,stripes,summary,report_ref,notes,updated_at,sessions:sessions(date,event)')
      .eq('team_id', params.teamId).eq('boat_id', boatId).order('captured_at', { ascending: false }).limit(1000),
    supabase.from('videos')
      .select('id,title,start_utc,duration_ms,sync_offset_secs,tags,thumbnail_url,bunny_stream_id,bunny_original_stream_id,bunny_proxy_stream_id,sessions:sessions(date,event)')
      .eq('team_id', params.teamId).eq('boat_id', boatId).limit(2000),
    supabase.from('ssa_tag_events').select(TAG_EVENT_COLUMNS)
      .eq('team_id', params.teamId).eq('boat_id', boatId).eq('slug', SAIL_CHANGE_SLUG).eq('rejected', false)
      .order('t0', { ascending: true }),
  ])
  for (const q of [invQ, videoQ, tagQ]) if (q.error) return NextResponse.json({ error: q.error.message }, { status: 500 })

  // Photos in pages: a boat's season runs to thousands of frames. Only the few
  // analysis_data keys the grid needs — the rest of that blob can be large.
  const photoRows: any[] = []
  for (let from = 0; from < MAX_PHOTOS; from += PAGE) {
    const { data, error } = await supabase.from('photos')
      .select('id,taken_utc,bunny_storage_path,subject_boat_ids,a_sails:analysis_data->sails,a_tws:analysis_data->tws,inst:analysis_data->inst,trim:analysis_data->sailTrim,sessions:sessions(date,event)')
      .eq('team_id', params.teamId).eq('boat_id', boatId)
      .order('taken_utc', { ascending: false }).range(from, from + PAGE - 1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    photoRows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }

  const inventory = (invQ.data || []).map((s: any) => ({
    id: s.id, name: s.name, aliases: Array.isArray(s.specs?.aliases) ? s.specs.aliases : [],
  }))
  const activeMains = (invQ.data || []).filter((s: any) => s.kind === 'mainsail' && !s.retired)
  const main = sail.kind === 'mainsail' ? (activeMains.length <= 1 ? 'only' as const : 'several' as const) : undefined

  // Days: event names from the sessions, tags per date, phases for the dates
  // that have something to place.
  const days: Record<string, DayContext> = {}
  const day = (date: string, event: string | null = null) =>
    (days[date] ||= { event, tags: [], phases: [] })
  const sessionOf = (r: any): { date: string | null; event: string | null } => {
    const s = Array.isArray(r.sessions) ? r.sessions[0] : r.sessions
    return { date: s?.date ?? null, event: s?.event ?? null }
  }
  for (const r of [...(scanQ.data || []), ...(videoQ.data || []), ...photoRows]) {
    const s = sessionOf(r)
    if (s.date) { const d = day(s.date, s.event); if (!d.event && s.event) d.event = s.event }
  }
  for (const t of (tagQ.data || []).map(toTagEvent) as TagEvent[]) day(t.sessionDate).tags.push(t)

  const dates = Object.keys(days)
  if (dates.length) {
    const { data: ps, error } = await supabase.from('session_phase_stats')
      .select('date,phases').eq('team_id', params.teamId).eq('boat_id', boatId).in('date', dates)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    for (const row of ps || []) {
      day(row.date).phases = ((row.phases || []) as StoredPhase[])
        .map((p) => ({ utc: p.u, endUtc: p.e, sails: String(p.s || '').split('/').map((x) => x.trim()).filter(Boolean), tws: num(p.v?.tws) }))
        .sort((a, b) => a.utc - b.utc)
    }
  }

  // Scans need the full row for the detail view; keep it by id.
  const scanRows = new Map<string, any>()
  const scans: ScanIn[] = (scanQ.error ? [] : scanQ.data || []).map((r: any) => {
    const photo_url = sign(r.conditions?.photo_key, 3600)
    const { sessions: _s, ...row } = r
    scanRows.set(r.id, { ...row, photo_url })
    const s = sessionOf(r)
    return { id: r.id, sail_id: r.sail_id, captured_at: r.captured_at, tws_kn: num(r.tws_kn), conditions: r.conditions, photo_url, date: s.date, event: s.event }
  })

  const photoById = new Map<string, any>()
  const photos: PhotoIn[] = photoRows.map((r: any) => {
    const path: string | null = r.bunny_storage_path
    const thumb = sign(path ? path.replace(/\.jpe?g$/i, '_thumb.jpg') : null)
    const inst = r.inst && typeof r.inst === 'object' ? r.inst : {}
    const sails = strList(r.a_sails).length ? strList(r.a_sails) : strList(inst.sails)
    const trim = r.trim && typeof r.trim === 'object' && r.trim.annotation ? r.trim : null
    photoById.set(r.id, { thumb, original: sign(path), inst: { ...inst, sails }, sailTrim: trim, subjectBoatIds: r.subject_boat_ids || [] })
    return { id: r.id, taken_utc: r.taken_utc, date: sessionOf(r).date, thumb, sails, tws: num(inst.tws) ?? num(r.a_tws), trim: !!trim }
  })

  const videos: VideoIn[] = (videoQ.data || []).map((r: any) => {
    const sid = r.bunny_original_stream_id || r.bunny_proxy_stream_id || r.bunny_stream_id
    return {
      id: r.id, start_utc: r.start_utc, duration_ms: r.duration_ms, sync_offset_secs: r.sync_offset_secs,
      date: sessionOf(r).date, title: r.title, tags: r.tags,
      thumb: r.thumbnail_url || (sid && CDN_HOST ? `https://${CDN_HOST}/${sid}/thumbnail.jpg` : null),
    }
  })

  const items = sailMedia({ sailId: sail.id, inventory, main, scans, photos, videos, days }).map((m) => {
    if (m.kind === 'scan') return { ...m, scan: scanRows.get(m.id) }
    if (m.kind === 'photo' || m.kind === 'trim') return { ...m, photo: photoById.get(m.id) }
    return m
  })
  const events = Array.from(new Set(items.map((i) => i.event).filter((e): e is string => !!e))).sort()

  return NextResponse.json({
    sail: { id: sail.id, name: sail.name, category: sail.category, kind: sail.kind },
    items,
    events,
    // How many days the crew's sail-change tags cover — the rest were placed
    // from the event file's sails, which the footnote says.
    taggedDays: Object.values(days).filter((d) => d.tags.length).length,
    days: Object.keys(days).length,
  })
}

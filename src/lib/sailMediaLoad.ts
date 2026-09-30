// src/lib/sailMediaLoad.ts
// ─────────────────────────────────────────────────────────────────────────────
// Read everything lib/sailMedia needs for ONE boat: its inventory, SailScans,
// photos, videos, sail-change tags and the phases of the days they fall on.
//
// Shared by the two routes that place media on sails — one sail's grid
// (sails/[sailId]/media) and every sail's counts (sails/media-counts) — so the
// counts in the inventory can never disagree with the grid they open.
//
// Server-only: it takes the caller's Supabase client, so RLS decides what each
// role sees (a role that cannot read scans simply gets none).
// ─────────────────────────────────────────────────────────────────────────────

import { signBunnyUrl, bunnyConfigured } from './bunny-signed-url'
import { TAG_EVENT_COLUMNS, toTagEvent } from './tagging/rowMap'
import { SAIL_CHANGE_SLUG } from './tagging/sailState'
import type { LinkableSail } from './tagging/sailLink'
import type { TagEvent } from './tagging/types'
import type { StoredPhase } from './seasonCurves'
import type { DayContext, PhotoIn, ScanIn, SailMediaInput, VideoIn } from './sailMedia'

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

const sessionOf = (r: any): { date: string | null; event: string | null } => {
  const s = Array.isArray(r.sessions) ? r.sessions[0] : r.sessions
  return { date: s?.date ?? null, event: s?.event ?? null }
}

export interface InventoryRow { id: string; name: string; kind: string | null; category: string | null; retired: boolean; specs: any }

export interface BoatMedia {
  inventoryRows: InventoryRow[]
  /** Everything sailMedia needs except which sail — see inputFor(). */
  base: Omit<SailMediaInput, 'sailId' | 'main'>
  /** Full scan rows (thumbnail signed) for the detail view, by id. Empty when light. */
  scanRows: Map<string, any>
  /** What the photo viewer opens on before the full row arrives, by id. */
  photoById: Map<string, any>
}

/**
 * @param light  counts only: no signed URLs and no scan stripes — a URL signed
 *               for every photo of a season is wasted work when nobody looks.
 */
export async function loadBoatMedia(
  supabase: any, teamId: string, boatId: string, { light = false }: { light?: boolean } = {}
): Promise<BoatMedia> {
  const [invQ, scanQ, videoQ, tagQ] = await Promise.all([
    supabase.from('sails').select('id,name,kind,category,retired,specs').eq('team_id', teamId).eq('boat_id', boatId)
      .order('retired', { ascending: true }).order('category', { ascending: true }),
    supabase.from('sail_scans')
      .select(light
        ? 'id,sail_id,captured_at,tws_kn,conditions,sessions:sessions(date,event)'
        : 'id,sail_id,session_id,captured_at,source,tws_kn,twa_deg,conditions,stripes,summary,report_ref,notes,updated_at,sessions:sessions(date,event)')
      .eq('team_id', teamId).eq('boat_id', boatId).order('captured_at', { ascending: false }).limit(1000),
    supabase.from('videos')
      .select('id,title,start_utc,duration_ms,sync_offset_secs,tags,thumbnail_url,bunny_stream_id,bunny_original_stream_id,bunny_proxy_stream_id,sessions:sessions(date,event)')
      .eq('team_id', teamId).eq('boat_id', boatId).limit(2000),
    supabase.from('ssa_tag_events').select(TAG_EVENT_COLUMNS)
      .eq('team_id', teamId).eq('boat_id', boatId).eq('slug', SAIL_CHANGE_SLUG).eq('rejected', false)
      .order('t0', { ascending: true }),
  ])
  for (const q of [invQ, videoQ, tagQ]) if (q.error) throw new Error(q.error.message)

  // Photos in pages: a boat's season runs to thousands of frames. Only the few
  // analysis_data keys needed — the rest of that blob can be large.
  const photoRows: any[] = []
  for (let from = 0; from < MAX_PHOTOS; from += PAGE) {
    const { data, error } = await supabase.from('photos')
      .select('id,taken_utc,bunny_storage_path,subject_boat_ids,a_sails:analysis_data->sails,a_tws:analysis_data->tws,inst:analysis_data->inst,trim:analysis_data->sailTrim,sessions:sessions(date,event)')
      .eq('team_id', teamId).eq('boat_id', boatId)
      .order('taken_utc', { ascending: false }).range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    photoRows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }

  const inventoryRows: InventoryRow[] = invQ.data || []
  const inventory: LinkableSail[] = inventoryRows.map((s) => ({
    id: s.id, name: s.name, aliases: Array.isArray(s.specs?.aliases) ? s.specs.aliases : [],
  }))

  // Days: event names from the sessions, tags per date, phases for the dates
  // that have something to place.
  const days: Record<string, DayContext> = {}
  const day = (date: string, event: string | null = null) =>
    (days[date] ||= { event, tags: [], phases: [] })
  for (const r of [...(scanQ.data || []), ...(videoQ.data || []), ...photoRows]) {
    const s = sessionOf(r)
    if (s.date) { const d = day(s.date, s.event); if (!d.event && s.event) d.event = s.event }
  }
  for (const t of (tagQ.data || []).map(toTagEvent) as TagEvent[]) day(t.sessionDate).tags.push(t)

  const dates = Object.keys(days)
  if (dates.length) {
    const { data: ps, error } = await supabase.from('session_phase_stats')
      .select('date,phases').eq('team_id', teamId).eq('boat_id', boatId).in('date', dates)
    if (error) throw new Error(error.message)
    for (const row of ps || []) {
      day(row.date).phases = ((row.phases || []) as StoredPhase[])
        .map((p) => ({ utc: p.u, endUtc: p.e, sails: String(p.s || '').split('/').map((x) => x.trim()).filter(Boolean), tws: num(p.v?.tws) }))
        .sort((a, b) => a.utc - b.utc)
    }
  }

  const scanRows = new Map<string, any>()
  const scans: ScanIn[] = (scanQ.error ? [] : scanQ.data || []).map((r: any) => {
    const photo_url = light ? null : sign(r.conditions?.photo_key, 3600)
    if (!light) { const { sessions: _s, ...row } = r; scanRows.set(r.id, { ...row, photo_url }) }
    const s = sessionOf(r)
    return { id: r.id, sail_id: r.sail_id, captured_at: r.captured_at, tws_kn: num(r.tws_kn), conditions: r.conditions, photo_url, date: s.date, event: s.event }
  })

  const photoById = new Map<string, any>()
  const photos: PhotoIn[] = photoRows.map((r: any) => {
    const path: string | null = r.bunny_storage_path
    const thumb = light ? null : sign(path ? path.replace(/\.jpe?g$/i, '_thumb.jpg') : null)
    const inst = r.inst && typeof r.inst === 'object' ? r.inst : {}
    const sails = strList(r.a_sails).length ? strList(r.a_sails) : strList(inst.sails)
    const trim = r.trim && typeof r.trim === 'object' && r.trim.annotation ? r.trim : null
    if (!light) photoById.set(r.id, { thumb, original: sign(path), inst: { ...inst, sails }, sailTrim: trim, subjectBoatIds: r.subject_boat_ids || [] })
    return { id: r.id, taken_utc: r.taken_utc, date: sessionOf(r).date, thumb, sails, tws: num(inst.tws) ?? num(r.a_tws), trim: !!trim }
  })

  const cdn = process.env.BUNNY_CDN_HOSTNAME || ''
  const videos: VideoIn[] = (videoQ.data || []).map((r: any) => {
    const sid = r.bunny_original_stream_id || r.bunny_proxy_stream_id || r.bunny_stream_id
    return {
      id: r.id, start_utc: r.start_utc, duration_ms: r.duration_ms, sync_offset_secs: r.sync_offset_secs,
      date: sessionOf(r).date, title: r.title, tags: r.tags,
      thumb: r.thumbnail_url || (sid && cdn ? `https://${cdn}/${sid}/thumbnail.jpg` : null),
    }
  })

  return { inventoryRows, base: { inventory, scans, photos, videos, days }, scanRows, photoById }
}

/**
 * The input for one sail. A MAINSAIL needs saying so, because the phases
 * carry headsails only: the boat's one active main was up whenever it sailed;
 * with several, the phases cannot say which.
 */
export function inputFor(media: BoatMedia, sail: { id: string; kind?: string | null }): SailMediaInput {
  const activeMains = media.inventoryRows.filter((s) => s.kind === 'mainsail' && !s.retired)
  const main = sail.kind === 'mainsail' ? (activeMains.length <= 1 ? 'only' as const : 'several' as const) : undefined
  return { ...media.base, sailId: sail.id, main }
}

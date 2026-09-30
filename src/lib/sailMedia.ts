// src/lib/sailMedia.ts
// ─────────────────────────────────────────────────────────────────────────────
// Everything that shows ONE sail, by wind band: its SailScans, its SailTrim
// frames, 360 video, photos and video.
//
// Nothing here is tagged by hand. A photo or clip belongs to a sail because the
// sail was UP at that instant, and "what was up" is already on record three
// ways, in order of trust:
//
//   1. the day's sail-change tags (lib/tagging/sailState) — the crew's own
//      state, corrected in review, and the only source that knows about a peel
//      the event file missed;
//   2. the 30 s phases in session_phase_stats, whose sails came from the
//      event file's sails-up log — headsails and kites ONLY (the stored
//      `sailCombo`), so a phase says nothing about which main was up. A boat
//      with one mainsail had it up whenever it was sailing; a boat with two has
//      to be told, by the tags or by the photo;
//   3. a photo's own `sails`, written at import from that same event file.
//
// A day with sail-change tags is read from the tags ONLY. Mixing would let the
// event file put back a kite the crew said they had dropped.
//
// VIDEO is placed by its moments, not as a whole: a clip that starts on the J2
// at 11 kn and ends on the J3 at 16 is a J2 clip at 11 AND a J3 clip at 16, and
// each entry starts playing where that part begins. One entry per clip per band
// (the longest stretch in it), so a long clip cannot flood a column.
//
// Pure — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

import { SAIL_CHANGE_SLUG, sailChanges, sailStateAt, type SailRef } from './tagging/sailState'
import { nameKey, sailLinks, type LinkableSail } from './tagging/sailLink'
import type { TagEvent } from './tagging/types'

export type SailMediaKind = 'scan' | 'trim' | 'video360' | 'photo' | 'video'

/** Column order in the grid. */
export const SAIL_MEDIA_KINDS: { kind: SailMediaKind; label: string }[] = [
  { kind: 'scan', label: 'SailScans' },
  { kind: 'trim', label: 'SailTrim' },
  { kind: 'video360', label: '360 video' },
  { kind: 'photo', label: 'Photos' },
  { kind: 'video', label: 'Videos' },
]

export interface SailMediaItem {
  kind: SailMediaKind
  id: string
  /** Epoch ms of the moment shown — for a video, where its stretch starts. */
  t: number
  date: string | null
  event: string | null
  tws: number | null
  thumb: string | null
  /** Marked not relevant to THIS sail (sails.specs.media_hidden). Kept, not
   *  dropped, so the grid can show it again and a mark can be undone. */
  hidden?: boolean
  /** Video only: seconds into the clip where this sail/band begins, and for how long. */
  startSec?: number
  durSec?: number
  title?: string | null
}

// ── TWS bands ────────────────────────────────────────────────────────────────
// 2 kn wide and centred on the even numbers (edges 5 · 7 · … · 25): the KND
// wind-band table's widths, and the same bands the phase charts use.
export const TWS_EDGES = [5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25]

export interface TwsBand { key: string; label: string; order: number }

export const UNKNOWN_BAND: TwsBand = { key: 'unknown', label: 'TWS unknown', order: 999 }

export function twsBand(tws: number | null | undefined): TwsBand {
  if (tws == null || !Number.isFinite(tws)) return UNKNOWN_BAND
  const e = TWS_EDGES
  if (tws < e[0]) return { key: `lt${e[0]}`, label: `< ${e[0]} kn`, order: 0 }
  for (let i = 1; i < e.length; i++) {
    if (tws < e[i]) return { key: `${e[i - 1]}-${e[i]}`, label: `${(e[i - 1] + e[i]) / 2} kn`, order: i }
  }
  const top = e[e.length - 1]
  return { key: `ge${top}`, label: `${top}+ kn`, order: e.length }
}

/** Every band in order, for rows that should show even when empty. */
export function allTwsBands(): TwsBand[] {
  const out: TwsBand[] = [twsBand(TWS_EDGES[0] - 1)]
  for (let i = 1; i < TWS_EDGES.length; i++) out.push(twsBand((TWS_EDGES[i - 1] + TWS_EDGES[i]) / 2))
  out.push(twsBand(TWS_EDGES[TWS_EDGES.length - 1] + 1))
  return out
}

// ── 360 ──────────────────────────────────────────────────────────────────────
// There is no projection column. A clip is 360 when somebody tagged it "360",
// or its title says so (Insta360 exports keep .insv / "360" in the name).
export function isVideo360(v: { title?: string | null; tags?: unknown }): boolean {
  const tags = Array.isArray(v.tags) ? v.tags : []
  if (tags.some((t) => /^\s*360\s*°?\s*$/i.test(String(t)) || /\b360\b/i.test(String(t)))) return true
  return /\b360\b|\.insv\b|insta ?360|equirect/i.test(String(v.title || ''))
}

// ── inputs ───────────────────────────────────────────────────────────────────
export interface PhaseLite { utc: number; endUtc: number; sails: string[]; tws: number | null }

export interface DayContext {
  event: string | null
  /** Sail-change tags for the day (any others are ignored). */
  tags: TagEvent[]
  /** The day's 30 s phases, oldest first (phaseAt binary-searches them). Empty when the day has no log. */
  phases: PhaseLite[]
}

export interface ScanIn {
  id: string; sail_id?: string | null; captured_at?: string | null; tws_kn?: number | null
  conditions?: Record<string, unknown> | null; photo_url?: string | null
  date?: string | null; event?: string | null
}
export interface PhotoIn {
  id: string; taken_utc?: string | null; date?: string | null; thumb?: string | null
  sails?: string[] | null; tws?: number | null; trim?: boolean
}
export interface VideoIn {
  id: string; start_utc?: string | null; duration_ms?: number | null; sync_offset_secs?: number | null
  date?: string | null; title?: string | null; tags?: unknown; thumb?: string | null
}

export interface SailMediaInput {
  sailId: string
  /**
   * Set when the sail is a MAINSAIL, which the phases cannot see:
   *   'only'     the boat's one active main — up whenever there is a phase;
   *   'several'  one of two or more — the phases cannot say which.
   */
  main?: 'only' | 'several'
  /**
   * Photo and video ids somebody marked not relevant to this sail. Per SAIL:
   * a frame that says nothing about the J2 can still be the best shot of the
   * main. Scans are not hidden this way — a scan is filed to a sail, and the
   * fix for a wrong one is to refile it.
   */
  hidden?: readonly string[]
  /** The whole boat inventory — aliases resolve against it, first-wins. */
  inventory: LinkableSail[]
  scans: ScanIn[]
  photos: PhotoIn[]
  videos: VideoIn[]
  days: Record<string, DayContext>
}

const toMs = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : NaN
}

// ── the resolver ─────────────────────────────────────────────────────────────
export function sailMedia(input: SailMediaInput): SailMediaItem[] {
  const links = sailLinks(input.inventory)
  const isOurs = (ref: SailRef | string | null | undefined): boolean => {
    if (!ref) return false
    const r: SailRef = typeof ref === 'string' ? { name: ref } : ref
    if (r.id && r.id === input.sailId) return true
    return links.get(nameKey(r.name))?.id === input.sailId
  }
  const anyOurs = (list: readonly (SailRef | string)[] | null | undefined) => (list || []).some(isOurs)

  // Only the tags that carry a sail state, per day, and whether there are any.
  const tagDays = new Map<string, TagEvent[]>()
  for (const [date, d] of Object.entries(input.days)) {
    const tags = (d.tags || []).filter((t) => t.slug === SAIL_CHANGE_SLUG)
    if (sailChanges(tags).length) tagDays.set(date, tags)
  }

  const phaseAt = (date: string | null, t: number): PhaseLite | null => {
    const ph = date ? input.days[date]?.phases : null
    if (!ph?.length) return null
    // Binary search: phases are sorted, and the counts run this for every
    // photo of the season once per sail.
    let lo = 0, hi = ph.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (t < ph[mid].utc) hi = mid - 1
      else if (t >= ph[mid].endUtc) lo = mid + 1
      else return ph[mid]
    }
    return null
  }

  /** Was our sail up at t? null = nothing on record for that instant. */
  const upAt = (date: string | null, t: number): boolean | null => {
    const tags = date ? tagDays.get(date) : undefined
    if (tags) return anyOurs(sailStateAt(tags, t).up)
    const p = phaseAt(date, t)
    if (!p) return null
    if (input.main === 'only') return true
    if (input.main === 'several') return null
    return anyOurs(p.sails)
  }

  const eventOf = (date: string | null | undefined) => (date ? input.days[date]?.event ?? null : null)
  const out: SailMediaItem[] = []

  // SailScans: filed against the sail, or unfiled with a sail code that resolves to it.
  for (const s of input.scans) {
    const c = s.conditions || {}
    const code = (c.sail_code as string) || (c.sail_name_in_report as string) || null
    if (s.sail_id ? s.sail_id !== input.sailId : !isOurs(code)) continue
    const t = toMs(s.captured_at)
    out.push({
      kind: 'scan', id: s.id, t: Number.isFinite(t) ? t : 0,
      date: s.date ?? (s.captured_at ? s.captured_at.slice(0, 10) : null),
      event: s.event ?? eventOf(s.date), tws: s.tws_kn ?? null, thumb: s.photo_url ?? null,
    })
  }

  // Photos, and the ones measured with SailTrim.
  for (const p of input.photos) {
    const t = toMs(p.taken_utc)
    if (!Number.isFinite(t)) continue
    const date = p.date ?? null
    const up = upAt(date, t) ?? (p.sails?.length ? anyOurs(p.sails) : null)
    if (!up) continue
    out.push({
      kind: p.trim ? 'trim' : 'photo', id: p.id, t, date, event: eventOf(date),
      tws: p.tws ?? phaseAt(date, t)?.tws ?? null, thumb: p.thumb ?? null,
    })
  }

  // Video, per stretch.
  for (const v of input.videos) {
    const start = toMs(v.start_utc)
    if (!Number.isFinite(start)) continue
    const date = v.date ?? null
    // Log time of the clip's first frame (VideoPlayer: log = start + (sec + sync)).
    const logStart = start + (Number(v.sync_offset_secs) || 0) * 1000
    const logEnd = logStart + Math.max(0, Number(v.duration_ms) || 0)

    // Moments to test: the phases inside the clip, or every 30 s without them.
    const samples: { t: number; end: number; tws: number | null }[] = []
    const ph = date ? input.days[date]?.phases || [] : []
    for (const p of ph) {
      if (p.endUtc <= logStart || p.utc >= logEnd) continue
      samples.push({ t: Math.max(p.utc, logStart), end: Math.min(p.endUtc, logEnd), tws: p.tws })
    }
    if (!samples.length) {
      for (let t = logStart; t < Math.max(logEnd, logStart + 1); t += 30_000) {
        samples.push({ t, end: Math.min(t + 30_000, Math.max(logEnd, t + 1)), tws: null })
      }
    }

    // Runs of consecutive moments with our sail up and the same band.
    const best = new Map<string, { t0: number; t1: number; tws: number[] }>()
    let run: { band: string; t0: number; t1: number; tws: number[] } | null = null
    const close = () => {
      if (!run) return
      const had = best.get(run.band)
      if (!had || run.t1 - run.t0 > had.t1 - had.t0) best.set(run.band, run)
      run = null
    }
    for (const s of samples) {
      if (!upAt(date, s.t)) { close(); continue }
      const band = twsBand(s.tws).key
      if (run && run.band === band) {
        run.t1 = s.end
        if (s.tws != null) run.tws.push(s.tws)
      } else {
        close()
        run = { band, t0: s.t, t1: s.end, tws: s.tws != null ? [s.tws] : [] }
      }
    }
    close()

    const kind: SailMediaKind = isVideo360(v) ? 'video360' : 'video'
    for (const r of Array.from(best.values())) {
      const tws = r.tws.length ? r.tws.reduce((a, b) => a + b, 0) / r.tws.length : null
      out.push({
        kind, id: v.id, t: r.t0, date, event: eventOf(date), tws, thumb: v.thumb ?? null,
        startSec: Math.max(0, Math.round((r.t0 - logStart) / 1000)),
        durSec: Math.round((r.t1 - r.t0) / 1000), title: v.title ?? null,
      })
    }
  }

  const hidden = new Set(input.hidden || [])
  if (hidden.size) for (const i of out) if (i.kind !== 'scan' && hidden.has(i.id)) i.hidden = true
  return out.sort((a, b) => b.t - a.t)
}

/** The ids a sail's specs mark not relevant. Forgiving: specs is free-form JSON. */
export function hiddenMediaOf(specs: unknown): string[] {
  const list = (specs as { media_hidden?: unknown } | null)?.media_hidden
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && !!x) : []
}

/** The list with `id` marked (hide) or unmarked. Returns null when nothing changes. */
export function toggleHidden(list: readonly string[], id: string, hide: boolean): string[] | null {
  const has = list.includes(id)
  if (hide === has || !id) return null
  return hide ? [...list, id] : list.filter((x) => x !== id)
}

/**
 * How much there is of each sail: photos (SailTrim frames included), SailScans
 * and video clips (360 included). A clip counts once however many wind bands it
 * spans — the grid shows it once per band, but it is one clip.
 */
export interface SailMediaCount { photos: number; scans: number; videos: number }

export function countSailMedia(items: readonly SailMediaItem[]): SailMediaCount {
  const photos = new Set<string>(), scans = new Set<string>(), videos = new Set<string>()
  for (const i of items) {
    if (i.hidden) continue
    if (i.kind === 'scan') scans.add(i.id)
    else if (i.kind === 'photo' || i.kind === 'trim') photos.add(i.id)
    else videos.add(i.id)
  }
  return { photos: photos.size, scans: scans.size, videos: videos.size }
}

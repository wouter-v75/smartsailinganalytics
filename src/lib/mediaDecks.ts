// src/lib/mediaDecks.ts
// ─────────────────────────────────────────────────────────────────────────────
// The four media decks, and what colour each one is.
//
// The timeline draws them as columns and the tagger's track draws them on the
// water, and they have to be the SAME colour in both or the colour stops being
// information. It was a set of literals inside DayTimeline; now it is one place
// neither screen can drift from.
//
// Videos and drone clips cover a STRETCH of the day — they have a duration, and
// on a track that is a section of water the boat was filmed over. Photos and
// sail scans are instants. That distinction is not cosmetic: "was this
// manoeuvre filmed" is a question about a window, and drawing a clip as a dot
// answers it wrongly.
//
// Pure — no React, no DOM, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

export type MediaKind = 'video' | 'drone' | 'photo' | 'sailscan'

export const MEDIA_COLOURS: Record<MediaKind, string> = {
  video: '#06B6D4',
  drone: '#22C55E',
  photo: '#F59E0B',
  sailscan: '#8B5CF6',
}

export const MEDIA_LABELS: Record<MediaKind, string> = {
  video: 'Video',
  drone: 'Drone',
  photo: 'Photo',
  sailscan: 'Sail scan',
}

/** A clip covers a window; a photo and a scan are instants. */
export const isSpan = (kind: MediaKind): boolean => kind === 'video' || kind === 'drone'

/** One piece of media, placed in time. t1 === t0 for an instant. */
export interface MediaMark {
  id: string
  kind: MediaKind
  t0: number
  t1: number
  title?: string | null
}

/**
 * Drone footage gets its own deck: it is shot from somewhere else entirely, and
 * reading it in the same column as the onboard cameras made a busy day
 * unreadable. There is no vendor field on the video row — the capture metadata
 * that would carry it is stripped by any re-encode — so this reads the NAME,
 * which survives. It matches the raw card naming (DJI_20260903115026_0036_D)
 * and the source tag the clip pipeline appends (…_day2_DJI-001), plus an
 * explicit "drone" tag for anything labelled by hand.
 */
export function isDroneClip(m: { title?: string | null; tags?: string[] }): boolean {
  if ((m.tags || []).some((t) => String(t).toLowerCase() === 'drone')) return true
  // NOT \b: underscore is a word character, so \bDJI\b matches neither
  // "DJI_20260903115026_0036_D" nor "…_day2_DJI-001" — i.e. neither of the two
  // shapes drone clips actually arrive in. Separators are anything non-alphanumeric.
  return /(?:^|[^a-z0-9])(dji|drone|mavic|osmo)(?:[^a-z0-9]|$)/i.test(String(m.title || ''))
}

/** How long a clip runs, in ms. 0 when nothing says. */
function clipLengthMs(v: { duration_ms?: unknown; duration?: unknown }): number {
  const ms = Number(v.duration_ms)
  if (Number.isFinite(ms) && ms > 0) return ms
  const secs = Number(v.duration)
  if (Number.isFinite(secs) && secs > 0) return secs * 1000
  return 0
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Date.parse(String(v ?? ''))
  return Number.isFinite(n) ? n : null
}

/**
 * The day's media as marks on a track, from the three API shapes.
 *
 * Forgiving: a clip whose duration has not loaded yet is still worth showing as
 * the instant it starts, and a row with no usable time is dropped rather than
 * drawn at the epoch — which on a track means the first point of the day.
 */
export function mediaMarks(input: {
  videos?: {
    id: string
    start_utc?: unknown; startUtc?: unknown
    /** The API's field, in MILLISECONDS. */
    duration_ms?: unknown
    /** The analytics client's shape, in SECONDS. */
    duration?: unknown
    title?: string | null; tags?: string[]
  }[]
  photos?: { id: string; taken_utc?: unknown; t?: unknown }[]
  scans?: { id: string; captured_at?: unknown; conditions?: { sail_name_in_report?: string | null; sail_code?: string | null } | null }[]
}): MediaMark[] {
  const out: MediaMark[] = []

  for (const v of input.videos || []) {
    const t0 = num(v.start_utc ?? v.startUtc)
    if (t0 == null) continue
    // TWO FIELD NAMES, and getting this wrong is invisible: the videos API
    // returns `duration_ms`, while the analytics client carries `duration` in
    // SECONDS. Reading only the latter gave every real clip a length of zero,
    // so the track drew it as a dot — the one thing a clip is not.
    const t1 = t0 + clipLengthMs(v)
    out.push({
      id: `v:${v.id}`,
      kind: isDroneClip(v) ? 'drone' : 'video',
      t0, t1, title: v.title ?? null,
    })
  }

  for (const p of input.photos || []) {
    const t = num(p.taken_utc ?? p.t)
    if (t == null) continue
    out.push({ id: `p:${p.id}`, kind: 'photo', t0: t, t1: t, title: null })
  }

  for (const s of input.scans || []) {
    const t = num(s.captured_at)
    if (t == null) continue
    const c = s.conditions || {}
    out.push({
      id: `s:${s.id}`, kind: 'sailscan', t0: t, t1: t,
      title: c.sail_name_in_report || c.sail_code || null,
    })
  }

  return out.sort((a, b) => a.t0 - b.t0)
}

'use client'
import * as React from 'react'
import { Play, Camera } from 'lucide-react'
import { Badge, Dialog, DialogContent, Skeleton } from '@/components/ui'
import type { TimelineNode } from '@/lib/timeline/types'
import { PhotoOverlayImage, FallbackVideoPlayer } from './DayMedia'

// The day's own VERTICAL time-axis. A scrollable time bar (with a hover cursor +
// time box) carrying the day's nodes and the event-file tags (starts, mark
// roundings, tacks/gybes, sail changes) coloured like the Videos tab. Media
// (videos + photos) are stacked on the right in time order, each connected to
// its timestamp on the axis by a line. Video vs photo boxes are coloured
// differently. Clicking a clip calls onPlayVideo; a photo opens with its
// instrument overlay.

// Event colours mirror the app (map legend + Videos-tab tag colours).
const EVENT_STYLE: Record<string, { c: string; label: string; notable: boolean }> = {
  race: { c: '#D85A30', label: 'Race', notable: true },
  start: { c: '#EF4444', label: 'Start', notable: true },
  finish: { c: '#94A3B8', label: 'Finish', notable: true },
  mark: { c: '#F59E0B', label: 'Mark', notable: true },
  sail_change: { c: '#F59E0B', label: 'Sail', notable: true },
  weather: { c: '#06B6D4', label: 'Weather', notable: true },
  meeting: { c: '#7F77DD', label: 'Meeting', notable: true },
  debrief: { c: '#7F77DD', label: 'Debrief', notable: true },
  tack: { c: '#1D9E75', label: 'Tack', notable: false },
  gybe: { c: '#7F77DD', label: 'Gybe', notable: false },
}
const VIDEO_C = '#06B6D4' // cyan — video boxes + connectors
const PHOTO_C = '#F59E0B' // amber — photo boxes + connectors
const hms = (ms: number, tz: number) => new Date(ms + tz * 60000).toISOString().slice(11, 16)
const r = (v?: number | null, d = 0) => (v == null ? null : v.toFixed(d))

interface MediaItem {
  id: string; type: 'video' | 'photo'; thumb: string | null; t: number
  title?: string | null; tags: string[]; tws?: number | null; twd?: number | null; inst?: Record<string, any>
}

// Layout constants.
const PAD = 18
const AXIS_X = 12          // x of the vertical time line
const MEDIA_X = 232        // x where media boxes start
const VIDEO_H = 104, PHOTO_H = 78, GAP = 10
const VIDEO_W = 168, PHOTO_W = 132
const CONTENT_W = MEDIA_X + VIDEO_W + 16

export default function DayTimeline({ day, events, tz, teamId, boatId, onPlayVideo }: {
  day: TimelineNode; events: TimelineNode[]; tz: number
  teamId?: string | null; boatId?: string | null
  onPlayVideo?: (videoId: string) => void
}) {
  const date = (day.meta?.date as string) || day.id.split(':')[1] || ''
  const [media, setMedia] = React.useState<MediaItem[] | null>(null)
  const [openPhoto, setOpenPhoto] = React.useState<MediaItem | null>(null)
  const [openVideo, setOpenVideo] = React.useState<MediaItem | null>(null)
  const [cursor, setCursor] = React.useState<{ y: number; t: number } | null>(null)

  React.useEffect(() => {
    if (!teamId || !boatId || !date) { setMedia([]); return }
    let alive = true
    setMedia(null)
    Promise.all([
      fetch(`/api/teams/${teamId}/boats/${boatId}/videos?date=${date}`).then((res) => res.json()).catch(() => ({})),
      fetch(`/api/teams/${teamId}/boats/${boatId}/photos?date=${date}`).then((res) => res.json()).catch(() => ({})),
    ]).then(([vj, pj]) => {
      if (!alive) return
      const vids: MediaItem[] = (vj?.videos || []).map((v: any) => ({
        id: v.id, type: 'video', thumb: v.thumbnail || v.thumbnail_url,
        t: Date.parse(v.start_utc) || day.t0, title: v.title, tags: v.tags || [],
      }))
      const phs: MediaItem[] = (pj?.photos || []).map((p: any) => {
        const a = p.analysis_data || {}, inst = a.inst || {}
        const sails = a.sails ?? inst.sails ?? []
        return {
          id: p.id, type: 'photo', thumb: p.thumbnail_url, t: Date.parse(p.taken_utc) || day.t0,
          tags: [], tws: inst.tws ?? null, twd: inst.twd ?? null, inst: { ...inst, sails },
        }
      })
      setMedia([...vids, ...phs].sort((a, b) => a.t - b.t))
    })
    return () => { alive = false }
  }, [teamId, boatId, date, day.t0])

  const markers = React.useMemo(() => events.filter((e) => e.kind !== 'day' && EVENT_STYLE[e.kind]), [events])

  // Time range = day window widened to cover every event + media timestamp.
  const [lo, hi] = React.useMemo(() => {
    let a = day.t0, b = day.t1 > day.t0 ? day.t1 : day.t0 + 3600000
    for (const e of markers) { a = Math.min(a, e.t0); b = Math.max(b, e.t1 || e.t0) }
    for (const m of (media || [])) { a = Math.min(a, m.t); b = Math.max(b, m.t) }
    if (b <= a) b = a + 3600000
    return [a, b]
  }, [day.t0, day.t1, markers, media])

  // Media stack geometry → each item's vertical centre.
  const stack = React.useMemo(() => {
    let y = PAD
    const rows = (media || []).map((m) => {
      const h = m.type === 'video' ? VIDEO_H : PHOTO_H
      const top = y, center = y + h / 2
      y += h + GAP
      return { m, top, center, h }
    })
    return { rows, bottom: y }
  }, [media])

  const hoursSpan = (hi - lo) / 3600000
  const H = Math.max(stack.bottom + PAD, Math.min(1600, Math.max(420, hoursSpan * 82)))
  const yOf = React.useCallback((t: number) => PAD + ((t - lo) / (hi - lo)) * (H - 2 * PAD), [lo, hi, H])
  const tOf = (y: number) => lo + ((y - PAD) / (H - 2 * PAD)) * (hi - lo)

  // Hour ticks.
  const ticks = React.useMemo(() => {
    const out: number[] = []
    const first = Math.ceil(lo / 3600000) * 3600000
    for (let t = first; t <= hi; t += 3600000) out.push(t)
    return out
  }, [lo, hi])

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const y = Math.max(PAD, Math.min(H - PAD, e.clientY - rect.top))
    setCursor({ y, t: tOf(y) })
  }

  if (media === null) {
    return <div className="grid gap-2 py-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}</div>
  }

  return (
    <div className="relative overflow-x-auto py-1">
      <div
        className="relative"
        style={{ width: CONTENT_W, height: H }}
        onMouseMove={onMove}
        onMouseLeave={() => setCursor(null)}
      >
        {/* SVG layer: axis line, ticks, connectors, cursor. */}
        <svg className="pointer-events-none absolute inset-0" width={CONTENT_W} height={H} aria-hidden>
          <line x1={AXIS_X} y1={PAD} x2={AXIS_X} y2={H - PAD} stroke="var(--border-strong)" strokeWidth={2} />
          {ticks.map((t) => (
            <g key={t}>
              <line x1={AXIS_X - 4} y1={yOf(t)} x2={AXIS_X + 4} y2={yOf(t)} stroke="var(--text-muted)" strokeWidth={1} />
            </g>
          ))}
          {/* connector: axis timestamp → media box */}
          {stack.rows.map(({ m, center }) => {
            const y1 = yOf(m.t), col = m.type === 'video' ? VIDEO_C : PHOTO_C
            const midX = (AXIS_X + MEDIA_X) / 2
            return (
              <path key={m.id} d={`M ${AXIS_X} ${y1} C ${midX} ${y1}, ${midX} ${center}, ${MEDIA_X} ${center}`}
                fill="none" stroke={col} strokeWidth={1.5} strokeOpacity={0.6} />
            )
          })}
          {/* event dots on the axis */}
          {markers.map((e) => {
            const st = EVENT_STYLE[e.kind]
            return <circle key={e.id} cx={AXIS_X} cy={yOf(e.t0)} r={st.notable ? 4 : 3} fill={st.c} stroke="var(--bg)" strokeWidth={1} />
          })}
          {cursor && <line x1={0} y1={cursor.y} x2={CONTENT_W} y2={cursor.y} stroke="var(--accent)" strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.7} />}
        </svg>

        {/* Hour labels. */}
        {ticks.map((t) => (
          <div key={t} className="absolute font-mono text-[10px] text-muted" style={{ left: AXIS_X + 8, top: yOf(t) - 7 }}>{hms(t, tz)}</div>
        ))}

        {/* Event labels (notable kinds only; tacks/gybes stay as dots). */}
        {markers.filter((e) => EVENT_STYLE[e.kind].notable).map((e, i) => {
          const st = EVENT_STYLE[e.kind]
          return (
            <div key={e.id} className="absolute flex items-center gap-1 whitespace-nowrap" style={{ left: AXIS_X + 44, top: yOf(e.t0) - 8 }}>
              <span className="rounded px-1 py-px text-[9px] font-medium" style={{ background: st.c + '22', border: `1px solid ${st.c}55`, color: st.c }}>
                {e.title || st.label}
              </span>
            </div>
          )
        })}

        {/* Cursor time box. */}
        {cursor && (
          <div className="pointer-events-none absolute z-10 rounded bg-[color:var(--accent)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[color:var(--accent-fg)]"
            style={{ left: 0, top: cursor.y - 9 }}>
            {hms(cursor.t, tz)}
          </div>
        )}

        {/* Media boxes, stacked in time order, coloured per type. */}
        {stack.rows.map(({ m, top, h }) => {
          const col = m.type === 'video' ? VIDEO_C : PHOTO_C
          const w = m.type === 'video' ? VIDEO_W : PHOTO_W
          return (
            <button
              key={m.id}
              onClick={() => (m.type === 'video' ? (onPlayVideo ? onPlayVideo(m.id) : setOpenVideo(m)) : setOpenPhoto(m))}
              title={m.type === 'video' ? (m.title || 'Play video') : hms(m.t, tz)}
              className="group/med absolute overflow-hidden rounded-lg text-left shadow-sm transition-transform duration-150 hover:z-20 hover:scale-[1.05] hover:shadow-lg motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline-none focus-visible:ring-2"
              style={{ left: MEDIA_X, top, width: w, height: h - 2, border: `2px solid ${col}`, background: 'var(--surface-2)' }}
            >
              <div className="relative h-full w-full">
                {m.thumb ? <img src={m.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
                  : <div className="flex h-full w-full items-center justify-center text-muted">{m.type === 'video' ? <Play size={18} aria-hidden /> : <Camera size={16} aria-hidden />}</div>}
                <span className="absolute left-1 top-1 rounded px-1 py-px font-mono text-[9px] font-semibold text-white" style={{ background: col }}>
                  {m.type === 'video' ? 'VIDEO' : 'PHOTO'} · {hms(m.t, tz)}
                </span>
                {m.type === 'video' && (
                  <span className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white transition-transform duration-150 group-hover/med:scale-110"><Play size={15} aria-hidden /></span>
                )}
                {m.type === 'video' && m.tags.length > 0 && (
                  <div className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[9px] text-white/90">{m.tags.slice(0, 3).join(' · ')}</div>
                )}
                {m.type === 'photo' && (m.tws != null || m.twd != null) && (
                  <div className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 font-mono text-[9px] text-white/90">
                    {m.tws != null ? `${r(m.tws)}kt` : ''}{m.twd != null ? ` ${r(m.twd)}°` : ''}
                  </div>
                )}
              </div>
            </button>
          )
        })}

        {markers.length === 0 && (media || []).length === 0 && (
          <div className="absolute text-xs text-muted" style={{ left: MEDIA_X, top: PAD }}>No markers, photos or videos for this day.</div>
        )}
      </div>

      <Dialog open={!!openPhoto} onOpenChange={(o) => { if (!o) setOpenPhoto(null) }}>
        {openPhoto && (
          <DialogContent title="Photo">
            <PhotoOverlayImage src={openPhoto.thumb} inst={openPhoto.inst || {}} />
            {openPhoto.tags.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{openPhoto.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>}
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={!!openVideo} onOpenChange={(o) => { if (!o) setOpenVideo(null) }}>
        {openVideo && (
          <DialogContent title={openVideo.title || 'Video'}>
            <FallbackVideoPlayer videoId={openVideo.id} />
            {openVideo.tags.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{openVideo.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>}
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}

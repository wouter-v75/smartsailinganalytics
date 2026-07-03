'use client'
import * as React from 'react'
import { Play, Camera, ZoomIn, ZoomOut } from 'lucide-react'
import { Badge, Dialog, DialogContent, Skeleton } from '@/components/ui'
import type { TimelineNode } from '@/lib/timeline/types'
import { PhotoOverlayImage, FallbackVideoPlayer } from './DayMedia'

// The day's own VERTICAL time-axis. A zoomable time bar (hover cursor + time box)
// carrying the day's nodes and event-file tags (starts, mark roundings, tacks,
// gybes, sail changes) coloured like the Videos tab. Media are anchored to their
// timestamp: two decks — one for videos, one for photos. When zoomed out and
// timestamps cluster, cards STACK like a hand of playing cards; zooming in
// spreads them apart until they sit fully beneath one another.

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
const VIDEO_C = '#06B6D4', PHOTO_C = '#F59E0B'
const hms = (ms: number, tz: number) => new Date(ms + tz * 60000).toISOString().slice(11, 16)
const r = (v?: number | null, d = 0) => (v == null ? null : v.toFixed(d))

interface MediaItem {
  id: string; type: 'video' | 'photo'; thumb: string | null; t: number
  title?: string | null; tags: string[]; tws?: number | null; twd?: number | null; inst?: Record<string, any>
}

// Geometry.
const PAD = 30, AXIS_X = 12, EVENT_LABEL_X = 42
const VIDEO_X = 196, VIDEO_W = 152, VIDEO_H = 90
const PHOTO_X = 372, PHOTO_W = 120, PHOTO_H = 90
const CONTENT_W = PHOTO_X + PHOTO_W + 16
const CARD_OFFSET = 26        // stacked-card reveal when timestamps cluster
const MIN_PPH = 40, MAX_PPH = 480, DEFAULT_PPH = 90

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
  const [pph, setPph] = React.useState(DEFAULT_PPH) // pixels per hour (zoom)

  React.useEffect(() => {
    if (!teamId || !boatId || !date) { setMedia([]); return }
    let alive = true
    setMedia(null)
    Promise.all([
      fetch(`/api/teams/${teamId}/boats/${boatId}/videos?date=${date}`).then((res) => res.json()).catch(() => ({})),
      fetch(`/api/teams/${teamId}/boats/${boatId}/photos?date=${date}`).then((res) => res.json()).catch(() => ({})),
    ]).then(([vj, pj]: [any, any]) => {
      if (!alive) return
      const vids: MediaItem[] = (vj?.videos || []).map((v: any) => ({
        id: v.id, type: 'video', thumb: v.thumbnail || v.thumbnail_url,
        t: Date.parse(v.start_utc) || day.t0, title: v.title, tags: v.tags || [],
      }))
      const phs: MediaItem[] = (pj?.photos || []).map((p: any) => {
        const a = p.analysis_data || {}, inst = a.inst || {}
        const sails = a.sails ?? inst.sails ?? []
        return { id: p.id, type: 'photo', thumb: p.thumbnail_url, t: Date.parse(p.taken_utc) || day.t0, tags: [], tws: inst.tws ?? null, twd: inst.twd ?? null, inst: { ...inst, sails } }
      })
      setMedia([...vids, ...phs].sort((a, b) => a.t - b.t))
    })
    return () => { alive = false }
  }, [teamId, boatId, date, day.t0])

  const markers = React.useMemo(() => events.filter((e) => e.kind !== 'day' && EVENT_STYLE[e.kind]), [events])
  const videos = React.useMemo(() => (media || []).filter((m) => m.type === 'video'), [media])
  const photos = React.useMemo(() => (media || []).filter((m) => m.type === 'photo'), [media])

  const [lo, hi] = React.useMemo(() => {
    let a = day.t0, b = day.t1 > day.t0 ? day.t1 : day.t0 + 3600000
    for (const e of markers) { a = Math.min(a, e.t0); b = Math.max(b, e.t1 || e.t0) }
    for (const m of (media || [])) { a = Math.min(a, m.t); b = Math.max(b, m.t) }
    if (b <= a) b = a + 3600000
    return [a, b]
  }, [day.t0, day.t1, markers, media])

  const hoursSpan = (hi - lo) / 3600000
  const axisH = Math.max(300, Math.min(6000, hoursSpan * pph))
  const yOf = React.useCallback((t: number) => PAD + ((t - lo) / (hi - lo)) * (axisH - 2 * PAD), [lo, hi, axisH])
  const tOf = (y: number) => lo + ((y - PAD) / (axisH - 2 * PAD)) * (hi - lo)

  // Place a column's items at their timestamp, but never closer than CARD_OFFSET
  // to the previous one → clusters become a stacked deck; zoom spreads them.
  const placeCol = React.useCallback((items: MediaItem[], h: number) => {
    let prev = -Infinity
    return items.map((m) => {
      const yt = yOf(m.t)
      const y = Math.max(yt, prev + CARD_OFFSET)
      prev = y
      return { m, y, yt }
    })
  }, [yOf])
  const vPlaced = React.useMemo(() => placeCol(videos, VIDEO_H), [videos, placeCol])
  const pPlaced = React.useMemo(() => placeCol(photos, PHOTO_H), [photos, placeCol])

  const contentH = React.useMemo(() => {
    let bottom = axisH
    vPlaced.forEach((p) => { bottom = Math.max(bottom, p.y + VIDEO_H) })
    pPlaced.forEach((p) => { bottom = Math.max(bottom, p.y + PHOTO_H) })
    return bottom + PAD
  }, [axisH, vPlaced, pPlaced])

  const ticks = React.useMemo(() => {
    const out: number[] = []
    const first = Math.ceil(lo / 3600000) * 3600000
    for (let t = first; t <= hi; t += 3600000) out.push(t)
    return out
  }, [lo, hi])

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const y = Math.max(PAD, Math.min(axisH - PAD, e.clientY - rect.top))
    setCursor({ y, t: tOf(y) })
  }
  const zoom = (f: number) => setPph((p) => Math.max(MIN_PPH, Math.min(MAX_PPH, Math.round(p * f))))
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15) } }

  const clickMedia = (m: MediaItem) => m.type === 'video' ? (onPlayVideo ? onPlayVideo(m.id) : setOpenVideo(m)) : setOpenPhoto(m)

  if (media === null) {
    return <div className="grid gap-2 py-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}</div>
  }

  return (
    <div className="py-1">
      {/* Zoom toolbar */}
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] text-muted">Zoom</span>
        <button onClick={() => zoom(1 / 1.5)} className="rounded border border-[color:var(--border)] bg-surface-1 p-1 hover:bg-surface-2" aria-label="Zoom out"><ZoomOut size={14} /></button>
        <button onClick={() => zoom(1.5)} className="rounded border border-[color:var(--border)] bg-surface-1 p-1 hover:bg-surface-2" aria-label="Zoom in"><ZoomIn size={14} /></button>
        <span className="text-[10px] text-faint">⌘/Ctrl + scroll to zoom</span>
      </div>

      <div className="overflow-x-auto">
        <div className="relative" style={{ width: CONTENT_W, height: contentH }} onMouseMove={onMove} onMouseLeave={() => setCursor(null)} onWheel={onWheel}>
          {/* SVG: axis, ticks, connectors, event dots, cursor */}
          <svg className="pointer-events-none absolute inset-0" width={CONTENT_W} height={contentH} aria-hidden>
            <line x1={AXIS_X} y1={PAD} x2={AXIS_X} y2={axisH - PAD} stroke="var(--border-strong)" strokeWidth={2} />
            {ticks.map((t) => <line key={t} x1={AXIS_X - 4} y1={yOf(t)} x2={AXIS_X + 4} y2={yOf(t)} stroke="var(--text-muted)" strokeWidth={1} />)}
            {vPlaced.map(({ m, y, yt }) => { const mid = (AXIS_X + VIDEO_X) / 2; return <path key={m.id} d={`M ${AXIS_X} ${yt} C ${mid} ${yt}, ${mid} ${y + 12}, ${VIDEO_X} ${y + 12}`} fill="none" stroke={VIDEO_C} strokeWidth={1.5} strokeOpacity={0.55} /> })}
            {pPlaced.map(({ m, y, yt }) => { const mid = (VIDEO_X + PHOTO_X) / 2; return <path key={m.id} d={`M ${AXIS_X} ${yt} C ${mid} ${yt}, ${mid} ${y + 12}, ${PHOTO_X} ${y + 12}`} fill="none" stroke={PHOTO_C} strokeWidth={1.5} strokeOpacity={0.55} /> })}
            {markers.map((e) => { const st = EVENT_STYLE[e.kind]; return <circle key={e.id} cx={AXIS_X} cy={yOf(e.t0)} r={st.notable ? 4 : 3} fill={st.c} stroke="var(--bg)" strokeWidth={1} /> })}
            {cursor && <line x1={0} y1={cursor.y} x2={CONTENT_W} y2={cursor.y} stroke="var(--accent)" strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.7} />}
          </svg>

          {/* Column headers */}
          <div className="absolute text-[10px] font-medium uppercase tracking-wide" style={{ left: VIDEO_X, top: 6, color: VIDEO_C }}>Videos</div>
          <div className="absolute text-[10px] font-medium uppercase tracking-wide" style={{ left: PHOTO_X, top: 6, color: PHOTO_C }}>Photos</div>

          {/* Hour labels */}
          {ticks.map((t) => <div key={t} className="absolute font-mono text-[10px] text-muted" style={{ left: AXIS_X + 8, top: yOf(t) - 7 }}>{hms(t, tz)}</div>)}

          {/* Event labels (notable only) */}
          {markers.filter((e) => EVENT_STYLE[e.kind].notable).map((e) => {
            const st = EVENT_STYLE[e.kind]
            return (
              <div key={e.id} className="absolute whitespace-nowrap" style={{ left: EVENT_LABEL_X, top: yOf(e.t0) - 8 }}>
                <span className="rounded px-1 py-px text-[9px] font-medium" style={{ background: st.c + '22', border: `1px solid ${st.c}55`, color: st.c }}>{e.title || st.label}</span>
              </div>
            )
          })}

          {/* Cursor time box */}
          {cursor && (
            <div className="pointer-events-none absolute z-[60] rounded bg-[color:var(--accent)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[color:var(--accent-fg)]" style={{ left: 0, top: cursor.y - 9 }}>{hms(cursor.t, tz)}</div>
          )}

          {/* Video deck */}
          {vPlaced.map(({ m, y }) => <MediaCard key={m.id} m={m} x={VIDEO_X} y={y} w={VIDEO_W} h={VIDEO_H} color={VIDEO_C} tz={tz} onClick={() => clickMedia(m)} />)}
          {/* Photo deck */}
          {pPlaced.map(({ m, y }) => <MediaCard key={m.id} m={m} x={PHOTO_X} y={y} w={PHOTO_W} h={PHOTO_H} color={PHOTO_C} tz={tz} onClick={() => clickMedia(m)} />)}

          {markers.length === 0 && (media || []).length === 0 && (
            <div className="absolute text-xs text-muted" style={{ left: VIDEO_X, top: PAD }}>No markers, photos or videos for this day.</div>
          )}
        </div>
      </div>

      <Dialog open={!!openPhoto} onOpenChange={(o) => { if (!o) setOpenPhoto(null) }}>
        {openPhoto && <DialogContent title="Photo"><PhotoOverlayImage src={openPhoto.thumb} inst={openPhoto.inst || {}} /></DialogContent>}
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

// A single deck card. DOM order gives the stacked "playing cards" look (later
// cards paint on top); hover lifts it above the deck and enlarges it.
function MediaCard({ m, x, y, w, h, color, tz, onClick }: {
  m: MediaItem; x: number; y: number; w: number; h: number; color: string; tz: number; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={m.type === 'video' ? (m.title || 'Play video') : hms(m.t, tz)}
      className="group/med absolute overflow-hidden rounded-lg text-left shadow-md transition-transform duration-150 hover:z-[80] hover:scale-[1.12] hover:shadow-xl motion-reduce:transition-none motion-reduce:hover:scale-100 focus-visible:outline-none focus-visible:ring-2"
      style={{ left: x, top: y, width: w, height: h, border: `2px solid ${color}`, background: 'var(--surface-2)' }}
    >
      <div className="relative h-full w-full">
        {m.thumb ? <img src={m.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
          : <div className="flex h-full w-full items-center justify-center text-muted">{m.type === 'video' ? <Play size={18} aria-hidden /> : <Camera size={16} aria-hidden />}</div>}
        <span className="absolute left-1 top-1 rounded px-1 py-px font-mono text-[9px] font-semibold text-white" style={{ background: color }}>{hms(m.t, tz)}</span>
        {m.type === 'video' && <span className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white transition-transform duration-150 group-hover/med:scale-110"><Play size={15} aria-hidden /></span>}
        {m.type === 'video' && m.tags.length > 0 && <div className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[9px] text-white/90">{m.tags.slice(0, 3).join(' · ')}</div>}
        {m.type === 'photo' && (m.tws != null || m.twd != null) && <div className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 font-mono text-[9px] text-white/90">{m.tws != null ? `${r(m.tws)}kt` : ''}{m.twd != null ? ` ${r(m.twd)}°` : ''}</div>}
      </div>
    </button>
  )
}

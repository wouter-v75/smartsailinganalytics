'use client'
import * as React from 'react'
import { Play, Camera, ZoomIn, ZoomOut, Sailboat } from 'lucide-react'
import { Badge, Dialog, DialogContent, Skeleton } from '@/components/ui'
import type { TimelineNode } from '@/lib/timeline/types'
import { PhotoOverlayImage, FallbackVideoPlayer } from './DayMedia'
import SailScanDetail from '@/components/SailScanDetail'

// The day's own VERTICAL time-axis. A zoomable, pinch/scrollable time bar (hover
// cursor + time box) with the day's nodes and event-file tags coloured like the
// Videos tab. Media are anchored to their timestamp and stacked BETWEEN events —
// videos in one deck, photos in another, with clear space between the per-segment
// stacks. Cards stack like playing cards when clustered; zooming/pinching spreads
// them apart. Hovering a card doubles it and shows its sail/event/TWS/TWA.
// Geometry is responsive: on phones both decks fit the screen (no half-off cards).

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
const VIDEO_C = '#06B6D4', PHOTO_C = '#F59E0B', SCAN_C = '#8B5CF6'
// Leg-mode colours for the time bar (derived from manoeuvres: tacks → upwind,
// gybes → downwind, balanced/none → reach).
const LEG_C: Record<string, string> = { upwind: '#EF4444', reach: '#F59E0B', downwind: '#22C55E' }
const LEG_ORDER = ['upwind', 'reach', 'downwind'] as const
const hms = (ms: number, tz: number) => new Date(ms + tz * 60000).toISOString().slice(11, 16)
const r = (v?: number | null, d = 0) => (v == null ? null : v.toFixed(d))

function chipStyle(t: string): { bg: string; c: string; bd: string } {
  if (/^(race-start|topmark|mark|start|finish)$/.test(t)) return { bg: '#EF444422', c: '#EF4444', bd: '#EF444455' }
  if (/^(upwind|reach|downwind)$/.test(t)) return { bg: '#06B6D422', c: '#06B6D4', bd: '#06B6D455' }
  if (/^(tack|gybe)$/.test(t)) return { bg: '#1D9E7522', c: '#1D9E75', bd: '#1D9E7555' }
  return { bg: '#8B5CF622', c: '#A78BFA', bd: '#8B5CF655' }
}

interface MediaItem {
  id: string; type: 'video' | 'photo' | 'sailscan'; thumb: string | null; t: number
  title?: string | null; tags: string[]; tws?: number | null; twa?: number | null; twaTarg?: number | null; twd?: number | null; sails: string[]; inst?: Record<string, any>
  original?: string | null; sailName?: string | null; raw?: any
}

// Leg mode from TWA vs target TWA (per Wouter's rule):
//   • upwind   = TWA < 90 AND within 20° of target TWA
//   • downwind = TWA > 90 AND within 20° of target TWA
//   • reach    = anything else (off-target, or a reaching angle)
// If target TWA is unknown we can't check the 20° band, so we fall back to the
// simple TWA<90 / TWA>90 split.
function classifyTwa(twa: number, twaTarg: number | null | undefined): 'upwind' | 'downwind' | 'reach' {
  const near = twaTarg == null ? true : Math.abs(twa - twaTarg) < 20
  if (twa < 90) return near ? 'upwind' : 'reach'
  if (twa > 90) return near ? 'downwind' : 'reach'
  return 'reach'
}
interface Placed { m: MediaItem; y: number; yt: number }

const PAD = 30
const CARD_OFFSET = 26        // stacked-card reveal within a segment
const SEGMENT_GAP = 46        // extra space between stacks in different segments
const MIN_PPH = 40, MAX_PPH = 720, DEFAULT_PPH = 90

function useCompact() {
  const [c, setC] = React.useState(false)
  React.useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const on = () => setC(mq.matches); on(); mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return c
}
function useNoHover() {
  const [v, setV] = React.useState(false)
  React.useEffect(() => {
    const mq = window.matchMedia('(hover: none)')
    const on = () => setV(mq.matches); on(); mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return v
}
// Responsive layout. On phones: tighter offsets + widths, event dots only (no
// text labels), so BOTH decks fit within the viewport.
function geometry(compact: boolean) {
  return compact
    ? { AXIS_X: 8, EVENT_LABEL_X: 16, showEventLabels: false, VIDEO_X: 46, VIDEO_W: 74, VIDEO_H: 64, PHOTO_X: 126, PHOTO_W: 72, PHOTO_H: 64, SCAN_X: 204, SCAN_W: 72, SCAN_H: 64, CONTENT_W: 204 + 72 + 6 }
    : { AXIS_X: 12, EVENT_LABEL_X: 42, showEventLabels: true, VIDEO_X: 196, VIDEO_W: 150, VIDEO_H: 88, PHOTO_X: 372, PHOTO_W: 120, PHOTO_H: 88, SCAN_X: 508, SCAN_W: 120, SCAN_H: 88, CONTENT_W: 508 + 120 + 16 }
}

export default function DayTimeline({ day, events, tz, teamId, boatId, onPlayVideo }: {
  day: TimelineNode; events: TimelineNode[]; tz: number
  teamId?: string | null; boatId?: string | null
  onPlayVideo?: (videoId: string) => void
}) {
  const date = (day.meta?.date as string) || day.id.split(':')[1] || ''
  const compact = useCompact()
  const G = geometry(compact)
  const [media, setMedia] = React.useState<MediaItem[] | null>(null)
  const [openPhoto, setOpenPhoto] = React.useState<MediaItem | null>(null)
  const [openVideo, setOpenVideo] = React.useState<MediaItem | null>(null)
  const [openScan, setOpenScan] = React.useState<MediaItem | null>(null)
  const [cursor, setCursor] = React.useState<{ y: number; t: number } | null>(null)
  const [ptr, setPtr] = React.useState<{ x: number; y: number } | null>(null)
  const noHover = useNoHover()                    // touch device → scroll-driven "rolodex" focus
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [pph, setPph] = React.useState(DEFAULT_PPH)
  // Boat sail inventory (with design shapes in specs) — passed to SailScanDetail
  // so it can draw the design-target curves.
  const [sailInventory, setSailInventory] = React.useState<any[]>([])
  React.useEffect(() => {
    if (!teamId || !boatId) return
    let alive = true
    fetch(`/api/teams/${teamId}/sails?boat_id=${boatId}`).then((r) => r.json()).then((j) => { if (alive) setSailInventory(j?.sails || []) }).catch(() => {})
    return () => { alive = false }
  }, [teamId, boatId])

  React.useEffect(() => {
    if (!teamId || !boatId || !date) { setMedia([]); return }
    let alive = true
    setMedia(null)
    const ymd = (t: number) => new Date(t + tz * 60000).toISOString().slice(0, 10)
    Promise.all([
      fetch(`/api/teams/${teamId}/boats/${boatId}/videos?date=${date}`).then((res) => res.json()).catch(() => ({})),
      fetch(`/api/teams/${teamId}/boats/${boatId}/photos?date=${date}`).then((res) => res.json()).catch(() => ({})),
      fetch(`/api/teams/${teamId}/sail-scans?boat_id=${boatId}&limit=200`).then((res) => res.json()).catch(() => ({})),
    ]).then(([vj, pj, sj]: [any, any, any]) => {
      if (!alive) return
      const vids: MediaItem[] = (vj?.videos || []).map((v: any) => ({
        id: v.id, type: 'video', thumb: v.thumbnail || v.thumbnail_url,
        t: Date.parse(v.start_utc) || day.t0, title: v.title, tags: v.tags || [], sails: [],
      }))
      const phs: MediaItem[] = (pj?.photos || []).map((p: any) => {
        const a = p.analysis_data || {}, inst = a.inst || {}
        const sails = a.sails ?? inst.sails ?? []
        return { id: p.id, type: 'photo', thumb: p.thumbnail_url, original: p.original_url || null, t: Date.parse(p.taken_utc) || day.t0, tags: [], tws: inst.tws ?? null, twa: inst.twa ?? null, twaTarg: inst.twaTarg ?? inst.twa_targ ?? null, twd: inst.twd ?? null, sails, inst: { ...inst, sails } }
      })
      // Sail scans are boat-scoped (no date filter on the API) → keep the ones
      // captured on this day.
      const scns: MediaItem[] = (sj?.scans || []).map((s: any) => {
        const t = Date.parse(s.captured_at)
        const c = s.conditions || {}
        const name = c.sail_name_in_report || c.sail_code || null
        return {
          id: s.id, type: 'sailscan' as const, thumb: s.photo_url || null,
          t: Number.isFinite(t) ? t : day.t0, tags: [], tws: s.tws_kn ?? null, twa: s.twa_deg ?? null, sails: [], sailName: name,
          raw: s, // the full row → passed straight to <SailScanDetail>
        }
      }).filter((m: MediaItem) => ymd(m.t) === date)
      setMedia([...vids, ...phs, ...scns].sort((a, b) => a.t - b.t))
    })
    return () => { alive = false }
  }, [teamId, boatId, date, day.t0, tz])

  const markers = React.useMemo(() => events.filter((e) => e.kind !== 'day' && EVENT_STYLE[e.kind]), [events])
  const eventTimes = React.useMemo(() => markers.map((e) => e.t0).sort((a, b) => a - b), [markers])
  const segmentOf = React.useCallback((t: number) => { let i = 0; while (i < eventTimes.length && eventTimes[i] <= t) i++; return i }, [eventTimes])
  const nearestEvent = React.useCallback((t: number) => {
    let best: TimelineNode | null = null, bd = Infinity
    for (const e of markers) { const d = Math.abs(e.t0 - t); if (d < bd) { bd = d; best = e } }
    return best && bd <= 12 * 60000 ? best : null
  }, [markers])

  const videos = React.useMemo(() => (media || []).filter((m) => m.type === 'video'), [media])
  const photos = React.useMemo(() => (media || []).filter((m) => m.type === 'photo'), [media])
  const scanItems = React.useMemo(() => (media || []).filter((m) => m.type === 'sailscan'), [media])

  const [lo, hi] = React.useMemo(() => {
    let a = day.t0, b = day.t1 > day.t0 ? day.t1 : day.t0 + 3600000
    for (const e of markers) { a = Math.min(a, e.t0); b = Math.max(b, e.t1 || e.t0) }
    for (const m of (media || [])) { a = Math.min(a, m.t); b = Math.max(b, m.t) }
    if (b <= a) b = a + 3600000
    return [a, b]
  }, [day.t0, day.t1, markers, media])

  const hoursSpan = (hi - lo) / 3600000
  const axisH = Math.max(300, Math.min(9000, hoursSpan * pph))
  const yOf = React.useCallback((t: number) => PAD + ((t - lo) / (hi - lo)) * (axisH - 2 * PAD), [lo, hi, axisH])
  const tOf = (y: number) => lo + ((y - PAD) / (axisH - 2 * PAD)) * (hi - lo)

  const placeCol = React.useCallback((items: MediaItem[]): Placed[] => {
    let prev = -Infinity, prevSeg = -1
    return items.map((m) => {
      const seg = segmentOf(m.t)
      const gap = seg !== prevSeg ? SEGMENT_GAP : CARD_OFFSET
      const yt = yOf(m.t)
      const y = Math.max(yt, prev + gap)
      prev = y; prevSeg = seg
      return { m, y, yt }
    })
  }, [yOf, segmentOf])
  const vPlaced = React.useMemo(() => placeCol(videos), [videos, placeCol])
  const pPlaced = React.useMemo(() => placeCol(photos), [photos, placeCol])
  const sPlaced = React.useMemo(() => placeCol(scanItems), [scanItems, placeCol])

  const contentH = React.useMemo(() => {
    let bottom = axisH
    vPlaced.forEach((p) => { bottom = Math.max(bottom, p.y + G.VIDEO_H) })
    pPlaced.forEach((p) => { bottom = Math.max(bottom, p.y + G.PHOTO_H) })
    sPlaced.forEach((p) => { bottom = Math.max(bottom, p.y + G.SCAN_H) })
    return bottom + PAD
  }, [axisH, vPlaced, pPlaced, sPlaced, G.VIDEO_H, G.PHOTO_H, G.SCAN_H])

  const ticks = React.useMemo(() => {
    const out: number[] = []
    const first = Math.ceil(lo / 3600000) * 3600000
    for (let t = first; t <= hi; t += 3600000) out.push(t)
    return out
  }, [lo, hi])

  // Per-time TWA samples (from photos: the only timeline data carrying TWA + a
  // target). Used to classify legs by the TWA rule.
  const twaSamples = React.useMemo(
    () => (media || []).filter((m) => m.type === 'photo' && m.twa != null).map((m) => ({ t: m.t, twa: m.twa as number, twaTarg: m.twaTarg ?? null })),
    [media],
  )

  // Leg bands: split the racing time at course points (start / mark / finish).
  // Classify each leg from its TWA samples via the rule (upwind = TWA<90 within
  // 20° of target, downwind = TWA>90 within 20°, else reach). Where a leg has no
  // TWA sample, fall back to manoeuvres (more tacks ⇒ upwind, more gybes ⇒
  // downwind, balanced/none ⇒ reach).
  const legs = React.useMemo(() => {
    const bounds = new Set<number>([lo, hi])
    markers.forEach((e) => { if (['start', 'mark', 'finish', 'race'].includes(e.kind)) { bounds.add(e.t0); if (e.t1 > e.t0) bounds.add(e.t1) } })
    const bs = Array.from(bounds).filter((t) => t >= lo && t <= hi).sort((a, b) => a - b)
    const out: { t0: number; t1: number; mode: string }[] = []
    for (let i = 0; i < bs.length - 1; i++) {
      const a = bs[i], b = bs[i + 1]
      if (b - a < 90000) continue // ignore sub-90s slivers
      const votes: Record<string, number> = { upwind: 0, downwind: 0, reach: 0 }
      let n = 0
      for (const s of twaSamples) { if (s.t >= a && s.t < b) { votes[classifyTwa(s.twa, s.twaTarg)]++; n++ } }
      let mode: string
      if (n > 0) {
        mode = (['upwind', 'downwind', 'reach'] as const).reduce((best, m) => (votes[m] > votes[best] ? m : best), 'reach')
      } else {
        let tk = 0, gy = 0
        for (const e of markers) { if (e.t0 >= a && e.t0 < b) { if (e.kind === 'tack') tk++; else if (e.kind === 'gybe') gy++ } }
        mode = tk > gy ? 'upwind' : gy > tk ? 'downwind' : 'reach'
      }
      out.push({ t0: a, t1: b, mode })
    }
    return out
  }, [markers, lo, hi, twaSamples])
  const hasLegManoeuvres = React.useMemo(() => twaSamples.length > 0 || markers.some((e) => e.kind === 'tack' || e.kind === 'gybe'), [twaSamples, markers])

  // Cards are displaced from their true time position by the deck stacking, so
  // over a media column the vertical position no longer maps to the right time.
  // Snap the readout to the nearest card's ACTUAL timestamp when over a column;
  // otherwise interpolate from the axis.
  const timeAt = (x: number, rawY: number): number => {
    const cols: { X: number; W: number; h: number; placed: Placed[] }[] = [
      { X: G.VIDEO_X, W: G.VIDEO_W, h: G.VIDEO_H, placed: vPlaced },
      { X: G.PHOTO_X, W: G.PHOTO_W, h: G.PHOTO_H, placed: pPlaced },
      { X: G.SCAN_X, W: G.SCAN_W, h: G.SCAN_H, placed: sPlaced },
    ]
    for (const c of cols) {
      if (x >= c.X - 8 && x <= c.X + c.W + 8 && c.placed.length) {
        let best = c.placed[0], bd = Infinity
        for (const p of c.placed) { const d = Math.abs(p.y + c.h / 2 - rawY); if (d < bd) { bd = d; best = p } }
        return best.m.t
      }
    }
    return tOf(Math.max(PAD, Math.min(axisH - PAD, rawY)))
  }

  // Live fisheye follows a MOUSE only (best practice: continuous magnification on
  // touch fights scrolling). Touch uses the scroll-driven rolodex instead.
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || pinch.current) return
    const rect = e.currentTarget.getBoundingClientRect()
    const rawY = e.clientY - rect.top, x = e.clientX - rect.left
    setPtr({ x, y: rawY })
    const y = Math.max(PAD, Math.min(axisH - PAD, rawY))
    setCursor({ y, t: timeAt(x, rawY) })
  }
  const clearHover = () => { if (noHover) return; setCursor(null); setPtr(null) }  // mouse leave (touch focus is scroll-driven)

  // Touch "rolodex": centre the magnifier on the viewport, so scrolling the deck
  // inflates whatever card is in the middle and tapers the rest. A capture-phase
  // scroll listener catches whichever element actually scrolls.
  React.useEffect(() => {
    if (!noHover) return
    let raf = 0
    const update = () => {
      raf = 0
      const el = contentRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const focusScreen = window.innerHeight * 0.44
      setPtr({ x: -1, y: Math.max(0, Math.min(rect.height, focusScreen - rect.top)) })
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update) }
    update()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onScroll); if (raf) cancelAnimationFrame(raf) }
  }, [noHover, contentH])
  // macOS-Dock magnification: the card under the cursor inflates most; neighbours
  // above/below taper off with a cosine falloff over MAG_RADIUS, and magnified
  // cards push gently apart so the lens reads cleanly. Only the column the cursor
  // is over magnifies.
  // ptr.x < 0 marks the touch "rolodex" focus (scroll-driven, all columns);
  // ptr.x >= 0 is a mouse position (per-column gate).
  const MAG_AMP = noHover ? 0.6 : (compact ? 0.4 : 0.9)
  const MAG_RADIUS = noHover ? 150 : (compact ? 95 : 155)
  const magFor = (colX: number, colW: number, cy: number) => {
    if (!ptr) return 1
    if (ptr.x >= 0 && (ptr.x < colX - 14 || ptr.x > colX + colW + 14)) return 1
    const d = Math.abs(cy - ptr.y)
    if (d >= MAG_RADIUS) return 1
    return 1 + MAG_AMP * 0.5 * (1 + Math.cos((d / MAG_RADIUS) * Math.PI))
  }
  // Event dots + labels are their own column. With a mouse they only magnify
  // when the cursor is over that band; in the rolodex they join the centre focus.
  const EV_AMP = noHover ? 0.5 : (compact ? 0.35 : 0.7)
  const magForY = (cy: number) => {
    if (!ptr) return 1
    if (ptr.x >= 0 && ptr.x >= G.VIDEO_X - 8) return 1
    const d = Math.abs(cy - ptr.y)
    if (d >= MAG_RADIUS) return 1
    return 1 + EV_AMP * 0.5 * (1 + Math.cos((d / MAG_RADIUS) * Math.PI))
  }
  const zoom = (f: number) => setPph((p) => Math.max(MIN_PPH, Math.min(MAX_PPH, Math.round(p * f))))
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12) } }

  const pinch = React.useRef<{ dist: number; pph: number } | null>(null)
  const dist = (a: React.Touch, b: React.Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
  const onTouchStart = (e: React.TouchEvent) => { if (e.touches.length === 2) pinch.current = { dist: dist(e.touches[0], e.touches[1]), pph } }
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinch.current) {
      e.preventDefault()
      const ratio = dist(e.touches[0], e.touches[1]) / (pinch.current.dist || 1)
      setPph(Math.max(MIN_PPH, Math.min(MAX_PPH, Math.round(pinch.current.pph * ratio))))
    }
  }
  const onTouchEnd = (e: React.TouchEvent) => { if (e.touches.length < 2) pinch.current = null }

  const clickMedia = (m: MediaItem) => m.type === 'video' ? (onPlayVideo ? onPlayVideo(m.id) : setOpenVideo(m)) : m.type === 'sailscan' ? setOpenScan(m) : setOpenPhoto(m)

  if (media === null) {
    return <div className="grid gap-2 py-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}</div>
  }

  return (
    <div className="py-1">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] text-muted">Zoom</span>
        <button onClick={() => zoom(1 / 1.5)} className="rounded border border-[color:var(--border)] bg-surface-1 p-1 hover:bg-surface-2" aria-label="Zoom out"><ZoomOut size={14} /></button>
        <button onClick={() => zoom(1.5)} className="rounded border border-[color:var(--border)] bg-surface-1 p-1 hover:bg-surface-2" aria-label="Zoom in"><ZoomIn size={14} /></button>
        <span className="text-[10px] text-faint">{compact ? 'pinch to stretch' : 'pinch, or ⌘/Ctrl + scroll, to stretch'}</span>
        {hasLegManoeuvres && (
          <span className="ml-auto flex items-center gap-2 text-[10px] text-muted">
            {LEG_ORDER.map((m) => <span key={m} className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: LEG_C[m] }} />{m}</span>)}
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <div
          ref={contentRef}
          className="relative"
          style={{ width: G.CONTENT_W, height: contentH, touchAction: 'pan-y' }}
          onPointerMove={onMove} onPointerLeave={clearHover} onPointerCancel={clearHover} onWheel={onWheel}
          onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        >
          <svg className="pointer-events-none absolute inset-0" width={G.CONTENT_W} height={contentH} aria-hidden>
            {/* Leg colour rail (upwind / reach / downwind). */}
            {hasLegManoeuvres && legs.map((lg, i) => <rect key={i} x={G.AXIS_X - 3} y={yOf(lg.t0)} width={6} height={Math.max(1, yOf(lg.t1) - yOf(lg.t0))} rx={2} fill={LEG_C[lg.mode]} opacity={0.5} />)}
            <line x1={G.AXIS_X} y1={PAD} x2={G.AXIS_X} y2={axisH - PAD} stroke="var(--border-strong)" strokeWidth={1} />
            {ticks.map((t) => <line key={t} x1={G.AXIS_X - 4} y1={yOf(t)} x2={G.AXIS_X + 4} y2={yOf(t)} stroke="var(--text-muted)" strokeWidth={1} />)}
            {vPlaced.map(({ m, y, yt }) => { const mid = (G.AXIS_X + G.VIDEO_X) / 2; return <path key={m.id} d={`M ${G.AXIS_X} ${yt} C ${mid} ${yt}, ${mid} ${y + 12}, ${G.VIDEO_X} ${y + 12}`} fill="none" stroke={VIDEO_C} strokeWidth={1.5} strokeOpacity={0.55} /> })}
            {pPlaced.map(({ m, y, yt }) => { const mid = (G.VIDEO_X + G.PHOTO_X) / 2; return <path key={m.id} d={`M ${G.AXIS_X} ${yt} C ${mid} ${yt}, ${mid} ${y + 12}, ${G.PHOTO_X} ${y + 12}`} fill="none" stroke={PHOTO_C} strokeWidth={1.5} strokeOpacity={0.55} /> })}
            {sPlaced.map(({ m, y, yt }) => { const mid = (G.AXIS_X + G.SCAN_X) / 2; return <path key={m.id} d={`M ${G.AXIS_X} ${yt} C ${mid} ${yt}, ${mid} ${y + 12}, ${G.SCAN_X} ${y + 12}`} fill="none" stroke={SCAN_C} strokeWidth={1.5} strokeOpacity={0.55} /> })}
            {markers.map((e) => { const st = EVENT_STYLE[e.kind]; const my = magForY(yOf(e.t0)); return <circle key={e.id} cx={G.AXIS_X} cy={yOf(e.t0)} r={(st.notable ? 4 : 3) * my} fill={st.c} stroke="var(--bg)" strokeWidth={1} style={{ transition: 'r 110ms ease-out' }} /> })}
            {cursor && <line x1={0} y1={cursor.y} x2={G.CONTENT_W} y2={cursor.y} stroke="var(--accent)" strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.7} />}
          </svg>

          <div className="absolute text-[10px] font-medium uppercase tracking-wide" style={{ left: G.VIDEO_X, top: 6, color: VIDEO_C }}>Videos</div>
          <div className="absolute text-[10px] font-medium uppercase tracking-wide" style={{ left: G.PHOTO_X, top: 6, color: PHOTO_C }}>Photos</div>
          <div className="absolute text-[10px] font-medium uppercase tracking-wide" style={{ left: G.SCAN_X, top: 6, color: SCAN_C }}>Sail scans</div>

          {ticks.map((t) => <div key={t} className="absolute font-mono text-[10px] text-muted" style={{ left: G.AXIS_X + 8, top: yOf(t) - 7 }}>{hms(t, tz)}</div>)}

          {G.showEventLabels && markers.filter((e) => EVENT_STYLE[e.kind].notable).map((e) => {
            const st = EVENT_STYLE[e.kind]
            const my = magForY(yOf(e.t0))
            return (
              <div key={e.id} className="absolute whitespace-nowrap will-change-transform" style={{ left: G.EVENT_LABEL_X, top: yOf(e.t0) - 8, transform: `scale(${my.toFixed(3)})`, transformOrigin: 'left center', zIndex: my > 1.05 ? 40 : undefined, transition: 'transform 110ms ease-out' }}>
                <span className="rounded px-1 py-px text-[9px] font-medium" style={{ background: st.c + '22', border: `1px solid ${st.c}55`, color: st.c }}>{e.title || st.label}</span>
              </div>
            )
          })}

          {cursor && (
            <div className="pointer-events-none absolute z-[60] rounded bg-[color:var(--accent)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[color:var(--accent-fg)]" style={{ left: 0, top: cursor.y - 9 }}>{hms(cursor.t, tz)}</div>
          )}

          {vPlaced.map(({ m, y }, i) => { const cy = y + G.VIDEO_H / 2, mag = magFor(G.VIDEO_X, G.VIDEO_W, cy), push = ptr ? Math.sign(cy - ptr.y) * (mag - 1) * G.VIDEO_H * 0.55 : 0; return <MediaCard key={m.id} m={m} x={G.VIDEO_X} y={y} w={G.VIDEO_W} h={G.VIDEO_H} color={VIDEO_C} tz={tz} index={Math.min(i, 12)} mag={mag} push={push} focused={mag > 1 + MAG_AMP * 0.6} ev={nearestEvent(m.t)} onClick={() => clickMedia(m)} /> })}
          {pPlaced.map(({ m, y }, i) => { const cy = y + G.PHOTO_H / 2, mag = magFor(G.PHOTO_X, G.PHOTO_W, cy), push = ptr ? Math.sign(cy - ptr.y) * (mag - 1) * G.PHOTO_H * 0.55 : 0; return <MediaCard key={m.id} m={m} x={G.PHOTO_X} y={y} w={G.PHOTO_W} h={G.PHOTO_H} color={PHOTO_C} tz={tz} index={Math.min(i, 12)} mag={mag} push={push} focused={mag > 1 + MAG_AMP * 0.6} ev={nearestEvent(m.t)} onClick={() => clickMedia(m)} /> })}
          {sPlaced.map(({ m, y }, i) => { const cy = y + G.SCAN_H / 2, mag = magFor(G.SCAN_X, G.SCAN_W, cy), push = ptr ? Math.sign(cy - ptr.y) * (mag - 1) * G.SCAN_H * 0.55 : 0; return <MediaCard key={m.id} m={m} x={G.SCAN_X} y={y} w={G.SCAN_W} h={G.SCAN_H} color={SCAN_C} tz={tz} index={Math.min(i, 12)} mag={mag} push={push} focused={mag > 1 + MAG_AMP * 0.6} ev={nearestEvent(m.t)} onClick={() => clickMedia(m)} /> })}

          {markers.length === 0 && (media || []).length === 0 && (
            <div className="absolute text-xs text-muted" style={{ left: G.VIDEO_X, top: PAD }}>No markers, photos or videos for this day.</div>
          )}
        </div>
      </div>

      <Dialog open={!!openPhoto} onOpenChange={(o) => { if (!o) setOpenPhoto(null) }}>
        {openPhoto && <DialogContent title="Photo" className="w-[min(1300px,calc(100vw-16px))] max-w-none max-h-[96vh] overflow-auto p-3"><PhotoOverlayImage src={openPhoto.original || openPhoto.thumb} inst={openPhoto.inst || {}} /></DialogContent>}
      </Dialog>
      <Dialog open={!!openVideo} onOpenChange={(o) => { if (!o) setOpenVideo(null) }}>
        {openVideo && (
          <DialogContent title={openVideo.title || 'Video'} className="w-[min(1300px,calc(100vw-16px))] max-w-none max-h-[96vh] overflow-auto p-3">
            <FallbackVideoPlayer videoId={openVideo.id} />
            {openVideo.tags.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{openVideo.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>}
          </DialogContent>
        )}
      </Dialog>
      {openScan?.raw && teamId && (
        <SailScanDetail
          scan={openScan.raw}
          teamId={teamId}
          sails={sailInventory}
          canEdit={false}
          sessionTzOffset={tz}
          onClose={() => setOpenScan(null)}
        />
      )}
    </div>
  )
}

// Deck card. DOM order gives the stacked "playing cards" look. Magnification is
// driven by the cursor's proximity (macOS-Dock fisheye): `mag` is this card's
// scale, `push` nudges it away from the cursor so the lens spreads cleanly, and
// `focused` (card right under the cursor) reveals its sail / event / TWS / TWA.
function MediaCard({ m, x, y, w, h, color, tz, index, mag, push, focused, ev, onClick }: {
  m: MediaItem; x: number; y: number; w: number; h: number; color: string; tz: number
  index: number; mag: number; push: number; focused: boolean; ev: TimelineNode | null; onClick: () => void
}) {
  const evStyle = ev ? EVENT_STYLE[ev.kind] : null
  return (
    <button
      onClick={onClick}
      title={m.type === 'video' ? (m.title || 'Play video') : hms(m.t, tz)}
      className="tl-card-in absolute overflow-visible rounded-lg text-left shadow-md transition-[transform,box-shadow] duration-[110ms] ease-out will-change-transform motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2"
      style={{ left: x, top: y, width: w, height: h, transformOrigin: 'center', ['--i' as any]: index, zIndex: 100 + Math.round((mag - 1) * 200), boxShadow: focused ? '0 8px 26px rgba(0,0,0,0.45)' : undefined, transform: `translateY(${push.toFixed(1)}px) scale(${mag.toFixed(3)})` }}
    >
      <div className="relative h-full w-full overflow-hidden rounded-lg" style={{ border: `2px solid ${color}`, background: 'var(--surface-2)' }}>
        {m.thumb ? <img src={m.thumb} alt="" loading="lazy" className="tl-parallax-img h-full w-full object-cover" />
          : <div className="flex h-full w-full items-center justify-center text-muted">{m.type === 'video' ? <Play size={18} aria-hidden /> : m.type === 'sailscan' ? <Sailboat size={18} aria-hidden /> : <Camera size={16} aria-hidden />}</div>}
        <span className="absolute left-1 top-1 rounded px-1 py-px font-mono text-[9px] font-semibold text-white" style={{ background: color }}>{hms(m.t, tz)}</span>
        {m.type === 'video' && <span className={`absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white ${focused ? 'opacity-0' : ''}`}><Play size={15} aria-hidden /></span>}

        {/* Metadata — revealed on the card directly under the cursor. */}
        {focused && (
          <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-1 bg-black/72 px-1.5 py-1">
            {m.sailName && <Chip s={{ bg: SCAN_C + '22', c: '#C4B5FD', bd: SCAN_C + '55' }}>{m.sailName}</Chip>}
            {m.tws != null && <Chip s={{ bg: '#06B6D422', c: '#7DD3FC', bd: '#06B6D455' }}>TWS {r(m.tws)}kn</Chip>}
            {m.twa != null && <Chip s={{ bg: '#06B6D422', c: '#7DD3FC', bd: '#06B6D455' }}>TWA {r(m.twa)}°</Chip>}
            {m.sails.slice(0, 2).map((sName) => <Chip key={sName} s={chipStyle(sName)}>{sName}</Chip>)}
            {m.tags.slice(0, 3).map((t) => <Chip key={t} s={chipStyle(t)}>{t}</Chip>)}
            {evStyle && <Chip s={{ bg: evStyle.c + '22', c: evStyle.c, bd: evStyle.c + '55' }}>{ev!.title || evStyle.label}</Chip>}
          </div>
        )}
      </div>
    </button>
  )
}

function Chip({ children, s }: { children: React.ReactNode; s: { bg: string; c: string; bd: string } }) {
  return <span className="rounded px-1 py-px text-[8px] font-medium" style={{ background: s.bg, color: s.c, border: `1px solid ${s.bd}` }}>{children}</span>
}

'use client'
import * as React from 'react'
import { ZoomIn, Maximize2 } from 'lucide-react'
import { projectTrack, thin, geoRows, nearestPoint, pointAtUtc, type GeoRow, type TrackPoint } from '@/lib/tagging/trackGeom'
import {
  FIT, MAX_SCALE, toTrack, toScreen, zoomAt, zoomTo, panBy, isFitted, spread, midpoint,
  type Viewport,
} from '@/lib/tagging/viewport'
import { sessionClock } from '@/lib/tagging/clock'
import type { TagWithRequests } from '@/lib/tagging/types'

// The day's track, with a thumb on it.
//
// PRESS AND HOLD picks a point, deliberately rather than on a plain tap. The
// track lives inside a scrolling column, and a tap that selects would fire on
// every attempt to scroll past it; a hold is unambiguous, it is the gesture
// phones already use for "act on this thing", and the 400 ms it costs is nothing
// against a tag being in the wrong place. Any real movement before the timer
// fires cancels it, so a scroll is still a scroll.
//
// Once a point is selected it can be DRAGGED — by then the gesture is understood
// and the crew is adjusting, not scrolling.
//
// ZOOM AND PAN, because a whole day fitted to a phone is a scribble and the two
// tacks you want are four pixels apart. The gestures are arbitrated by how many
// fingers are down, which is the only way to keep them all unambiguous inside a
// column that also scrolls:
//
//   two fingers   pinch to zoom, drag to pan. Never anything else, so it cannot
//                 be confused with a scroll or a hold.
//   one finger    pans WHEN ZOOMED IN, scrolls the page at fit. At fit there is
//                 nothing to pan, so there is nothing to take from the page.
//   hold          picks a point, at any zoom.
//   double tap    zooms in a step; zooms back to fit when already in.
//   wheel         zooms at the cursor, for the desktop.
//
// Tags are drawn where they happened: hollow for a detection nobody has vouched
// for, solid once somebody has, which is the same language the list view uses.

export interface TrackCanvasProps {
  rows: GeoRow[]
  items: TagWithRequests[]
  /** Window to draw, from the race filter. null/null = the whole day. */
  t0?: number | null
  t1?: number | null
  selectedUtc?: number | null
  onSelect: (utc: number | null) => void
  onOpenTag?: (tagId: string) => void
  tzOffsetMin?: number
  /** Shortest the track box may get. It grows to fill whatever it is given. */
  minHeightPx?: number
}

const HOLD_MS = 400
const MOVE_CANCEL_PX = 10

export default function TrackCanvas({
  rows, items, t0, t1, selectedUtc, onSelect, onOpenTag, tzOffsetMin = 0, minHeightPx = 240,
}: TrackCanvasProps) {
  const boxRef = React.useRef<HTMLDivElement>(null)
  // The box fills the column, so both dimensions are measured rather than
  // assumed. A fixed 320px track left a third of a phone screen empty below it
  // and drew the course smaller than it needed to be.
  const [size, setSize] = React.useState({ w: 0, h: 0 })
  const [holding, setHolding] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const [view, setView] = React.useState<Viewport>(FIT)

  React.useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const read = (w: number, h: number) => setSize((p) => (p.w === w && p.h === h ? p : { w, h }))
    const ro = new ResizeObserver(([e]) => read(e.contentRect.width, e.contentRect.height))
    ro.observe(el)
    const r = el.getBoundingClientRect()
    read(r.width, r.height)
    return () => ro.disconnect()
  }, [])

  const w = size.w || 320
  const h = Math.max(minHeightPx, size.h || minHeightPx)

  // Filter, thin, project — in that order. Filtering first means a race view
  // keeps its full resolution instead of spending the thinning budget on the
  // rest of the day.
  const projection = React.useMemo(() => {
    const clean = geoRows(rows).filter(
      (r) => (t0 == null || r.utc >= t0) && (t1 == null || r.utc <= t1)
    )
    return projectTrack(thin(clean, 1200), { width: w, height: h, pad: 16 })
  }, [rows, t0, t1, w, h])

  const { points, path } = projection
  const selected = selectedUtc == null ? null : pointAtUtc(points, selectedUtc)

  // Tags that fall inside the window AND have a position to be drawn at.
  const marks = React.useMemo(() => {
    if (!points.length) return []
    const from = points[0].utc
    const to = points[points.length - 1].utc
    return items
      .filter((i) => !i.tag.rejected && i.tag.t0 >= from && i.tag.t0 <= to)
      .map((i) => ({ item: i, pt: pointAtUtc(points, i.tag.t0) }))
      .filter((m): m is { item: TagWithRequests; pt: TrackPoint } => !!m.pt)
  }, [items, points])

  // ── Gestures ──────────────────────────────────────────────────────────────
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = React.useRef<{ x: number; y: number } | null>(null)
  const lastTap = React.useRef(0)
  // Every pointer currently down, by id. Two of them means a pinch, and the
  // count is the only reliable way to tell one gesture from another.
  const pointers = React.useRef(new Map<number, { x: number; y: number }>())
  const pinch = React.useRef<{ dist: number } | null>(null)
  const panning = React.useRef<{ x: number; y: number } | null>(null)
  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }

  const box = { width: w, height: h }

  const localXY = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  // A press arrives in SCREEN pixels; the track lives in its own space. Every
  // pick goes through the inverse transform or it lands somewhere else entirely
  // the moment anybody zooms.
  const pick = (screen: { x: number; y: number }) => {
    const p = toTrack(view, screen)
    const hit = nearestPoint(points, p.x, p.y)
    if (hit) onSelect(hit.point.utc)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!points.length) return
    // A press on one of the overlay controls is a button press, not a gesture.
    // The gesture layer calls setPointerCapture, and capturing the pointer on
    // the container SWALLOWS the button's click — so zoom in and fit did
    // nothing at all, on a thumb as much as in a test.
    if ((e.target as HTMLElement | null)?.closest?.('button')) return
    const xy = localXY(e)
    pointers.current.set(e.pointerId, xy)
    boxRef.current?.setPointerCapture(e.pointerId)

    // Second finger down: this is a pinch, and whatever the first one was doing
    // is cancelled. Holding with one finger and then resting another on the
    // screen must not drop a tag.
    if (pointers.current.size === 2) {
      clearTimer(); setHolding(false); setDragging(false)
      panning.current = null
      const [a, b] = Array.from(pointers.current.values())
      pinch.current = { dist: spread(a, b) }
      return
    }
    if (pointers.current.size > 2) return

    start.current = xy

    // Double tap: in a step, or back to fit when already in. The second tap has
    // to land near the first, or a quick pick-then-pick elsewhere would zoom.
    const now = Date.now()
    if (now - lastTap.current < 300 && Math.hypot(xy.x - (start.current?.x ?? 0), xy.y - (start.current?.y ?? 0)) < 40) {
      lastTap.current = 0
      setView((v) => (isFitted(v) ? zoomTo(v, xy, 3, box) : FIT))
      return
    }
    lastTap.current = now

    // Already selected and the press landed on the marker: go straight to
    // dragging. Compared in SCREEN space, because that is where the thumb is —
    // the marker moves as the view moves.
    const selScreen = selected ? toScreen(view, selected) : null
    if (selScreen && Math.hypot(selScreen.x - xy.x, selScreen.y - xy.y) <= 22) {
      setDragging(true)
      return
    }

    // Zoomed in, one finger is a pan — there is something to pan, and the page
    // behind can still be scrolled by pinching back out first.
    if (!isFitted(view)) panning.current = xy

    setHolding(true)
    clearTimer()
    timer.current = setTimeout(() => {
      timer.current = null
      setHolding(false)
      setDragging(true)
      panning.current = null
      // A short buzz is the only confirmation that works with the phone in one
      // hand and eyes on the boat. Absent on iOS Safari, which is fine — the
      // marker appearing says the same thing.
      try { navigator.vibrate?.(12) } catch { /* not supported */ }
      pick(xy)
    }, HOLD_MS)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    const xy = localXY(e)
    pointers.current.set(e.pointerId, xy)

    // Two fingers: zoom by how far apart they are, pan by where their midpoint
    // went. Both at once, which is what a pinch actually is.
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = Array.from(pointers.current.values())
      const dist = spread(a, b)
      if (dist > 0 && pinch.current.dist > 0) {
        const factor = dist / pinch.current.dist
        const at = midpoint(a, b)
        setView((v) => zoomAt(v, at, factor, box))
      }
      pinch.current = { dist }
      return
    }

    const s = start.current
    if (!s) return
    if (dragging) { pick(xy); return }

    if (panning.current) {
      // The delta is computed BEFORE setView and before the ref moves on. A
      // state updater runs during the next render, not here — reading
      // panning.current inside it gave a delta of exactly zero every time,
      // because by then it had already been reassigned to this same point.
      const dx = xy.x - panning.current.x
      const dy = xy.y - panning.current.y
      panning.current = xy
      setView((v) => panBy(v, dx, dy, box))
      // Panning is not holding — a drag that moves the view must not also drop
      // a tag when the timer fires.
      if (Math.hypot(xy.x - s.x, xy.y - s.y) > MOVE_CANCEL_PX) { clearTimer(); setHolding(false) }
      return
    }

    // Moved before the hold fired — they are scrolling, not selecting.
    if (Math.hypot(xy.x - s.x, xy.y - s.y) > MOVE_CANCEL_PX) { clearTimer(); setHolding(false) }
  }

  const end = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    clearTimer()
    setHolding(false)
    setDragging(false)
    panning.current = null
    start.current = null
    try { boxRef.current?.releasePointerCapture(e.pointerId) } catch { /* never captured */ }
  }

  // Desktop: the wheel zooms at the cursor. Non-passive, because it has to be
  // preventable — otherwise the page scrolls out from under the track.
  React.useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!points.length) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const at = { x: e.clientX - r.left, y: e.clientY - r.top }
      // A trackpad sends many small deltas and a mouse a few large ones; the
      // exponential keeps both feeling like the same gesture.
      setView((v) => zoomAt(v, at, Math.exp(-e.deltaY / 400), { width: w, height: h }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [points.length, w, h])

  // A race filter change reframes the track, so a view zoomed into the old one
  // would be showing a corner of something that is no longer on screen.
  React.useEffect(() => { setView(FIT) }, [t0, t1])

  if (!geoRows(rows).length) {
    return (
      <div className="px-6 py-10 text-center">
        <p className="text-sm font-medium">No track for this day</p>
        <p className="mx-auto mt-1 max-w-xs text-xs text-muted">
          The log has no GPS positions. Tag from the list instead — the buttons
          below still work, and everything lands on the same timeline.
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-2 pt-2">
      <div
        ref={boxRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        className="relative w-full flex-1 select-none overflow-hidden rounded-xl border border-[color:var(--border)] bg-surface-1"
        style={{
          minHeight: minHeightPx,
          // The browser must not claim the gestures we handle. At fit a
          // one-finger vertical drag is still the page's — there is nothing to
          // pan, so taking it would break scrolling past the track. Zoomed in,
          // or mid-drag, everything is ours.
          touchAction: dragging || !isFitted(view) ? 'none' : 'pan-y',
        }}
      >
        <svg width="100%" height="100%" role="img" aria-label="The day's track">
          {/* One transform for everything drawn. The markers scale with the
              track but their RADII do not — a 6px dot at 8× would be a blob
              covering half a beat — so stroke and radius are divided back out. */}
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
          <path
            d={path}
            fill="none"
            stroke="var(--border-strong)"
            strokeWidth={2.5 / view.scale}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {points.length > 1 && (
            <>
              <circle cx={points[0].x} cy={points[0].y} r={5 / view.scale} fill="#22C55E" stroke="#000" strokeOpacity={0.3} strokeWidth={1 / view.scale} />
              <circle
                cx={points[points.length - 1].x}
                cy={points[points.length - 1].y}
                r={5 / view.scale} fill="#94A3B8" stroke="#000" strokeOpacity={0.3} strokeWidth={1 / view.scale}
              />
            </>
          )}

          {marks.map(({ item, pt }) => {
            const t = item.tag
            const solid = t.source !== 'auto' || t.verifiedAt != null
            return (
              <circle
                key={t.id}
                cx={pt.x} cy={pt.y} r={6 / view.scale}
                fill={solid ? t.color : 'var(--surface-1)'}
                stroke={t.color}
                strokeWidth={2 / view.scale}
                className={onOpenTag ? 'cursor-pointer' : undefined}
                onClick={(e) => { e.stopPropagation(); onOpenTag?.(t.id) }}
              >
                <title>{`${t.label} · ${sessionClock(t.t0, tzOffsetMin)}`}</title>
              </circle>
            )
          })}

          {selected && (
            <g>
              {/* A ring big enough to see under a thumb that is on top of it. */}
              <circle cx={selected.x} cy={selected.y} r={16 / view.scale} fill="var(--accent)" fillOpacity={0.18} />
              <circle cx={selected.x} cy={selected.y} r={9 / view.scale} fill="none" stroke="var(--accent)" strokeWidth={2.5 / view.scale} />
              <circle cx={selected.x} cy={selected.y} r={3 / view.scale} fill="var(--accent)" />
            </g>
          )}
          </g>
        </svg>

        {/* ── Zoom controls ───────────────────────────────────────────────
            A pinch is the gesture, but not everybody has two free hands on a
            moving boat and a desktop has no pinch at all. Fit only appears
            when there is something to get back from. */}
        <div className="absolute right-2 top-2 flex flex-col gap-1">
          <button
            onClick={() => setView((v) => zoomAt(v, { x: w / 2, y: h / 2 }, 1.8, { width: w, height: h }))}
            disabled={view.scale >= MAX_SCALE}
            aria-label="Zoom in"
            className="grid h-9 w-9 place-items-center rounded-lg border border-[color:var(--border)] bg-surface-1/90 text-secondary backdrop-blur disabled:opacity-40"
          >
            <ZoomIn size={16} aria-hidden />
          </button>
          {!isFitted(view) && (
            <button
              onClick={() => setView(FIT)}
              aria-label="Fit the whole track"
              className="grid h-9 w-9 place-items-center rounded-lg border border-[color:var(--border)] bg-surface-1/90 text-secondary backdrop-blur"
            >
              <Maximize2 size={16} aria-hidden />
            </button>
          )}
        </div>

        {/* How far in, so a track that looks unfamiliar is explained. */}
        {!isFitted(view) && (
          <span className="pointer-events-none absolute left-2 top-2 rounded-full border border-[color:var(--border)] bg-surface-1/90 px-2 py-0.5 font-mono text-[10px] text-muted">
            {view.scale.toFixed(1)}×
          </span>
        )}

        {holding && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="rounded-full bg-black/60 px-3 py-1 text-xs text-white">Hold…</span>
          </div>
        )}

        {/* On its own backing. As bare text it landed across the track and,
            on a short day, directly on the day-end marker. */}
        {!selected && !holding && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <span className="rounded-full border border-[color:var(--border-strong)] bg-surface-2 px-3 py-1 text-[11px] text-secondary shadow-sm">
              Press and hold to pick · pinch to zoom
            </span>
          </div>
        )}
      </div>

      {selected && (
        <div className="mt-2 flex min-h-[44px] items-center gap-2 rounded-xl border border-[color:var(--accent)] bg-accent-bg px-3">
          <span className="font-mono text-sm font-semibold text-accent">
            {sessionClock(selected.utc, tzOffsetMin)}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-secondary">
            Tag it below, or drag to move
          </span>
          <button
            onClick={() => onSelect(null)}
            className="shrink-0 rounded-lg px-2 py-2 text-xs font-semibold text-accent"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  )
}

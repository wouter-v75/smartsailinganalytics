'use client'
import * as React from 'react'
import { projectTrack, thin, geoRows, nearestPoint, pointAtUtc, type GeoRow, type TrackPoint } from '@/lib/tagging/trackGeom'
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

  // ── The hold gesture ──────────────────────────────────────────────────────
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = React.useRef<{ x: number; y: number } | null>(null)
  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }

  const localXY = (e: React.PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const pick = (x: number, y: number) => {
    const hit = nearestPoint(points, x, y)
    if (hit) onSelect(hit.point.utc)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!points.length) return
    const { x, y } = localXY(e)
    start.current = { x, y }

    // Already selected and the press landed on the marker: go straight to
    // dragging. Re-holding to move a point you can see is busywork.
    if (selected && Math.hypot(selected.x - x, selected.y - y) <= 22) {
      setDragging(true)
      boxRef.current?.setPointerCapture(e.pointerId)
      return
    }

    setHolding(true)
    clearTimer()
    timer.current = setTimeout(() => {
      timer.current = null
      setHolding(false)
      setDragging(true)
      boxRef.current?.setPointerCapture(e.pointerId)
      // A short buzz is the only confirmation that works with the phone in one
      // hand and eyes on the boat. Absent on iOS Safari, which is fine — the
      // marker appearing says the same thing.
      try { navigator.vibrate?.(12) } catch { /* not supported */ }
      pick(x, y)
    }, HOLD_MS)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const s = start.current
    if (!s) return
    const { x, y } = localXY(e)
    if (dragging) { pick(x, y); return }
    // Moved before the hold fired — they are scrolling, not selecting.
    if (Math.hypot(x - s.x, y - s.y) > MOVE_CANCEL_PX) { clearTimer(); setHolding(false) }
  }

  const end = (e: React.PointerEvent) => {
    clearTimer()
    setHolding(false)
    setDragging(false)
    start.current = null
    try { boxRef.current?.releasePointerCapture(e.pointerId) } catch { /* never captured */ }
  }

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
          // The page may scroll through this box vertically; a horizontal drag
          // belongs to us, and once a point is being dragged so does everything.
          touchAction: dragging ? 'none' : 'pan-y',
        }}
      >
        <svg width="100%" height="100%" role="img" aria-label="The day's track">
          <path
            d={path}
            fill="none"
            stroke="var(--border-strong)"
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {points.length > 1 && (
            <>
              <circle cx={points[0].x} cy={points[0].y} r={5} fill="#22C55E" stroke="#000" strokeOpacity={0.3} />
              <circle
                cx={points[points.length - 1].x}
                cy={points[points.length - 1].y}
                r={5} fill="#94A3B8" stroke="#000" strokeOpacity={0.3}
              />
            </>
          )}

          {marks.map(({ item, pt }) => {
            const t = item.tag
            const solid = t.source !== 'auto' || t.verifiedAt != null
            return (
              <circle
                key={t.id}
                cx={pt.x} cy={pt.y} r={6}
                fill={solid ? t.color : 'var(--surface-1)'}
                stroke={t.color}
                strokeWidth={2}
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
              <circle cx={selected.x} cy={selected.y} r={16} fill="var(--accent)" fillOpacity={0.18} />
              <circle cx={selected.x} cy={selected.y} r={9} fill="none" stroke="var(--accent)" strokeWidth={2.5} />
              <circle cx={selected.x} cy={selected.y} r={3} fill="var(--accent)" />
            </g>
          )}
        </svg>

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
              Press and hold to pick a moment
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

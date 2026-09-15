'use client'
import * as React from 'react'
import { ZoomIn, Maximize2, Move, Pencil } from 'lucide-react'
import { projectTrack, thin, geoRows, nearestPoint, nearestPointWithin, pointAtUtc, segmentPath, type GeoRow, type TrackPoint } from '@/lib/tagging/trackGeom'
import {
  FIT, MAX_SCALE, toTrack, toScreen, zoomAt, zoomTo, panBy, isFitted, spread, midpoint,
  type Viewport,
} from '@/lib/tagging/viewport'
import { cn } from '@/lib/ui'
import { sessionClock } from '@/lib/tagging/clock'
import { markerStyle, markerTip, markerLabel, isRetimable } from '@/lib/tagging/markers'
import { MEDIA_COLOURS, MEDIA_LABELS, isSpan, type MediaMark } from '@/lib/mediaDecks'
import type { TagEvent, TagWithRequests } from '@/lib/tagging/types'

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
//
// A tag can be PUT RIGHT from here. Right-click one — or hold it, on a phone —
// and it offers to open or to move; moving drags it along the track and drops
// it on the nearest point. A tag in the wrong place is the commonest thing
// wrong with a tagged day, because people press late, and the track is where
// you can SEE that it is on the wrong side of the mark. Only offered to
// somebody the database would actually let do it (canEditTag).
//
// MEDIA is drawn underneath them, in the timeline's own deck colours: a clip as
// the LENGTH of water it covers, a photo or a sail scan as the point it was
// taken at. "Was that gybe filmed" is a question about a window, and a clip
// drawn as a dot answers it wrongly. Underneath, because the crew's tags are
// what the screen is for — the media is context.
// Their SIZE is a hierarchy — see markers.ts — so a day's hundred and forty
// tacks stay in the background and the handful of moments worth navigating to
// stand out. A mouse hovering one gets the readout; a thumb taps it and opens it.

export interface TrackCanvasProps {
  rows: GeoRow[]
  items: TagWithRequests[]
  /** Window to draw, from the race filter. null/null = the whole day. */
  t0?: number | null
  t1?: number | null
  selectedUtc?: number | null
  onSelect: (utc: number | null) => void
  onOpenTag?: (tagId: string) => void
  /** May this user retime this tag? Same rule the database enforces — see
   *  gating.canEditTagEvent. A tag they may not move gets no drag handle. */
  canEditTag?: (tag: TagEvent) => boolean
  /** Commit a retimed tag. The new instant, not a delta: the caller knows where
   *  the tag started and the canvas knows where it was dropped. */
  onMoveTag?: (tagId: string, utc: number) => void | Promise<unknown>
  /** The day's videos, drone clips, photos and sail scans, drawn where they
   *  were taken. Same colours as the timeline's decks — see lib/mediaDecks.ts. */
  media?: MediaMark[]
  tzOffsetMin?: number
  /** Shortest the track box may get. It grows to fill whatever it is given. */
  minHeightPx?: number
}

const HOLD_MS = 400
// How far along the track one drag step may reach. Big enough that a fast drag
// still crosses a whole day in a second of moving, small enough that it cannot
// jump to the leg lying underneath this one.
const DRAG_WINDOW_MS = 150_000
const MOVE_CANCEL_PX = 10

export default function TrackCanvas({
  rows, items, t0, t1, selectedUtc, onSelect, onOpenTag, canEditTag, onMoveTag,
  media, tzOffsetMin = 0, minHeightPx = 240,
}: TrackCanvasProps) {
  const boxRef = React.useRef<HTMLDivElement>(null)
  // The box fills the column, so both dimensions are measured rather than
  // assumed. A fixed 320px track left a third of a phone screen empty below it
  // and drew the course smaller than it needed to be.
  const [size, setSize] = React.useState({ w: 0, h: 0 })
  const [holding, setHolding] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const [view, setView] = React.useState<Viewport>(FIT)
  // What the mouse is over, in TRACK coordinates so the readout keeps its place
  // through a zoom. Mouse only: a touch has no hover, and a tap opens the tag.
  const [hover, setHover] = React.useState<
    {
      id: string; x: number; y: number
      title: string; clock: string
      extra: string | null
      /** What was on the boat from here on — only a sail change has one. */
      aboard?: string | null
    } | null
  >(null)
  // The right-click / hold menu on one tag, anchored where it was opened.
  const [menu, setMenu] = React.useState<{ tag: TagEvent; x: number; y: number } | null>(null)
  // A tag being dragged along the track. `utc` is where it would land — nothing
  // is written until the drag ends, so letting go outside the track is a
  // cancel rather than a tag flung to the far end of the day.
  const [moving, setMoving] = React.useState<{ tag: TagEvent; utc: number } | null>(null)

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

  // The whole day's tags, for the carried on-board list: what is ABOARD at a
  // sail change is decided by wherever somebody last said so, which may be
  // hours earlier and outside whatever window is drawn.
  const dayTags = React.useMemo(() => items.map((i) => i.tag), [items])

  // Media inside the drawn window, with the geometry each kind needs: a path
  // for a clip, a point for a photo. A clip too short to draw as a line falls
  // back to its start point rather than vanishing.
  const mediaMarks = React.useMemo(() => {
    if (!points.length || !media?.length) return []
    const from = points[0].utc
    const to = points[points.length - 1].utc
    return media
      .filter((m) => m.t1 >= from && m.t0 <= to)
      .map((m) => ({
        m,
        path: isSpan(m.kind) ? segmentPath(points, m.t0, m.t1) : '',
        pt: pointAtUtc(points, m.t0),
      }))
      .filter((x): x is { m: MediaMark; path: string; pt: TrackPoint } => !!x.pt)
  }, [media, points])

  // Both halves have to say yes: the KIND of tag must be one a person placed
  // (a tack is where the boat tacked), and the person must be one the database
  // would let write the change anyway.
  const mayMove = React.useCallback(
    (tag: TagEvent) => !!onMoveTag && isRetimable(tag.slug) && (canEditTag?.(tag) ?? false),
    [onMoveTag, canEditTag]
  )

  const tagById = React.useCallback(
    (id: string | null | undefined) => marks.find((m) => m.item.tag.id === id)?.item.tag || null,
    [marks]
  )

  // ── Gestures ──────────────────────────────────────────────────────────────
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = React.useRef<{ x: number; y: number } | null>(null)
  const lastTap = React.useRef(0)
  // Every pointer currently down, by id. Two of them means a pinch, and the
  // count is the only reliable way to tell one gesture from another.
  const pointers = React.useRef(new Map<number, { x: number; y: number }>())
  const pinch = React.useRef<{ dist: number } | null>(null)
  const panning = React.useRef<{ x: number; y: number } | null>(null)
  // Which tag the current press landed on. Needed because a right-click's
  // `contextmenu` event is RETARGETED to whatever holds the pointer capture, so
  // by the time it arrives e.target is the container and the marker underneath
  // it is unfindable — which is why the menu opened for nobody.
  const pressedTag = React.useRef<TagEvent | null>(null)
  const movingCapture = React.useRef<number | null>(null)
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
    // A tag already in hand: this press is the drag continuing, not a new
    // gesture. Without this, holding it would open a menu mid-drag.
    if (moving) { pointers.current.set(e.pointerId, xy); return }

    const onTag = (e.target as HTMLElement | null)?.closest?.('[data-tag-id]')
    const pressed = onTag ? tagById(onTag.getAttribute('data-tag-id')) : null
    pressedTag.current = pressed
    pointers.current.set(e.pointerId, xy)

    // A press that LANDS ON A TAG is about that tag, not about the water under
    // it. Holding it opens the tag's own menu; the point-picking hold below
    // must not also fire, or one press would both open a menu and drop a pin.
    //
    // NOT captured. Capturing the pointer here retargets every later event —
    // `contextmenu` included — to the container, and then the right-click that
    // was the whole point of this branch arrives pointing at nothing.
    if (pressed && pointers.current.size === 1) {
      start.current = xy
      setHolding(false)
      clearTimer()
      timer.current = setTimeout(() => {
        timer.current = null
        try { navigator.vibrate?.(12) } catch { /* not supported */ }
        setMenu({ tag: pressed, x: xy.x, y: xy.y })
      }, HOLD_MS)
      return
    }

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

    // Dragging a tag along the track. The nearest point wins, which is what
    // makes this usable with a thumb: the tag lands ON the track rather than
    // wherever the finger happened to be.
    if (moving) {
      // Captured only NOW, once there is a drag to protect: a pointer that
      // leaves the box mid-drag would otherwise stop reporting and strand the
      // tag in a half-moved state with no pointerup to finish it.
      if (movingCapture.current == null) {
        try { boxRef.current?.setPointerCapture(e.pointerId); movingCapture.current = e.pointerId } catch { /* gone */ }
      }
      const p = toTrack(view, xy)
      // Searched around where the tag CURRENTLY is, not across the whole day.
      // A windward-leeward course doubles back over itself, so the nearest
      // pixel to a marker on the second beat is routinely a point from the
      // first — a one-pixel nudge moved a tag ten minutes, silently. The
      // window travels with the drag, so a long drag still crosses the day.
      const hit = nearestPointWithin(points, p.x, p.y, moving.utc, DRAG_WINDOW_MS)
      if (hit) setMoving((m) => (m ? { ...m, utc: hit.point.utc } : m))
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
    // Dropping the tag is the only moment anything is written. Landing it back
    // where it started is a no-op rather than a pointless round trip that
    // rewrites updated_at and shows up in the provenance line as an edit.
    if (moving) {
      const { tag, utc } = moving
      setMoving(null)
      movingCapture.current = null
      if (utc !== tag.t0) onMoveTag?.(tag.id, utc)
      pointers.current.delete(e.pointerId)
      try { boxRef.current?.releasePointerCapture(e.pointerId) } catch { /* never captured */ }
      return
    }
    pointers.current.delete(e.pointerId)
    pressedTag.current = null
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

  // A hover whose marker has gone — the race filter changed, the tag was
  // deleted, the day reloaded — must go with it: pointerleave never comes for a
  // node that no longer exists.
  const liveIds = React.useMemo(
    () => new Set([...marks.map((m) => m.item.tag.id), ...mediaMarks.map((x) => x.m.id)]),
    [marks, mediaMarks]
  )
  React.useEffect(() => {
    if (hover && !liveIds.has(hover.id)) setHover(null)
  }, [hover, liveIds])

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
        onContextMenu={(e) => {
          const el = (e.target as HTMLElement | null)?.closest?.('[data-tag-id]')
          // `pressedTag` is the fallback for a retargeted event — see the ref.
          const tag = tagById(el?.getAttribute('data-tag-id')) || pressedTag.current
          if (!tag) return          // empty water keeps the browser's own menu
          e.preventDefault()
          const xy = localXY(e)
          setMenu({ tag, x: xy.x, y: xy.y })
        }}
        className="relative w-full flex-1 select-none overflow-hidden rounded-xl border border-[color:var(--border)] bg-surface-1"
        style={{
          minHeight: minHeightPx,
          // The browser must not claim the gestures we handle. At fit a
          // one-finger vertical drag is still the page's — there is nothing to
          // pan, so taking it would break scrolling past the track. Zoomed in,
          // or mid-drag, everything is ours.
          touchAction: dragging || moving || !isFitted(view) ? 'none' : 'pan-y',
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

          {/* ── Media ────────────────────────────────────────────────────
              Under the tags, in the timeline's deck colours. A clip is the
              length of water it covers; a photo and a scan are the instant they
              were taken. Not pickable: pressing the track picks a MOMENT, and a
              clip that swallowed that press would make a third of the day
              untaggable. */}
          {mediaMarks.map(({ m, path, pt }) => {
            const colour = MEDIA_COLOURS[m.kind]
            const label = `${MEDIA_LABELS[m.kind]}${m.title ? ` · ${m.title}` : ''}`
            const enter = (e: React.PointerEvent) => {
              if (e.pointerType !== 'mouse') return
              setHover({
                id: m.id, x: pt.x, y: pt.y,
                title: label,
                clock: isSpan(m.kind) && m.t1 > m.t0
                  ? `${sessionClock(m.t0, tzOffsetMin)}–${sessionClock(m.t1, tzOffsetMin)}`
                  : sessionClock(m.t0, tzOffsetMin),
                extra: null,
              })
            }
            const leave = () => setHover((prev) => (prev?.id === m.id ? null : prev))
            return path ? (
              <path
                key={m.id}
                d={path}
                fill="none"
                stroke={colour}
                strokeOpacity={0.5}
                strokeWidth={9 / view.scale}
                strokeLinecap="round"
                strokeLinejoin="round"
                role="img"
                aria-label={label}
                onPointerEnter={enter}
                onPointerLeave={leave}
              />
            ) : (
              // A photo, a scan, or a clip too short to draw as a line. Square
              // rather than round, so it cannot be mistaken for a tag at a
              // glance — the two mean different things.
              <rect
                key={m.id}
                x={pt.x - 4 / view.scale}
                y={pt.y - 4 / view.scale}
                width={8 / view.scale}
                height={8 / view.scale}
                rx={1.5 / view.scale}
                fill={colour}
                fillOpacity={0.85}
                stroke="var(--bg)"
                strokeWidth={1 / view.scale}
                role="img"
                aria-label={label}
                onPointerEnter={enter}
                onPointerLeave={leave}
              />
            )
          })}

          {marks.map(({ item, pt: home }) => {
            const t = item.tag
            const solid = t.source !== 'auto' || t.verifiedAt != null
            const { r, strokeWidth } = markerStyle(t.slug)
            // Mid-drag the marker follows the finger, so the crew can see where
            // it will land before they commit to it.
            const dragged = moving?.tag.id === t.id
            const pt = dragged ? (pointAtUtc(points, moving!.utc) || home) : home
            return (
              <g
                key={t.id}
                data-tag-id={t.id}
                role="button"
                // Named rather than titled: a <title> is also a native tooltip,
                // and it would sit under the hover readout saying the same thing
                // a second later.
                aria-label={markerLabel(t, tzOffsetMin, dayTags)}
                className={onOpenTag ? 'cursor-pointer' : undefined}
                onClick={(e) => {
                  e.stopPropagation()
                  // A click that ends a drag, or that dismissed a menu, is not a
                  // request to open the tag.
                  if (moving || menu) return
                  onOpenTag?.(t.id)
                }}
                onPointerEnter={(e) => {
                  if (e.pointerType !== 'mouse') return
                  const tip = markerTip(t, tzOffsetMin, dayTags)
                  setHover({
                    id: t.id, x: pt.x, y: pt.y,
                    title: tip.title, clock: tip.clock,
                    extra: tip.sails, aboard: tip.aboard,
                  })
                }}
                onPointerLeave={() => setHover((prev) => (prev?.id === t.id ? null : prev))}
              >
                {/* Where it started, while it is being dragged — so "how far
                    have I moved it" is a thing you can see rather than infer
                    from a clock. */}
                {dragged && (
                  <circle
                    cx={home.x} cy={home.y} r={r / view.scale}
                    fill="none" stroke={t.color} strokeOpacity={0.45}
                    strokeWidth={strokeWidth / view.scale}
                    strokeDasharray={`${3 / view.scale} ${3 / view.scale}`}
                  />
                )}
                {/* The TARGET, unchanged in size. Shrinking what a tack looks
                    like must not shrink what it takes to hit one. */}
                <circle cx={pt.x} cy={pt.y} r={Math.max(r, 7) / view.scale} fill="transparent" />
                {/* A ring that says "this one is in your hand". */}
                {dragged && (
                  <circle
                    cx={pt.x} cy={pt.y} r={13 / view.scale}
                    fill="none" stroke={t.color} strokeWidth={2 / view.scale} strokeOpacity={0.8}
                  />
                )}
                <circle
                  cx={pt.x} cy={pt.y} r={r / view.scale}
                  fill={solid ? t.color : 'var(--surface-1)'}
                  stroke={t.color}
                  strokeWidth={strokeWidth / view.scale}
                  pointerEvents="none"
                />
              </g>
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

        {/* ── Hover readout ───────────────────────────────────────────────
            Pointing at a sail change asks one question — what were we carrying
            from here on — and the tag already holds the answer, because a sail
            change records the whole state after it rather than a diff. Anything
            else gets its name and its time, which is what the native tooltip
            used to give a second late. */}
        {hover && (() => {
          const at = toScreen(view, { x: hover.x, y: hover.y })
          // Flipped to the inside half, so a marker near the right-hand edge
          // does not put its readout where the box clips it away.
          const flip = at.x > w / 2
          return (
            <div
              className="pointer-events-none absolute z-10 max-w-[60%] -translate-y-1/2 rounded-lg border border-[color:var(--border-strong)] bg-surface-1/95 px-2 py-1 shadow-md backdrop-blur"
              style={{
                left: flip ? undefined : Math.round(at.x + 12),
                right: flip ? Math.round(w - at.x + 12) : undefined,
                top: Math.round(Math.min(Math.max(at.y, 26), Math.max(26, h - 26))),
              }}
            >
              <p className="truncate text-[11px] font-semibold leading-tight">{hover.title}</p>
              <p className="truncate font-mono text-[10px] leading-tight text-muted">{hover.clock}</p>
              {hover.extra && (
                <p className="mt-0.5 truncate text-[11px] font-semibold leading-tight text-accent">
                  {hover.extra}
                </p>
              )}
              {hover.aboard && (
                <p className="truncate text-[10px] leading-tight text-muted">
                  aboard {hover.aboard}
                </p>
              )}
            </div>
          )
        })()}

        {/* ── One tag's menu ───────────────────────────────────────────────
            Right-click on the desktop, hold on a phone. Deliberately two
            entries and no more: the sheet behind "Open" already has everything
            else, and a menu that grows is a menu that gets read. */}
        {menu && (
          <>
            {/* Anywhere else dismisses it — including a press meant for the
                track, which should not also drop a tag. */}
            <button
              aria-label="Close the menu"
              onPointerDown={(e) => { e.stopPropagation(); setMenu(null) }}
              className="absolute inset-0 z-20 cursor-default"
            />
            <div
              role="menu"
              className="absolute z-30 min-w-[190px] overflow-hidden rounded-xl border border-[color:var(--border-strong)] bg-surface-1 shadow-xl"
              style={{
                // Kept inside the box: a menu opened on the right-hand edge
                // otherwise renders where it is clipped away.
                left: menu.x > w / 2 ? undefined : Math.round(menu.x + 8),
                right: menu.x > w / 2 ? Math.round(w - menu.x + 8) : undefined,
                top: Math.round(Math.min(menu.y + 8, Math.max(8, h - 132))),
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="border-b border-[color:var(--border)] px-3 py-2">
                <p className="truncate text-[11px] font-semibold">{menu.tag.label}</p>
                <p className="font-mono text-[10px] text-muted">{sessionClock(menu.tag.t0, tzOffsetMin)}</p>
              </div>
              <button
                role="menuitem"
                onClick={() => { const t = menu.tag; setMenu(null); onOpenTag?.(t.id) }}
                className="flex min-h-[44px] w-full items-center gap-2 px-3 text-left text-[13px] active:bg-surface-2"
              >
                <Pencil size={15} className="shrink-0 text-secondary" aria-hidden />
                Open and edit
              </button>
              {mayMove(menu.tag) ? (
                <button
                  role="menuitem"
                  onClick={() => { const t = menu.tag; setMenu(null); setMoving({ tag: t, utc: t.t0 }) }}
                  className="flex min-h-[44px] w-full items-center gap-2 border-t border-[color:var(--border)] px-3 text-left text-[13px] active:bg-surface-2"
                >
                  <Move size={15} className="shrink-0 text-secondary" aria-hidden />
                  Move along the track
                </button>
              ) : (
                <p className="border-t border-[color:var(--border)] px-3 py-2 text-[11px] text-muted">
                  {isRetimable(menu.tag.slug)
                    ? 'Only the afterguard can retime somebody else’s tag.'
                    : 'Tacks and gybes come from the log — fix the detection, not the tag.'}
                </p>
              )}
            </div>
          </>
        )}

        {/* ── Moving ───────────────────────────────────────────────────────
            A banner rather than a silent mode: a track that has quietly stopped
            scrolling, with no explanation, reads as broken. */}
        {moving && (
          <div className="absolute inset-x-2 top-2 z-30 flex min-h-[44px] items-center gap-2 rounded-xl border border-[color:var(--accent)] bg-surface-1/95 px-3 shadow-lg backdrop-blur">
            <Move size={15} className="shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[11px]">
              <span className="font-semibold">{moving.tag.label}</span>
              <span className="text-muted"> — drag along the track</span>
            </span>
            <span className="shrink-0 font-mono text-[11px] font-semibold text-accent">
              {sessionClock(moving.utc, tzOffsetMin)}
            </span>
            <button
              onClick={() => setMoving(null)}
              onPointerDown={(e) => e.stopPropagation()}
              className="shrink-0 rounded-lg px-2 py-2 text-[11px] font-semibold text-secondary"
            >
              Cancel
            </button>
          </div>
        )}

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

        {/* What the colours mean. Only the kinds actually on this track, so a
            day with no drone footage does not advertise a drone. */}
        {mediaMarks.length > 0 && (
          <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-x-2 gap-y-1">
            {(Object.keys(MEDIA_LABELS) as (keyof typeof MEDIA_LABELS)[])
              .filter((k) => mediaMarks.some((x) => x.m.kind === k))
              .map((k) => (
                <span key={k} className="flex items-center gap-1 rounded-full border border-[color:var(--border)] bg-surface-1/90 px-1.5 py-0.5 text-[9px] text-secondary backdrop-blur">
                  <span className="h-2 w-2 rounded-sm" style={{ background: MEDIA_COLOURS[k] }} aria-hidden />
                  {MEDIA_LABELS[k]}
                </span>
              ))}
          </div>
        )}

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
          // Above the legend when there is one: both sit at the bottom, and on a
          // 320px box a centred hint and a left-aligned legend overlap.
          <div className={cn(
            'pointer-events-none absolute inset-x-0 flex justify-center',
            mediaMarks.length > 0 ? 'bottom-9' : 'bottom-2'
          )}>
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

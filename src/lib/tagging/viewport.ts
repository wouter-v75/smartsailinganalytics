// src/lib/tagging/viewport.ts
// ─────────────────────────────────────────────────────────────────────────────
// Zoom and pan for the track view.
//
// A whole day fitted to a phone screen is a scribble: the tacks at the top of
// the second beat are four pixels apart, and picking one of them with a thumb is
// not a gesture, it is a lottery. So the track zooms.
//
// The transform is a scale about the box's own coordinate space plus a
// translation — no rotation, no skew, which keeps the inverse (screen → track)
// a subtraction and a divide. That inverse is the load-bearing part: every press
// arrives in screen pixels and has to be turned back into a point on the track
// before anything can be picked.
//
// CLAMPED so the track can never be lost. Panning stops when the drawn extent
// would leave the box entirely, and zooming out stops at fit. A view you cannot
// get back from is worse than no zoom at all — on the water nobody hunts for a
// reset button.
//
// Pure — no React, no DOM, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

export interface Viewport {
  /** 1 = the whole track fitted to the box. */
  scale: number
  /** Pixels, applied after the scale. */
  tx: number
  ty: number
}

export interface Box {
  width: number
  height: number
}

export interface Pt { x: number; y: number }

export const FIT: Viewport = { scale: 1, tx: 0, ty: 0 }
export const MIN_SCALE = 1
export const MAX_SCALE = 12

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Clamping a negative into [-0, 0] yields -0, which is not === 0 for Object.is,
// renders as "translate(-0px…)" and makes a fitted view compare unequal to FIT.
// Harmless to look at, confusing everywhere else.
const noNegZero = (v: number) => (v === 0 ? 0 : v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Track coordinates → screen coordinates. */
export const toScreen = (v: Viewport, p: Pt): Pt => ({
  x: p.x * v.scale + v.tx,
  y: p.y * v.scale + v.ty,
})

/** Screen coordinates → track coordinates. The one every press goes through. */
export const toTrack = (v: Viewport, p: Pt): Pt => ({
  x: (p.x - v.tx) / v.scale,
  y: (p.y - v.ty) / v.scale,
})

/**
 * Keep the drawn track overlapping the box.
 *
 * At fit there is nothing to pan, so the translation is pinned to zero. Zoomed
 * in, the track may be dragged until its edge reaches the matching edge of the
 * box and no further — which means the track always fills the view rather than
 * being draggable off into grey space.
 */
export function clampView(v: Viewport, box: Box): Viewport {
  const scale = clamp(isNum(v.scale) ? v.scale : 1, MIN_SCALE, MAX_SCALE)
  // Drawn size at this scale; anything beyond the box is what may be panned.
  const slackX = Math.max(0, box.width * scale - box.width)
  const slackY = Math.max(0, box.height * scale - box.height)
  return {
    scale,
    tx: noNegZero(clamp(isNum(v.tx) ? v.tx : 0, -slackX, 0)),
    ty: noNegZero(clamp(isNum(v.ty) ? v.ty : 0, -slackY, 0)),
  }
}

/**
 * Zoom by a factor, keeping `anchor` (a screen point) over the same bit of track.
 *
 * That is what makes pinch feel like pinch and a wheel feel like a map: the
 * thing under your fingers stays under your fingers. Zooming about the centre
 * instead sends whatever you were looking at off the side of the screen.
 */
export function zoomAt(v: Viewport, anchor: Pt, factor: number, box: Box): Viewport {
  const next = clamp(v.scale * (isNum(factor) ? factor : 1), MIN_SCALE, MAX_SCALE)
  // Solve for the translation that leaves the track point under the anchor.
  const world = toTrack(v, anchor)
  return clampView(
    { scale: next, tx: anchor.x - world.x * next, ty: anchor.y - world.y * next },
    box
  )
}

/** Drag the view by a screen delta. */
export const panBy = (v: Viewport, dx: number, dy: number, box: Box): Viewport =>
  clampView({ scale: v.scale, tx: v.tx + dx, ty: v.ty + dy }, box)

/** Zoom to a level, centred on a screen point. Used by double-tap. */
export const zoomTo = (v: Viewport, anchor: Pt, scale: number, box: Box): Viewport =>
  zoomAt(v, anchor, (isNum(scale) ? scale : 1) / v.scale, box)

export const isFitted = (v: Viewport): boolean => v.scale <= MIN_SCALE + 1e-6

/** Distance between two pointers — the pinch measure. */
export const spread = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Midpoint of two pointers — the pinch anchor. */
export const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

/**
 * The view that frames a stretch of track.
 *
 * Used by the race filter, so picking "Race 2" zooms to race 2 rather than
 * leaving the crew to find it. Padded, because a course drawn hard against the
 * edge of the box reads as cut off.
 */
export function frame(
  points: readonly Pt[],
  box: Box,
  padPx = 24
): Viewport {
  if (!points.length) return FIT
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const w = maxX - minX
  const h = maxY - minY
  if (w <= 0 && h <= 0) return FIT

  const avail = { w: Math.max(1, box.width - padPx * 2), h: Math.max(1, box.height - padPx * 2) }
  const scale = clamp(
    Math.min(w > 0 ? avail.w / w : Infinity, h > 0 ? avail.h / h : Infinity),
    MIN_SCALE,
    MAX_SCALE
  )
  // Centre the stretch in the box, then clamp so the track still fills the view.
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return clampView(
    { scale, tx: box.width / 2 - cx * scale, ty: box.height / 2 - cy * scale },
    box
  )
}

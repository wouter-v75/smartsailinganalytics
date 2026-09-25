// src/lib/photoViewport.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pan and zoom for looking at a photograph.
//
// Pulled out of the component because the arithmetic is the part that goes
// wrong — zooming about the wrong origin, the image drifting off screen, a
// "fit" that fits to the wrong axis — and none of it needs a DOM to test.
//
// COORDINATES. `zoom` is view pixels per image pixel. `pan` is in IMAGE pixels
// and is applied before the zoom, so a point p in the image lands at
// (p + pan) · zoom in the view. That is the same convention the RigShot canvas
// uses; keeping them identical means one mental model for both.
// ─────────────────────────────────────────────────────────────────────────────

export interface Transform {
  zoom: number
  panX: number
  panY: number
}

export interface Size { w: number; h: number }

export const imageToView = (t: Transform, x: number, y: number) =>
  ({ x: (x + t.panX) * t.zoom, y: (y + t.panY) * t.zoom })

export const viewToImage = (t: Transform, x: number, y: number) =>
  ({ x: x / t.zoom - t.panX, y: y / t.zoom - t.panY })

/** The whole image, centred, as large as it will go. */
export function fitTransform(img: Size, view: Size): Transform {
  if (!(img.w > 0) || !(img.h > 0) || !(view.w > 0) || !(view.h > 0)) {
    return { zoom: 1, panX: 0, panY: 0 }
  }
  const zoom = Math.min(view.w / img.w, view.h / img.h)
  return {
    zoom,
    panX: (view.w / zoom - img.w) / 2,
    panY: (view.h / zoom - img.h) / 2,
  }
}

export interface ZoomLimits {
  /** Never smaller than this multiple of the fit zoom. */
  minFitMultiple?: number
  /** Never larger than this many view pixels per image pixel. Above 1:1 the
   *  photograph has nothing more to give — past about 4× you are looking at
   *  JPEG blocks, so there is no point letting it go further. */
  max?: number
}

/**
 * Zoom by `factor`, holding the image point under `viewPoint` still. That is
 * the whole trick of a zoom that feels right: the thing under the cursor does
 * not move.
 */
export function zoomAt(
  t: Transform, viewPoint: { x: number; y: number }, factor: number,
  img: Size, view: Size, limits: ZoomLimits = {},
): Transform {
  const fit = fitTransform(img, view).zoom
  const min = fit * (limits.minFitMultiple ?? 1)
  const max = limits.max ?? 4
  const zoom = Math.max(Math.min(min, max), Math.min(max, t.zoom * factor))
  if (zoom === t.zoom) return t
  const before = viewToImage(t, viewPoint.x, viewPoint.y)
  return {
    zoom,
    panX: viewPoint.x / zoom - before.x,
    panY: viewPoint.y / zoom - before.y,
  }
}

/** Zoom about the middle of the view — what the +/− buttons do. */
export const zoomAboutCentre = (
  t: Transform, factor: number, img: Size, view: Size, limits?: ZoomLimits,
) => zoomAt(t, { x: view.w / 2, y: view.h / 2 }, factor, img, view, limits)

/**
 * Keep the image in contact with the viewport.
 *
 * When the image is smaller than the view on an axis it is centred on that
 * axis; when it is larger, it may be dragged but not past its own edge. Without
 * this, one flick sends the photo off into the dark and the only way back is a
 * reset button nobody finds.
 */
export function clampPan(t: Transform, img: Size, view: Size): Transform {
  if (!(t.zoom > 0)) return t
  const viewW = view.w / t.zoom, viewH = view.h / t.zoom
  const axis = (pan: number, imgLen: number, viewLen: number) => {
    if (imgLen <= viewLen) return (viewLen - imgLen) / 2          // centred
    return Math.min(0, Math.max(viewLen - imgLen, pan))            // inside the edges
  }
  return {
    zoom: t.zoom,
    panX: axis(t.panX, img.w, viewW),
    panY: axis(t.panY, img.h, viewH),
  }
}

/** Drag by a view-pixel delta. */
export const panBy = (t: Transform, dxView: number, dyView: number): Transform =>
  ({ zoom: t.zoom, panX: t.panX + dxView / t.zoom, panY: t.panY + dyView / t.zoom })

/** True when the view is showing the whole image — i.e. nothing to drag. */
export const isFitted = (t: Transform, img: Size, view: Size): boolean =>
  t.zoom <= fitTransform(img, view).zoom * 1.001

/**
 * How much of the image's own detail is on screen, as a percentage. 100 % is
 * one image pixel per view pixel; below that the photograph is being shown
 * smaller than it is.
 */
export const detailPct = (t: Transform, dpr = 1): number => Math.round(t.zoom * dpr * 100)

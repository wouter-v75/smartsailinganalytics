import { describe, it, expect } from 'vitest'
import {
  FIT, MIN_SCALE, MAX_SCALE, toScreen, toTrack, clampView, zoomAt, panBy,
  zoomTo, isFitted, spread, midpoint, frame, type Viewport,
} from '../viewport'

const box = { width: 400, height: 300 }

describe('toScreen / toTrack', () => {
  const v: Viewport = { scale: 2, tx: -50, ty: -30 }

  it('are inverses — the property every press depends on', () => {
    for (const p of [{ x: 0, y: 0 }, { x: 137, y: 42 }, { x: 400, y: 300 }]) {
      const back = toTrack(v, toScreen(v, p))
      expect(back.x).toBeCloseTo(p.x, 9)
      expect(back.y).toBeCloseTo(p.y, 9)
    }
  })

  it('are the identity at fit', () => {
    expect(toScreen(FIT, { x: 12, y: 34 })).toEqual({ x: 12, y: 34 })
    expect(toTrack(FIT, { x: 12, y: 34 })).toEqual({ x: 12, y: 34 })
  })
})

describe('clampView', () => {
  it('pins the translation at fit — there is nothing to pan', () => {
    expect(clampView({ scale: 1, tx: -80, ty: 40 }, box)).toEqual({ scale: 1, tx: 0, ty: 0 })
  })

  it('never yields -0, which is not === 0 and renders as "-0px"', () => {
    const v = clampView({ scale: 1, tx: -80, ty: -80 }, box)
    expect(Object.is(v.tx, 0)).toBe(true)
    expect(Object.is(v.ty, 0)).toBe(true)
  })

  it('refuses to zoom out past fit', () => {
    expect(clampView({ scale: 0.3, tx: 0, ty: 0 }, box).scale).toBe(MIN_SCALE)
  })

  it('caps the zoom', () => {
    expect(clampView({ scale: 500, tx: 0, ty: 0 }, box).scale).toBe(MAX_SCALE)
  })

  it('stops the track being dragged off into grey space', () => {
    // At 2× the drawn track is 800×600, so there is 400×300 of slack and no more.
    const v = clampView({ scale: 2, tx: -999, ty: -999 }, box)
    expect(v.tx).toBe(-400)
    expect(v.ty).toBe(-300)
    const w = clampView({ scale: 2, tx: 999, ty: 999 }, box)
    expect(w.tx).toBe(0)
    expect(w.ty).toBe(0)
  })

  it('survives a view that has gone to NaN rather than propagating it', () => {
    const v = clampView({ scale: NaN, tx: NaN, ty: NaN }, box)
    expect(Number.isFinite(v.scale) && Number.isFinite(v.tx) && Number.isFinite(v.ty)).toBe(true)
  })
})

describe('zoomAt', () => {
  it('keeps the point under the fingers under the fingers', () => {
    const anchor = { x: 300, y: 200 }
    const before = toTrack(FIT, anchor)
    const v = zoomAt(FIT, anchor, 3, box)
    const after = toTrack(v, anchor)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('holds the anchor across a zoom in and back out', () => {
    const anchor = { x: 120, y: 90 }
    let v = zoomAt(FIT, anchor, 4, box)
    const mid = toTrack(v, anchor)
    v = zoomAt(v, anchor, 1 / 2, box)
    expect(toTrack(v, anchor).x).toBeCloseTo(mid.x, 6)
  })

  it('cannot be zoomed out below fit however hard you pinch', () => {
    expect(zoomAt(FIT, { x: 200, y: 150 }, 0.01, box)).toEqual(FIT)
  })

  it('stays clamped, so a zoom near an edge cannot strand the track', () => {
    const v = zoomAt(FIT, { x: 0, y: 0 }, 4, box)
    expect(v.tx).toBeLessThanOrEqual(0)
    expect(v.ty).toBeLessThanOrEqual(0)
    expect(v.tx).toBeGreaterThanOrEqual(-(box.width * v.scale - box.width))
  })

  it('ignores a factor that is not a number', () => {
    const v = { scale: 2, tx: -10, ty: -10 }
    expect(zoomAt(v, { x: 1, y: 1 }, NaN, box).scale).toBe(2)
  })
})

describe('panBy', () => {
  it('does nothing at fit', () => {
    expect(panBy(FIT, 40, 40, box)).toEqual(FIT)
  })

  it('moves the view when zoomed in', () => {
    const v = panBy({ scale: 2, tx: -100, ty: -100 }, 30, -20, box)
    expect(v.tx).toBe(-70)
    expect(v.ty).toBe(-120)
  })

  it('stops at the edge rather than running on', () => {
    expect(panBy({ scale: 2, tx: -10, ty: 0 }, 999, 999, box).tx).toBe(0)
  })
})

describe('zoomTo / isFitted', () => {
  it('goes to an absolute scale', () => {
    expect(zoomTo(FIT, { x: 200, y: 150 }, 4, box).scale).toBeCloseTo(4, 6)
  })

  it('returns to fit, translation and all', () => {
    const zoomed = zoomAt(FIT, { x: 50, y: 50 }, 6, box)
    expect(zoomTo(zoomed, { x: 50, y: 50 }, 1, box)).toEqual(FIT)
  })

  it('knows when it is fitted', () => {
    expect(isFitted(FIT)).toBe(true)
    expect(isFitted({ scale: 1.0000001, tx: 0, ty: 0 })).toBe(true)
    expect(isFitted({ scale: 1.5, tx: 0, ty: 0 })).toBe(false)
  })
})

describe('spread / midpoint', () => {
  it('measure a pinch', () => {
    expect(spread({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 })
  })
})

describe('frame', () => {
  const stretch = [{ x: 180, y: 130 }, { x: 220, y: 170 }]

  it('centres the stretch in the box', () => {
    const v = frame(stretch, box, 0)
    const c = toScreen(v, { x: 200, y: 150 })
    expect(c.x).toBeCloseTo(box.width / 2, 3)
    expect(c.y).toBeCloseTo(box.height / 2, 3)
  })

  it('zooms in on a small stretch', () => {
    expect(frame(stretch, box, 0).scale).toBeGreaterThan(1)
  })

  it('leaves a margin so the course does not read as cut off', () => {
    const padded = frame(stretch, box, 40)
    const tight = frame(stretch, box, 0)
    expect(padded.scale).toBeLessThan(tight.scale)
  })

  it('does not zoom past the cap for a stretch of almost nothing', () => {
    expect(frame([{ x: 200, y: 150 }, { x: 200.01, y: 150 }], box).scale).toBeLessThanOrEqual(MAX_SCALE)
  })

  it('is fit for a single point or nothing at all', () => {
    expect(frame([], box)).toEqual(FIT)
    expect(frame([{ x: 10, y: 10 }], box)).toEqual(FIT)
  })

  it('never returns a view that strands the track', () => {
    const v = frame([{ x: 0, y: 0 }, { x: 5, y: 5 }], box)
    expect(v.tx).toBeLessThanOrEqual(0)
    expect(v.tx).toBeGreaterThanOrEqual(-(box.width * v.scale - box.width) - 1e-6)
  })
})

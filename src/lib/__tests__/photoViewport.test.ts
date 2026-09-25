import { describe, it, expect } from 'vitest'
import {
  fitTransform, zoomAt, zoomAboutCentre, clampPan, panBy, isFitted,
  imageToView, viewToImage, detailPct,
} from '../photoViewport'

// A 24 MP frame in a panel — the real case: 4000×6000 shown in 900×700.
const IMG = { w: 4000, h: 6000 }
const VIEW = { w: 900, h: 700 }

describe('photoViewport — fit', () => {
  it('fits the limiting axis and centres the other', () => {
    const t = fitTransform(IMG, VIEW)
    expect(t.zoom).toBeCloseTo(700 / 6000, 6)          // height is limiting
    const topLeft = imageToView(t, 0, 0)
    const bottomRight = imageToView(t, IMG.w, IMG.h)
    expect(topLeft.y).toBeCloseTo(0, 6)
    expect(bottomRight.y).toBeCloseTo(700, 6)
    // centred horizontally
    expect(topLeft.x).toBeCloseTo(900 - bottomRight.x, 6)
  })

  it('fits a wide image on width instead', () => {
    const t = fitTransform({ w: 6000, h: 4000 }, VIEW)
    expect(t.zoom).toBeCloseTo(900 / 6000, 6)
  })

  it('does not divide by zero before the image has loaded', () => {
    expect(fitTransform({ w: 0, h: 0 }, VIEW)).toEqual({ zoom: 1, panX: 0, panY: 0 })
    expect(fitTransform(IMG, { w: 0, h: 0 })).toEqual({ zoom: 1, panX: 0, panY: 0 })
  })
})

describe('photoViewport — zoom', () => {
  it('holds the point under the cursor still', () => {
    const t0 = fitTransform(IMG, VIEW)
    const cursor = { x: 300, y: 220 }
    const under = viewToImage(t0, cursor.x, cursor.y)
    const t1 = zoomAt(t0, cursor, 2.5, IMG, VIEW)
    const after = imageToView(t1, under.x, under.y)
    expect(after.x).toBeCloseTo(cursor.x, 6)
    expect(after.y).toBeCloseTo(cursor.y, 6)
  })

  it('will not zoom out past the fit, nor in past the limit', () => {
    const fit = fitTransform(IMG, VIEW)
    const out = zoomAt(fit, { x: 450, y: 350 }, 0.1, IMG, VIEW)
    expect(out.zoom).toBeCloseTo(fit.zoom, 9)
    let t = fit
    for (let i = 0; i < 40; i++) t = zoomAt(t, { x: 450, y: 350 }, 1.5, IMG, VIEW)
    expect(t.zoom).toBe(4)                              // default ceiling: 4:1
    expect(zoomAt(t, { x: 450, y: 350 }, 1.5, IMG, VIEW)).toBe(t)  // unchanged object
  })

  it('takes a custom ceiling', () => {
    let t = fitTransform(IMG, VIEW)
    for (let i = 0; i < 40; i++) t = zoomAt(t, { x: 1, y: 1 }, 1.5, IMG, VIEW, { max: 1 })
    expect(t.zoom).toBe(1)
  })

  it('zooms about the centre for the buttons', () => {
    const t0 = fitTransform(IMG, VIEW)
    const centre = { x: VIEW.w / 2, y: VIEW.h / 2 }
    const under = viewToImage(t0, centre.x, centre.y)
    const t1 = zoomAboutCentre(t0, 2, IMG, VIEW)
    const after = imageToView(t1, under.x, under.y)
    expect(after.x).toBeCloseTo(centre.x, 6)
    expect(after.y).toBeCloseTo(centre.y, 6)
  })
})

describe('photoViewport — dragging', () => {
  it('moves the image with the pointer, one for one', () => {
    const t = zoomAt(fitTransform(IMG, VIEW), { x: 450, y: 350 }, 3, IMG, VIEW)
    const p = imageToView(t, 2000, 3000)
    const moved = panBy(t, 120, -45)
    const p2 = imageToView(moved, 2000, 3000)
    expect(p2.x - p.x).toBeCloseTo(120, 6)
    expect(p2.y - p.y).toBeCloseTo(-45, 6)
  })

  it('cannot be flicked off into the dark', () => {
    const zoomed = zoomAt(fitTransform(IMG, VIEW), { x: 450, y: 350 }, 3, IMG, VIEW)
    const flung = clampPan(panBy(zoomed, 99_999, 99_999), IMG, VIEW)
    // the image's top-left cannot come further in than the view's top-left
    const tl = imageToView(flung, 0, 0)
    expect(tl.x).toBeLessThanOrEqual(0.001)
    expect(tl.y).toBeLessThanOrEqual(0.001)
    const br = imageToView(flung, IMG.w, IMG.h)
    expect(br.x).toBeGreaterThanOrEqual(VIEW.w - 0.001)
    expect(br.y).toBeGreaterThanOrEqual(VIEW.h - 0.001)
  })

  it('centres an axis the image does not fill, however hard it is dragged', () => {
    // At the fit zoom the width is smaller than the view, so x stays centred.
    const t = clampPan(panBy(fitTransform(IMG, VIEW), 500, 0), IMG, VIEW)
    const tl = imageToView(t, 0, 0), br = imageToView(t, IMG.w, 0)
    expect(tl.x).toBeCloseTo(VIEW.w - br.x, 6)
  })
})

describe('photoViewport — telling the user where they are', () => {
  it('knows when there is nothing to drag', () => {
    const fit = fitTransform(IMG, VIEW)
    expect(isFitted(fit, IMG, VIEW)).toBe(true)
    expect(isFitted(zoomAt(fit, { x: 1, y: 1 }, 2, IMG, VIEW), IMG, VIEW)).toBe(false)
  })

  it('reports detail as a percentage of the photo\'s own pixels', () => {
    expect(detailPct({ zoom: 1, panX: 0, panY: 0 })).toBe(100)
    expect(detailPct({ zoom: 0.25, panX: 0, panY: 0 })).toBe(25)
    // a retina panel shows two device pixels per CSS pixel, so it is showing
    // twice the detail the CSS zoom suggests
    expect(detailPct({ zoom: 0.5, panX: 0, panY: 0 }, 2)).toBe(100)
  })
})

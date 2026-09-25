import { describe, it, expect } from 'vitest'
import {
  theilSen, robustLine, detectHorizon, traceMastFromSeed, mastWidthAt,
  type Pixels,
} from '../sailTrimCv'

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic frames. Every colour below is chosen against the real 5 Sept
// pixels: pale sky, saturated blue sea, dark navy sails, sun-bleached land.
// ─────────────────────────────────────────────────────────────────────────────
const SKY: RGB = [205, 228, 248]   // blue−red 43 — deliberately NOT "sea"
const SEA: RGB = [28, 72, 148]     // blue−red 120
const LAND: RGB = [96, 104, 74]    // a Sardinian headland: not blue at all
const SAIL: RGB = [26, 38, 72]     // navy, and dark enough to fail the blue floor
type RGB = [number, number, number]

class Canvas implements Pixels {
  data: Uint8ClampedArray
  constructor(public width: number, public height: number) {
    this.data = new Uint8ClampedArray(width * height * 4)
    this.fill(() => SKY)
  }
  fill(f: (x: number, y: number) => RGB | null) {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = f(x, y)
        if (!c) continue
        const i = (y * this.width + x) * 4
        this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = 255
      }
    }
  }
}

/** A frame with the horizon at `tiltDeg`, crossing mid-height at the centre. */
function seascape(W = 1200, H = 800, tiltDeg = 0, yMid = H * 0.62) {
  const slope = Math.tan((tiltDeg * Math.PI) / 180)
  const horizonY = (x: number) => yMid + slope * (x - W / 2)
  const c = new Canvas(W, H)
  c.fill((x, y) => (y >= horizonY(x) ? SEA : null))
  return { canvas: c, horizonY, tiltDeg }
}

describe('sailTrimCv — robust line fitting', () => {
  it('Theil–Sen ignores a large minority of nonsense', () => {
    const xs: number[] = [], ys: number[] = []
    for (let x = 0; x < 100; x++) { xs.push(x); ys.push(3 + 0.5 * x) }
    for (let i = 0; i < 25; i++) { xs.push(i * 4); ys.push(900 - i) }   // 20 % garbage
    const fit = theilSen(xs, ys)!
    expect(fit.slope).toBeCloseTo(0.5, 6)
    expect(fit.intercept).toBeCloseTo(3, 6)
  })

  it('trims to inliers and reports how tight the survivors are', () => {
    const xs: number[] = [], ys: number[] = []
    for (let x = 0; x < 200; x++) { xs.push(x); ys.push(10 - 0.25 * x + (x % 3 === 0 ? 0.5 : -0.5)) }
    xs.push(50, 120); ys.push(-400, 600)
    const fit = robustLine(xs, ys)!
    expect(fit.slope).toBeCloseTo(-0.25, 2)
    expect(fit.inliers).toBe(200)          // the two wild points are dropped
    expect(fit.rms).toBeLessThan(0.6)
  })

  it('gives up rather than guessing', () => {
    expect(theilSen([1, 2], [1, 2])).toBeNull()
    expect(robustLine([5, 5, 5], [1, 2, 3])).toBeNull()   // vertical: no slope
  })
})

describe('sailTrimCv — the horizon', () => {
  it('recovers a level horizon', () => {
    const h = detectHorizon(seascape(1200, 800, 0).canvas)!
    expect(h).not.toBeNull()
    expect(h.tiltDeg).toBeCloseTo(0, 2)
    expect(h.rms).toBeLessThan(1)
  })

  it('recovers tilts across the range a RIB actually produces', () => {
    for (const t of [-23.2, -12, -4.8, 2.5, 9]) {
      const h = detectHorizon(seascape(1400, 900, t).canvas)
      expect(h, `tilt ${t}`).not.toBeNull()
      expect(h!.tiltDeg, `tilt ${t}`).toBeCloseTo(t, 1)
    }
  })

  it('survives a headland that hides more of the skyline than it leaves', () => {
    // Land across 55 % of the width, dropping 60 px BELOW the true horizon —
    // so the majority of columns are outliers and a plain robust fit is wrong.
    const { canvas, horizonY } = seascape(1400, 900, -23.2)
    canvas.fill((x, y) => (x < 1400 * 0.55 && y < horizonY(x) + 60 && y > horizonY(x) - 300 ? LAND : null))
    const h = detectHorizon(canvas)!
    expect(h).not.toBeNull()
    expect(h.tiltDeg).toBeCloseTo(-23.2, 1)
  })

  it('survives a boat sitting on the horizon', () => {
    const { canvas, horizonY } = seascape(1400, 900, -5)
    canvas.fill((x, y) => (x > 600 && x < 820 && y > horizonY(x) - 400 && y < horizonY(x) + 30 ? SAIL : null))
    const h = detectHorizon(canvas)!
    expect(h.tiltDeg).toBeCloseTo(-5, 1)
  })

  it('refuses when there is no horizon rather than inventing one', () => {
    const allSky = new Canvas(800, 600)
    expect(detectHorizon(allSky)).toBeNull()
    // All sea: there is no sky→sea transition anywhere, so there is no horizon
    // to report. This is the case that used to fit the search band's own top
    // edge and call it a horizon.
    const allSea = new Canvas(800, 600); allSea.fill(() => SEA)
    expect(detectHorizon(allSea)).toBeNull()
  })

  it('does not mistake a dark navy sail for the sea', () => {
    const c = new Canvas(1000, 700)
    c.fill((x) => (x > 300 && x < 400 ? SAIL : null))
    expect(detectHorizon(c)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A mast: a dark bar leaning by `tiltDeg`, against sky, with a little bend so
// the fit has something realistic to scatter about.
// ─────────────────────────────────────────────────────────────────────────────
function rigFrame(W = 900, H = 1600, tiltDeg = 17, bendPx = 0) {
  const slope = Math.tan((tiltDeg * Math.PI) / 180)      // dx per dy going UP
  const c = new Canvas(W, H)
  const centreAt = (y: number) => {
    const t = (y - H * 0.5) / (H * 0.5)
    return W * 0.45 - slope * (y - H * 0.5) + bendPx * (1 - t * t)
  }
  c.fill((x, y) => {
    const cxx = centreAt(y)
    return x > cxx && x < cxx + 26 ? SAIL : null
  })
  return { canvas: c, centreAt, tiltDeg }
}

describe('sailTrimCv — tracing the mast from one click', () => {
  it('recovers the lean from a single seed', () => {
    const { canvas, centreAt } = rigFrame(900, 1600, 17)
    const y = 800
    const t = traceMastFromSeed(canvas, { x: centreAt(y) + 1, y })!
    expect(t).not.toBeNull()
    expect(t.axis.tiltDeg).toBeCloseTo(17, 1)
    expect(t.rms).toBeLessThan(1)
    expect(t.spanPx).toBeGreaterThan(1600 * 0.6)
  })

  it('does not need the seed placed precisely — it snaps to the edge', () => {
    const { canvas, centreAt } = rigFrame(900, 1600, -11)
    const y = 700
    for (const off of [-9, -3, 0, 4, 10]) {
      const t = traceMastFromSeed(canvas, { x: centreAt(y) + off, y })
      expect(t, `seed offset ${off}`).not.toBeNull()
      expect(t!.axis.tiltDeg, `seed offset ${off}`).toBeCloseTo(-11, 0)
    }
  })

  it('treats mast bend as scatter, not as failure', () => {
    const { canvas, centreAt } = rigFrame(900, 1600, 14, 22)
    const t = traceMastFromSeed(canvas, { x: centreAt(900) + 1, y: 900 })!
    expect(t.axis.tiltDeg).toBeCloseTo(14, 0)
    expect(t.rms).toBeGreaterThan(2)     // the bend shows up here…
    expect(t.rms).toBeLessThan(30)       // …and is not mistaken for a bad trace
  })

  it('declines on blank sky, and at the frame edge', () => {
    expect(traceMastFromSeed(new Canvas(600, 900), { x: 300, y: 450 })).toBeNull()
    const { canvas } = rigFrame()
    expect(traceMastFromSeed(canvas, { x: 0, y: 0 })).toBeNull()
  })

  it('measures the mast width when the far edge is visible', () => {
    const { canvas, centreAt } = rigFrame(900, 1600, 0)
    const y = 800
    const w = mastWidthAt(canvas, { x: centreAt(y), y })
    expect(w).not.toBeNull()
    expect(w!).toBeGreaterThan(22)
    expect(w!).toBeLessThan(30)
  })

  it('returns null for the width when the mast runs into the sail', () => {
    const c = new Canvas(900, 1600)
    c.fill((x) => (x > 400 ? SAIL : null))    // one edge only, nothing beyond it
    expect(mastWidthAt(c, { x: 400, y: 800 })).toBeNull()
  })
})

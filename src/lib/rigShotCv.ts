// src/lib/rigShotCv.ts
// ─────────────────────────────────────────────────────────────────────────────
// The two things RigShot can find in the picture by itself.
//
//   detectHorizon()      the sea horizon — world-horizontal, by definition,
//                        so the camera's roll for free and, with the mast, the
//                        heel to check the log against
//   traceMastFromSeed()  one click on the mast instead of four on its edges
//
// Deliberately NOT a neural network and not OpenCV. Both of these are long,
// high-contrast, near-straight boundaries against a plain background, which is
// the one case where classical edge finding plus a robust line fit is both
// better and cheaper than anything learned — and it is exactly the regime the
// sub-pixel literature says to stay in when the output is a measurement rather
// than a label. `sailscan-cv.ts` loads 8.5 MB of OpenCV WASM for the stripe
// work; none of that is needed here.
//
// Pure functions over plain pixel buffers: no DOM, no canvas, no network, so
// every one of these is testable on a synthesised image.
//
// ROBUSTNESS is the whole game. A real frame has land on the skyline, wake,
// spray, other boats, a hull and the rig itself intruding into any band you
// pick. So: sample many columns, fit with Theil–Sen (the median of pairwise
// slopes survives a large minority of nonsense), trim, refit by least squares,
// and REFUSE to answer when the fit is poor rather than returning a confident
// wrong line. On the 5 Sept frames a good horizon fits to ~1 px rms over
// hundreds of columns; anything above a few px is not the horizon.
// ─────────────────────────────────────────────────────────────────────────────

import { mastAxisFromPoints, type Px, type MastAxis, type Horizon } from './rigShot'

/** The subset of ImageData these need, so tests can hand over a plain object. */
export interface Pixels {
  width: number
  height: number
  /** RGBA, row-major, 4 bytes per pixel — an ImageData `data` array. */
  data: Uint8ClampedArray | Uint8Array
}

const at = (p: Pixels, x: number, y: number): number => (y * p.width + x) * 4
const lumAt = (p: Pixels, x: number, y: number): number => {
  const i = at(p, x, y)
  return 0.299 * p.data[i] + 0.587 * p.data[i + 1] + 0.114 * p.data[i + 2]
}

// ── robust line fitting ─────────────────────────────────────────────────────

export interface LineFit {
  /** y = slope·x + intercept, in the units given. */
  slope: number
  intercept: number
  rms: number
  /** Points that survived trimming. */
  inliers: number
}

/** Median of a copy — the input is left alone. */
function median(v: number[]): number {
  if (!v.length) return NaN
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Theil–Sen: the median of the slopes of all point pairs. Breakdown point
 * ~29 %, no iteration, no tuning — which is what a band containing land, wake
 * and a passing boat needs. Pairs are subsampled with a stride when there are
 * many points, because the full O(n²) buys nothing here.
 */
export function theilSen(xs: number[], ys: number[]): { slope: number; intercept: number } | null {
  const n = xs.length
  if (n < 3) return null
  const slopes: number[] = []
  const stride = n > 260 ? Math.ceil(n / 260) : 1
  for (let i = 0; i < n; i += stride) {
    for (let j = i + 1; j < n; j += stride) {
      const dx = xs[j] - xs[i]
      if (Math.abs(dx) < 1e-9) continue
      slopes.push((ys[j] - ys[i]) / dx)
    }
  }
  if (!slopes.length) return null
  const slope = median(slopes)
  const intercept = median(xs.map((x, i) => ys[i] - slope * x))
  return { slope, intercept }
}

/** Theil–Sen, then trim to inliers, then ordinary least squares on those. */
export function robustLine(xs: number[], ys: number[], trimPx = 6): LineFit | null {
  const ts = theilSen(xs, ys)
  if (!ts) return null
  const keepX: number[] = [], keepY: number[] = []
  for (let i = 0; i < xs.length; i++) {
    if (Math.abs(ys[i] - (ts.slope * xs[i] + ts.intercept)) <= trimPx) { keepX.push(xs[i]); keepY.push(ys[i]) }
  }
  if (keepX.length < 3) return null
  const n = keepX.length
  const mx = keepX.reduce((a, c) => a + c, 0) / n
  const my = keepY.reduce((a, c) => a + c, 0) / n
  let sxy = 0, sxx = 0
  for (let i = 0; i < n; i++) { sxy += (keepX[i] - mx) * (keepY[i] - my); sxx += (keepX[i] - mx) ** 2 }
  if (sxx < 1e-9) return null
  const slope = sxy / sxx
  const intercept = my - slope * mx
  let res = 0
  for (let i = 0; i < n; i++) res += (keepY[i] - (slope * keepX[i] + intercept)) ** 2
  return { slope, intercept, rms: Math.sqrt(res / n), inliers: n }
}

// ── the horizon ─────────────────────────────────────────────────────────────

export interface HorizonOpts {
  /** How blue "sea" has to be: blue minus red, and a floor on blue. */
  blueOverRed?: number
  minBlue?: number
  /** How much darker than this frame's own sky the sea has to be. The one
   *  threshold that separates sea from a deep blue sky, and it is relative so
   *  it survives exposure changes. */
  darkerThanSkyBy?: number
  /** A run of non-sea rows long enough to mean "the sea ended here" rather
   *  than "a whitecap". */
  gapRows?: number
  /** Columns to sample across the width. */
  columns?: number
  /** Refuse above this rms. A real horizon fits far tighter. */
  maxRmsPx?: number
  minInliers?: number
  /** Fraction of the height to search, top and bottom. */
  bandTop?: number
  bandBottom?: number
}

export interface HorizonResult extends Horizon {
  /** For drawing: the fitted line in image pixels. */
  slope: number
  intercept: number
  /** Every column that voted, so the UI can show what was used. */
  points: Px[]
}

/**
 * Find the sea horizon.
 *
 * Two things make this harder than it sounds on these frames.
 *
 * A clear Mediterranean sky at the TOP of the picture is bluer than the sea is
 * just below the horizon — measured on 5 Sept: sky blue-minus-red 62–70 at the
 * frame top against 91–105 for the sea, but 38 for the pale sky immediately
 * above the horizon. So "find the first blue pixel going down" finds the sky.
 * What separates them reliably is brightness, and only relative to this frame's
 * own exposure: the sky is sampled from the top of the picture and the sea has
 * to be a good deal darker than that.
 *
 * And the boat's own sails are navy — as blue and as dark as the water. So the
 * search runs from the BOTTOM UP: the sea is the region that reaches the bottom
 * edge of the frame, and the horizon is where it stops. The hull, the wake and
 * the rig all sit above that and can only push a column's answer DOWN, never
 * up, which is also why the highest candidate line wins when several fit.
 */
export function detectHorizon(p: Pixels, opts: HorizonOpts = {}): HorizonResult | null {
  const blueOverRed = opts.blueOverRed ?? 45
  const minBlue = opts.minBlue ?? 80
  const darkerThanSkyBy = opts.darkerThanSkyBy ?? 45
  const columns = opts.columns ?? 220
  const maxRms = opts.maxRmsPx ?? 4
  const minInliers = opts.minInliers ?? 30
  // A run of non-sea long enough to be the sky rather than a whitecap.
  const gapRows = opts.gapRows ?? Math.max(12, Math.round(p.height * 0.02))
  const y1 = Math.min(p.height - 2, Math.round(p.height * (opts.bandBottom ?? 1)))
  const y0 = Math.max(2, Math.round(p.height * (opts.bandTop ?? 0.02)))
  if (y1 - y0 < gapRows * 2) return null

  // This frame's sky brightness: the 75th percentile of the top slice, so a
  // rig or a gull across it does not drag the reference down.
  const topRows = Math.max(4, Math.round(p.height * 0.12))
  const sample: number[] = []
  for (let y = 2; y < topRows; y += Math.max(1, Math.round(topRows / 40))) {
    for (let x = 0; x < p.width; x += Math.max(1, Math.round(p.width / 60))) sample.push(lumAt(p, x, y))
  }
  if (sample.length < 10) return null
  sample.sort((a, b) => a - b)
  const skyLum = sample[Math.floor(sample.length * 0.75)]

  const isSea = (x: number, y: number) => {
    const i = at(p, x, y)
    const r = p.data[i], b = p.data[i + 2]
    if (b - r < blueOverRed || b < minBlue) return false
    return lumAt(p, x, y) <= skyLum - darkerThanSkyBy
  }

  const step = Math.max(1, Math.floor(p.width / columns))
  const xs: number[] = [], ys: number[] = []
  for (let x = 0; x < p.width; x += step) {
    if (!isSea(x, y1) && !isSea(x, y1 - 3)) continue     // no sea at the bottom of this column
    let gap = 0, top: number | null = null
    for (let y = y1; y >= y0; y--) {
      if (isSea(x, y)) { gap = 0; top = y; continue }
      if (++gap >= gapRows) break
    }
    if (top != null && top > y0 + 1 && top < y1 - gapRows) { xs.push(x); ys.push(top) }
  }
  if (xs.length < minInliers) return null

  // Candidate lines: the whole width first, then halves, thirds and quarters.
  // Everything that can go wrong pushes a column's answer down, so among the
  // candidates that FIT, the right one is the HIGHEST.
  const cx = p.width / 2
  const windows: [number, number][] = [[0, 1]]
  for (const n of [2, 3, 4]) for (let i = 0; i < n; i++) windows.push([i / n, (i + 1) / n])

  let bestLine: LineFit | null = null
  let bestY = Infinity
  for (const [a, b] of windows) {
    const lo = a * p.width, hi = b * p.width
    const wx: number[] = [], wy: number[] = []
    for (let i = 0; i < xs.length; i++) if (xs[i] >= lo && xs[i] < hi) { wx.push(xs[i]); wy.push(ys[i]) }
    const span = wx.length ? Math.max(...wx) - Math.min(...wx) : 0
    if (wx.length < Math.max(12, minInliers / 3) || span < p.width * 0.15) continue
    const f = robustLine(wx, wy, 6)
    if (!f || f.rms > maxRms) continue
    const yc = f.slope * cx + f.intercept
    if (yc < bestY - 1) { bestY = yc; bestLine = f }
  }
  if (!bestLine) return null

  // Re-fit over EVERY column consistent with the winner, so the reported rms
  // and sample count describe the whole frame rather than the window that
  // happened to find it.
  const gx: number[] = [], gy: number[] = []
  for (let i = 0; i < xs.length; i++) {
    if (Math.abs(ys[i] - (bestLine.slope * xs[i] + bestLine.intercept)) <= 6) { gx.push(xs[i]); gy.push(ys[i]) }
  }
  const fit = (gx.length >= minInliers ? robustLine(gx, gy, 6) : null) ?? bestLine
  if (fit.inliers < minInliers || fit.rms > maxRms) return null

  return {
    tiltDeg: (Math.atan(fit.slope) * 180) / Math.PI,
    rms: fit.rms,
    samples: fit.inliers,
    slope: fit.slope,
    intercept: fit.intercept,
    points: gx.map((x, i) => ({ x, y: gy[i] })),
  }
}

// ── the mast ────────────────────────────────────────────────────────────────

export interface MastTraceOpts {
  /** How far the edge may move between sampled rows before it is lost. */
  windowPx?: number
  /** Rows between samples. */
  stepPx?: number
  /** Consecutive misses before the trace stops. */
  maxMiss?: number
  /** Fraction of the height the trace may cover, from the seed. */
  reach?: number
}

export interface MastTrace {
  axis: MastAxis
  points: Px[]
  /** Scatter about the straight fit. Mast bend lives in here, so a few tens of
   *  pixels on a 10,000 px rig is health, not failure. */
  rms: number
  /** Vertical span covered, px. */
  spanPx: number
}

/**
 * Trace the mast from ONE click, instead of asking for four edge points.
 *
 * The click says which edge and roughly where; the sky-to-rig contrast at that
 * row sets the threshold; then the boundary is followed up and down with a
 * small search window, sub-pixel interpolated at each row. What comes back is
 * the fitted axis plus the traced points, so the operator can see where it
 * went and drag it back if it wandered onto a shroud.
 *
 * The seed is snapped to the nearest strong edge within ±window, so it does
 * not have to be placed precisely — which matters at fit zoom, where the mast
 * is a couple of pixels wide.
 */
export function traceMastFromSeed(p: Pixels, seed: Px, opts: MastTraceOpts = {}): MastTrace | null {
  const win = opts.windowPx ?? 18
  const step = opts.stepPx ?? Math.max(2, Math.round(p.height / 900))
  const maxMiss = opts.maxMiss ?? 6
  const reach = opts.reach ?? 1

  const sx = Math.round(seed.x), sy = Math.round(seed.y)
  if (sx < 2 || sy < 2 || sx >= p.width - 2 || sy >= p.height - 2) return null

  // Bright side vs dark side, sampled either side of the seed row.
  const sample = (x: number) => (x < 1 || x >= p.width - 1 ? NaN : lumAt(p, x, sy))
  let bright = -Infinity, dark = Infinity
  for (let d = -win; d <= win; d++) {
    const v = sample(sx + d)
    if (!Number.isFinite(v)) continue
    if (v > bright) bright = v
    if (v < dark) dark = v
  }
  if (!(bright - dark > 25)) return null   // no edge worth following here
  const mid = (bright + dark) / 2

  /** Sub-pixel crossing of `mid`, nearest to `from`, within ±win on row y. */
  const edgeAt = (y: number, from: number): number | null => {
    let best: number | null = null, bestD = Infinity
    for (let x = Math.max(1, Math.round(from) - win); x < Math.min(p.width - 1, Math.round(from) + win); x++) {
      const a = lumAt(p, x, y), b = lumAt(p, x + 1, y)
      if ((a - mid) * (b - mid) > 0) continue          // no crossing here
      const t = Math.abs(b - a) < 1e-6 ? 0 : (mid - a) / (b - a)
      const xc = x + t
      const d = Math.abs(xc - from)
      if (d < bestD) { bestD = d; best = xc }
    }
    return best
  }

  const seedEdge = edgeAt(sy, sx)
  if (seedEdge == null) return null

  const pts: Px[] = [{ x: seedEdge, y: sy }]
  for (const dir of [-1, 1] as const) {
    let cur = seedEdge, miss = 0
    const limit = dir < 0 ? Math.max(1, sy - p.height * reach) : Math.min(p.height - 2, sy + p.height * reach)
    for (let y = sy + dir * step; dir < 0 ? y > limit : y < limit; y += dir * step) {
      const e = edgeAt(y, cur)
      if (e == null) { if (++miss > maxMiss) break; continue }
      miss = 0
      cur = e
      pts.push({ x: e, y })
    }
  }
  if (pts.length < 12) return null

  // Fit x against y — the mast is near-vertical, so y is the free variable.
  const fit = robustLine(pts.map((q) => q.y), pts.map((q) => q.x), 12)
  if (!fit) return null

  const ysAll = pts.map((q) => q.y)
  const yLo = Math.max(...ysAll), yHi = Math.min(...ysAll)
  const spanPx = yLo - yHi
  if (spanPx < p.height * 0.15) return null    // too short to fix an axis

  const axis = mastAxisFromPoints(
    { x: fit.slope * yLo + fit.intercept, y: yLo },
    { x: fit.slope * yHi + fit.intercept, y: yHi },
  )
  if (!axis) return null
  return { axis, points: pts, rms: fit.rms, spanPx }
}

/**
 * The mast's apparent WIDTH at a row, from its left edge — the other half of
 * the four-click version, and a scale reference in its own right once the rig
 * model knows the real width. Returns null when the far edge is not a
 * distinguishable edge, which is common: from astern the mast's far side runs
 * into the mainsail and there is nothing to find.
 */
export function mastWidthAt(p: Pixels, leftEdge: Px, maxWidthPx = 140): number | null {
  const y = Math.round(leftEdge.y)
  if (y < 1 || y >= p.height - 1) return null
  const x0 = Math.round(leftEdge.x)
  const inside: number[] = []
  for (let x = x0 + 2; x < Math.min(p.width - 1, x0 + maxWidthPx); x++) inside.push(lumAt(p, x, y))
  if (inside.length < 8) return null
  // The far edge is the strongest luminance step inside the search span.
  let bestX = -1, bestD = 0
  for (let i = 2; i < inside.length - 2; i++) {
    const d = Math.abs((inside[i + 2] + inside[i + 1]) / 2 - (inside[i - 1] + inside[i - 2]) / 2)
    if (d > bestD) { bestD = d; bestX = x0 + 2 + i }
  }
  if (bestD < 18 || bestX < 0) return null
  return bestX - leftEdge.x
}

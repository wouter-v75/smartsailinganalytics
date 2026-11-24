// A polar prepared for routing: a dense, branch-free lookup table.
//
// A routing evaluates the polar tens of millions of times (a 20-year run of a
// 600 nm race is ~10^8 lookups), so the uploaded points are resampled ONCE onto
// a 0.5 kn x 1 deg grid and every lookup after that is a bilinear read.
//
// THE CHOICES, each of which moves elapsed time:
//
// * Within a TWS row, TWA is interpolated with a monotone cubic (PCHIP), not a
//   natural spline and not straight lines. Straight lines put a kink at every
//   tabulated angle, so the best VMG angle is always exactly a tabulated one and
//   the router's beating angle snaps between rows of the file. A natural spline
//   is smooth but overshoots between points, and an overshoot near the top of a
//   reaching curve is free speed the boat does not have. PCHIP is smooth and
//   never leaves the range of its neighbours.
// * Between TWS rows: linear. That is what Expedition, qtVlm and OpenCPN do, and
//   with rows every 2-4 kn the curvature lost is small.
// * Below the lowest TWS row: speed scales linearly to zero at 0 kn. A polar
//   that starts at 6 kn says nothing about 3 kn; proportional is the least
//   assuming fill and is what the common tools do.
// * Above the highest TWS row: HELD at the last row. Extrapolating a polar's
//   slope upwards invents speed in exactly the conditions where a crew reefs.
// * Below the polar's lowest tabulated TWA in that row: NO-GO (speed 0). The
//   router can still lay a mark that is dead upwind by tacking at the beat angle.
//
// The polar's TWS is the wind at the height the polar was MEASURED for — for a
// polar built from a boat's own masthead instruments that is the masthead, not
// 10 m. `refHeightM` carries that, and the wind field is lifted to it before it
// reaches the router (see heightTransfer.ts). Getting this wrong is not small:
// 10 m -> 32 m is +9 % in neutral air and +20-30 % on a stable morning.

import { parsePolarText, type PolarEntry } from '../polarFile'

export interface PolarOptions {
  /** Height (m) at which the polar's TWS is defined. Default 10. */
  refHeightM?: number
  /** Multiplier on every speed, e.g. 0.95 for a delivery crew. Default 1. */
  factor?: number
  /** Seconds lost per tack. Default 60. */
  tackSec?: number
  /** Seconds lost per gybe. Default 45. */
  gybeSec?: number
  /** Highest TWS tabulated in the dense table, kn. Default 60. */
  twsCap?: number
}

export interface RoutingPolar {
  refHeightM: number
  factor: number
  tackSec: number
  gybeSec: number
  /** Boat speed through the water, kn, at TWS (kn) and |TWA| (deg). 0 = no-go. */
  speed(tws: number, twa: number): number
  /** Best upwind / downwind VMG angle and VMG at a TWS. */
  vmg(tws: number): { upTwa: number; upVmg: number; dnTwa: number; dnVmg: number }
  /** Lowest sailable TWA at this TWS. */
  minTwa(tws: number): number
  /** Highest TWS the file actually tabulates. */
  twsMaxData: number
  /** Fastest speed anywhere in the table, kn — a bound for pruning searches. */
  maxBsp: number
  entries: PolarEntry[]
}

const TWS_STEP = 0.5
const NTWA = 181

/** Fritsch-Carlson monotone cubic through (xs, ys), sampled at the integers lo..hi. */
function pchipSample(xs: number[], ys: number[], lo: number, hi: number): Float64Array {
  const n = xs.length
  const out = new Float64Array(hi - lo + 1)
  if (n === 1) { out.fill(ys[0]); return out }
  const h: number[] = [], d: number[] = []
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / h[i]) }
  const m = new Array<number>(n)
  m[0] = d[0]; m[n - 1] = d[n - 2]
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
    }
  }
  let k = 0
  for (let x = lo; x <= hi; x++) {
    if (x <= xs[0]) { out[x - lo] = ys[0]; continue }
    if (x >= xs[n - 1]) { out[x - lo] = ys[n - 1]; continue }
    while (k < n - 2 && x > xs[k + 1]) k++
    const t = (x - xs[k]) / h[k], t2 = t * t, t3 = t2 * t
    out[x - lo] = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h[k] * m[k]
      + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h[k] * m[k + 1]
  }
  return out
}

export function buildRoutingPolar(entries: PolarEntry[], opts: PolarOptions = {}): RoutingPolar {
  if (entries.length < 2) throw new Error('A routing polar needs at least two TWS rows')
  const rows = [...entries].sort((a, b) => a.tws - b.tws)
  const factor = opts.factor ?? 1
  const twsCap = Math.max(opts.twsCap ?? 60, rows[rows.length - 1].tws)

  // One 0..180 row per tabulated TWS, with its own no-go threshold.
  const rowBsp: Float64Array[] = []
  const rowMin: number[] = []
  for (const e of rows) {
    const pts = [...e.points].filter(p => p.bsp > 0).sort((a, b) => a.twa - b.twa)
    // A row that tabulates 0 deg (some exporters do, at speed 0) has its first
    // SAILING angle as the no-go edge.
    const lo = Math.ceil(pts[0].twa)
    const full = new Float64Array(NTWA)
    const s = pchipSample(pts.map(p => p.twa), pts.map(p => p.bsp), lo, 180)
    full.set(s, lo)
    rowBsp.push(full)
    rowMin.push(lo)
  }

  const nTws = Math.round(twsCap / TWS_STEP) + 1
  const table = new Float32Array(nTws * NTWA)
  const minTab = new Float32Array(nTws)
  for (let i = 0; i < nTws; i++) {
    const tws = i * TWS_STEP
    let a: number, b: number, f: number, scale = 1
    if (tws <= rows[0].tws) { a = b = 0; f = 0; scale = tws / rows[0].tws }
    else if (tws >= rows[rows.length - 1].tws) { a = b = rows.length - 1; f = 0 }
    else {
      b = rows.findIndex(r => r.tws >= tws); a = b - 1
      f = (tws - rows[a].tws) / (rows[b].tws - rows[a].tws)
    }
    const mn = rowMin[a] + f * (rowMin[b] - rowMin[a])
    minTab[i] = mn
    for (let t = 0; t < NTWA; t++) {
      const v = t < mn ? 0 : scale * ((1 - f) * rowBsp[a][t] + f * rowBsp[b][t])
      table[i * NTWA + t] = v * factor
    }
  }

  // VMG targets per table row, to the degree.
  const upT = new Float32Array(nTws), upV = new Float32Array(nTws)
  const dnT = new Float32Array(nTws), dnV = new Float32Array(nTws)
  for (let i = 0; i < nTws; i++) {
    let bu = 0, bd = 0, tu = 45, td = 150
    for (let t = 0; t < NTWA; t++) {
      const s = table[i * NTWA + t]
      const u = s * Math.cos(t * Math.PI / 180)
      if (u > bu) { bu = u; tu = t }
      if (-u > bd) { bd = -u; td = t }
    }
    upT[i] = tu; upV[i] = bu; dnT[i] = td; dnV[i] = bd
  }

  const idx = (tws: number) => {
    const x = Math.max(0, Math.min(nTws - 1.000001, tws / TWS_STEP))
    const i = Math.floor(x)
    return { i, f: x - i }
  }

  return {
    refHeightM: opts.refHeightM ?? 10,
    factor,
    tackSec: opts.tackSec ?? 60,
    gybeSec: opts.gybeSec ?? 45,
    twsMaxData: rows[rows.length - 1].tws,
    maxBsp: table.reduce((m, x) => (x > m ? x : m), 0),
    entries: rows,
    speed(tws, twa) {
      const a = Math.min(180, Math.abs(twa))
      const { i, f } = idx(tws)
      const t = Math.min(179, Math.floor(a)), g = a - t
      // Below the no-go edge: 0. At the edge itself, the cell's upper corners,
      // so a blend toward the zeros below the edge cannot shave the beat speed.
      if (a < (1 - f) * minTab[i] + f * minTab[i + 1]) return 0
      const r0 = i * NTWA + t, r1 = r0 + NTWA
      let v00 = table[r0], v10 = table[r1]
      const v01 = table[r0 + 1], v11 = table[r1 + 1]
      if (v00 === 0) v00 = v01
      if (v10 === 0) v10 = v11
      return (1 - f) * ((1 - g) * v00 + g * v01) + f * ((1 - g) * v10 + g * v11)
    },
    vmg(tws) {
      const { i, f } = idx(tws)
      const L = (arr: Float32Array) => (1 - f) * arr[i] + f * arr[i + 1]
      return { upTwa: L(upT), upVmg: L(upV), dnTwa: L(dnT), dnVmg: L(dnV) }
    },
    minTwa(tws) {
      const { i, f } = idx(tws)
      return (1 - f) * minTab[i] + f * minTab[i + 1]
    },
  }
}

/** Parse an Expedition (or grid) polar file straight to a routing polar. */
export function parseRoutingPolar(text: string, opts: PolarOptions = {}): RoutingPolar {
  return buildRoutingPolar(parsePolarText(text), opts)
}

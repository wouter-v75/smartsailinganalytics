// Grid routing: earliest-arrival Dijkstra on a time-dependent graph.
//
// The sea round each leg is laid out as a regular lattice (default 2 nm),
// aligned so the leg's start is exactly a node. Each node joins its neighbours
// through a 16/32/48-direction stencil, and an edge's cost is the time to sail
// it STARTING AT THE TIME the search reaches its tail — so the graph is
// time-dependent and Dijkstra labels arrival times, not distances. State is
// (node, tack side), which is what lets a tack or gybe be charged.
//
// WHY BOTH METHODS. The isochrone method is continuous in heading and space but
// thins its front heuristically; the grid method is exhaustive over the lattice
// but can only sail the stencil's directions. They err in different ways, so
// the spread between them on the same wind is a direct measure of how much of
// an answer is method rather than weather.
//
//   * Angular error. A 16-direction stencil (the knight's move) steps at
//     multiples of ~26.6 deg, so a 42 deg beat is sailed as a mixture of 26.6
//     and 45 deg legs: real time lost. 32 directions bring the largest gap to
//     ~18 deg, 48 to ~14. The default is 32.
//   * FIFO. Dijkstra on a time-dependent graph is exact only when leaving later
//     never arrives earlier. A boat can always slow down or heave to, so waiting
//     is allowed and sailing is FIFO in principle; a router that does not model
//     waiting (this one) can miss a "wait for the breeze" route, and so can the
//     isochrone. The effect is confined to calms that fill in.
//   * The last edge. A mark is generally not on a node, so the grid has its own
//     last-isochrone problem, solved the same way: from every SETTLED node the
//     exact approach() to the mark is tried, the best arrival kept, and the
//     search ends once the queue's earliest time passes it.

import { bearingDeg, destination, distNm, type LatLon } from './geo'
import { approach, signedTwa, type Env } from './motion'
import { sampleWind, type WindSample } from './windField'
import { stepHitsLand } from './land'
import { chainLegs, type LegOut, type RouteResult } from './isochrone'
import type { Course } from './course'

export interface GridOptions {
  /** Lattice spacing, nm. Default 2. */
  cellNm?: number
  /** 16, 32 or 48 directions. Default 32. */
  stencil?: 16 | 32 | 48
  /** Margin round the leg's box: max(minPadNm, padFrac x leg length). */
  padFrac?: number
  minPadNm?: number
  /** Hard cap on lattice nodes per leg. Default 400k. */
  maxNodes?: number
}

const ws: WindSample = { tws: 0, twd: 0, u: 0, v: 0 }

function stencilMoves(n: 16 | 32 | 48): [number, number][] {
  const base: [number, number][] = [[0, 1], [1, 1], [1, 2]]
  if (n >= 32) base.push([1, 3], [2, 3])
  if (n >= 48) base.push([1, 4], [3, 4])
  const out = new Set<string>()
  for (const [a, b] of base) for (const [x, y] of [[a, b], [b, a]]) for (const sx of [-1, 1]) for (const sy of [-1, 1]) out.add(`${x * sx},${y * sy}`)
  return Array.from(out).map(s => s.split(',').map(Number) as [number, number])
}

/** Time (s) to sail a -> b starting at t, RK2 on the speed; null if no-go or land. */
function traverse(env: Env, a: LatLon, b: LatLon, t: number): { sec: number; twa: number; tws: number; bsp: number } | null {
  const L = distNm(a.lat, a.lon, b.lat, b.lon)
  const h = bearingDeg(a.lat, a.lon, b.lat, b.lon)
  if (!sampleWind(env.wind, a.lat, a.lon, t, ws)) return null
  const s0 = env.polar.speed(ws.tws, signedTwa(h, ws.twd))
  if (!(s0 > 0)) return null
  const mid = destination(a.lat, a.lon, h, L / 2)
  if (!sampleWind(env.wind, mid.lat, mid.lon, t + (L / s0) * 1800e3, ws)) return null
  const twa = signedTwa(h, ws.twd)
  const s = env.polar.speed(ws.tws, twa)
  if (!(s > 0)) return null
  if (stepHitsLand(env.land, a, b)) return null
  return { sec: (L / s) * 3600, twa, tws: ws.tws, bsp: s }
}

class Heap {
  k: number[] = []; v: number[] = []
  get size() { return this.k.length }
  push(key: number, val: number) {
    const k = this.k, v = this.v
    let i = k.length; k.push(key); v.push(val)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (k[p] <= key) break
      k[i] = k[p]; v[i] = v[p]; i = p
    }
    k[i] = key; v[i] = val
  }
  pop(): [number, number] {
    const k = this.k, v = this.v
    const top: [number, number] = [k[0], v[0]]
    const lk = k.pop()!, lv = v.pop()!
    if (k.length) {
      let i = 0
      const n = k.length
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && k[c + 1] < k[c]) c++
        if (k[c] >= lk) break
        k[i] = k[c]; v[i] = v[c]; i = c
      }
      k[i] = lk; v[i] = lv
    }
    return top
  }
}

function routeLegGrid(env: Env, from: LatLon, startMs: number, startSide: number, mark: LatLon, radiusNm: number, o: Required<GridOptions>): LegOut {
  const legNm = distNm(from.lat, from.lon, mark.lat, mark.lon)
  const pad = Math.max(o.minPadNm, o.padFrac * legNm)
  const latMid = (from.lat + mark.lat) / 2
  const dLat = o.cellNm / 60, dLon = o.cellNm / (60 * Math.cos(latMid * Math.PI / 180))
  const latMin = Math.min(from.lat, mark.lat) - pad / 60, latMax = Math.max(from.lat, mark.lat) + pad / 60
  const kx = 60 * Math.cos(latMid * Math.PI / 180)
  const lonMin = Math.min(from.lon, mark.lon) - pad / kx, lonMax = Math.max(from.lon, mark.lon) + pad / kx
  // Align the lattice on the leg's start.
  const i0 = Math.ceil((from.lat - latMin) / dLat), j0 = Math.ceil((from.lon - lonMin) / dLon)
  const nLat = i0 + Math.ceil((latMax - from.lat) / dLat) + 1
  const nLon = j0 + Math.ceil((lonMax - from.lon) / dLon) + 1
  if (nLat * nLon > o.maxNodes) {
    return { ok: false, reason: `lattice of ${nLat}x${nLon} exceeds maxNodes; raise cellNm`, arriveMs: NaN, end: from, side: 0, points: [], tacks: 0, gybes: 0 }
  }
  const node = (i: number, j: number): LatLon => ({ lat: from.lat + (i - i0) * dLat, lon: from.lon + (j - j0) * dLon })
  const moves = stencilMoves(o.stencil)

  // State id = (i*nLon + j)*3 + (side+1).
  const NS = nLat * nLon * 3
  const best = new Float64Array(NS).fill(Infinity)
  const parent = new Int32Array(NS).fill(-1)
  const tacks = new Uint16Array(NS), gybes = new Uint16Array(NS)
  const segTwa = new Float32Array(NS), segTws = new Float32Array(NS), segBsp = new Float32Array(NS)
  const done = new Uint8Array(NS)
  const heap = new Heap()
  const s0 = (i0 * nLon + j0) * 3 + (startSide + 1)
  best[s0] = startMs
  heap.push(startMs, s0)

  let fin: { arrive: number; state: number; ap: NonNullable<ReturnType<typeof approach>> } | null = null
  // Generous: an approach of 3-4 cells at a 2 kn crawl. A shorter approach that
  // exists is always found; this only bounds how slow one may be.
  const maxApproachSec = ((o.cellNm * 4) / 2) * 3600

  while (heap.size) {
    const [t, s] = heap.pop()
    if (done[s] || t > best[s]) continue
    if (fin && t >= fin.arrive) break
    done[s] = 1
    const cell = (s / 3) | 0, side = (s % 3) - 1
    const i = (cell / nLon) | 0, j = cell % nLon
    const p = node(i, j)

    // The exact finish from here, when the mark is within a few cells.
    if (distNm(p.lat, p.lon, mark.lat, mark.lon) - radiusNm <= o.cellNm * 3) {
      const ap = approach(env, p, t, side, mark, radiusNm, maxApproachSec)
      if (ap) {
        const arrive = t + ap.sec * 1000
        if (!fin || arrive < fin.arrive) fin = { arrive, state: s, ap }
      }
    }

    for (const [di, dj] of moves) {
      const ii = i + di, jj = j + dj
      if (ii < 0 || jj < 0 || ii >= nLat || jj >= nLon) continue
      const q = node(ii, jj)
      const tr = traverse(env, p, q, t)
      if (!tr) continue
      const nside = tr.twa >= 0 ? 1 : -1
      let pen = 0, tk = 0, gy = 0
      if (side !== 0 && nside !== side) {
        if (Math.abs(tr.twa) < 90) { pen = env.polar.tackSec; tk = 1 } else { pen = env.polar.gybeSec; gy = 1 }
      }
      const arr = t + (tr.sec + pen) * 1000
      const ns = (ii * nLon + jj) * 3 + (nside + 1)
      if (arr < best[ns]) {
        best[ns] = arr; parent[ns] = s
        tacks[ns] = tacks[s] + tk; gybes[ns] = gybes[s] + gy
        segTwa[ns] = tr.twa; segTws[ns] = tr.tws; segBsp[ns] = tr.bsp
        heap.push(arr, ns)
      }
    }
  }

  if (!fin) return { ok: false, reason: 'mark not reached on the lattice (wind ran out, or blocked)', arriveMs: NaN, end: from, side: 0, points: [], tacks: 0, gybes: 0 }
  const f: { arrive: number; state: number; ap: NonNullable<ReturnType<typeof approach>> } = fin
  const chain: number[] = []
  for (let s = f.state; s >= 0; s = parent[s]) chain.push(s)
  chain.reverse()
  const points: LegOut['points'] = []
  for (let k = 0; k < chain.length - 1; k++) {
    const s = chain[k], nx = chain[k + 1]
    const cell = (s / 3) | 0
    const p = node((cell / nLon) | 0, cell % nLon)
    points.push({ lat: p.lat, lon: p.lon, t: best[s], twa: segTwa[nx], tws: segTws[nx], bsp: segBsp[nx] })
  }
  for (const sg of f.ap.segs) points.push({ lat: sg.lat, lon: sg.lon, t: sg.t, twa: sg.twa, tws: sg.tws, bsp: sg.bsp })
  const last = f.state
  return {
    ok: true, arriveMs: f.arrive, end: f.ap.end, side: f.ap.side, points,
    tacks: tacks[last] + f.ap.manoeuvres.tacks, gybes: gybes[last] + f.ap.manoeuvres.gybes,
  }
}

const DEFAULTS: Required<GridOptions> = { cellNm: 2, stencil: 32, padFrac: 0.3, minPadNm: 20, maxNodes: 400_000 }

export function routeGrid(env: Env, course: Course, startMs: number, opts: GridOptions = {}): RouteResult {
  const o = { ...DEFAULTS, ...opts }
  return chainLegs(course, startMs, (from, t, side, mark) => routeLegGrid(env, from, t, side, mark, mark.radiusNm, o))
}

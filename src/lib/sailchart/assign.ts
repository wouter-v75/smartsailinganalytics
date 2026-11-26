// src/lib/sailchart/assign.ts
// ─────────────────────────────────────────────────────────────────────────────
// Which sail a boat carries at a given TWA × TWS, read off its crossover chart —
// the same shapes the Boat → Sail chart tab draws (outline() through the control
// points), so a point the editor shows inside J2 is J2 here.
//
// A chart rarely covers the whole plane. Ryujin's stops at 148° TWA and 28.5 kn,
// while an ocean race spends most of its hours at 145-160°, so "outside" cannot be
// left as a hole. A chart's edges are the VMG angles: deeper than its downwind
// edge is the sail ON that edge at the same TWS (the box the downwind VMG falls
// in), tighter than its upwind edge the sail on the upwind edge. A TWS the chart
// does not reach is first brought to its lowest / highest TWS. Only a hole INSIDE
// the chart's span at that TWS goes to the nearest sail (in 5° x 2 kn cells).
// Every such pick is flagged, so a report can say how much was extrapolated.
// Where two shapes overlap (a converted nav table leaves a sliver at the seams)
// the one drawn last wins, as it does under the editor's pointer.
// ─────────────────────────────────────────────────────────────────────────────

import { outline, contains } from './geometry'
import type { ChartPoint, SailChart } from './model'

export interface SailPick { name: string; group: string; inside: boolean }

/** TWA degrees and TWS knots per "cell" when measuring the nearest sail. */
const CELL = { twa: 5, tws: 2 }

export function makeSailPicker(chart: SailChart): ((twa: number, tws: number) => SailPick) | null {
  const shapes = chart.sails
    .filter(s => s.visible && s.points.length >= 3)
    .map(s => ({ name: s.name, group: s.group, o: outline(s.points, 12, !!s.extra?.straight) }))
  if (!shapes.length) return null
  const at = (p: ChartPoint) => {
    for (let i = shapes.length - 1; i >= 0; i--) if (contains(shapes[i].o, p)) return shapes[i]
    return null
  }
  let twsLo = Infinity, twsHi = -Infinity
  for (const s of shapes) for (const q of s.o) { twsLo = Math.min(twsLo, q.tws); twsHi = Math.max(twsHi, q.tws) }
  // Per TWS (0.1 kn), the chart's tightest and deepest covered TWA and the sails there.
  type Shape = typeof shapes[number]
  const edges = new Map<number, { lo: Shape; hi: Shape; aLo: number; aHi: number } | null>()
  const edgeAt = (tws: number) => {
    const key = Math.round(tws * 10)
    if (edges.has(key)) return edges.get(key)!
    let lo: Shape | null = null, hi: Shape | null = null, aLo = NaN, aHi = NaN
    for (let a = 0; a <= 180; a += 0.5) {
      const s = at({ twa: a, tws: key / 10 })
      if (s) { if (!lo) { lo = s; aLo = a } hi = s; aHi = a }
    }
    const e = lo && hi ? { lo, hi, aLo, aHi } : null
    edges.set(key, e)
    return e
  }
  return (twaSigned, tws) => {
    const p: ChartPoint = { twa: Math.abs(twaSigned), tws }
    const s0 = at(p)
    if (s0) return { name: s0.name, group: s0.group, inside: true }
    // Beyond the downwind / upwind VMG edge: the sail on that edge at this TWS.
    const w = Math.max(twsLo + 0.05, Math.min(twsHi - 0.05, tws))
    const s1 = at({ twa: p.twa, tws: w })
    if (s1) return { name: s1.name, group: s1.group, inside: false }
    const e = edgeAt(w)
    if (e) {
      if (p.twa >= e.aHi) return { name: e.hi.name, group: e.hi.group, inside: false }
      if (p.twa <= e.aLo) return { name: e.lo.name, group: e.lo.group, inside: false }
    }
    const q: ChartPoint = { twa: p.twa, tws: w }
    let best = shapes[0], bd = Infinity
    for (const s of shapes) {
      const o = s.o
      for (let k = 0, j = o.length - 1; k < o.length; j = k++) {
        const d = segDist2(q, o[j], o[k])
        if (d < bd) { bd = d; best = s }
      }
    }
    return { name: best.name, group: best.group, inside: false }
  }
}

/** Squared distance, in cells, from p to the segment a-b. */
function segDist2(p: ChartPoint, a: ChartPoint, b: ChartPoint): number {
  const px = p.twa / CELL.twa, py = p.tws / CELL.tws
  const ax = a.twa / CELL.twa, ay = a.tws / CELL.tws, bx = b.twa / CELL.twa, by = b.tws / CELL.tws
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy
  const t = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0
  const x = ax + t * dx - px, y = ay + t * dy - py
  return x * x + y * y
}

export interface SailHours {
  /** Per sail, in chart order of first appearance: mean hours per race and share of sailing time. */
  sails: { name: string; group: string; hours: number; share: number; outsideHours: number; usedIn?: number }[]
  totalHours: number
  /** Share of sailing time that fell outside every shape and went to the nearest sail. */
  outsideShare: number
}

/**
 * Hours per sail over a set of routes. Each segment k -> k+1 is charged to the
 * sail at point k's TWA/TWS — the same convention as twaTwsTable, so the two add up.
 * `usedIn` is the share of races that carried the sail for an hour or more.
 */
export function sailHours(
  chart: SailChart,
  paths: { t: number; twa: number; tws: number }[][],
): SailHours | null {
  const pick = makeSailPicker(chart)
  if (!pick) return null
  const acc = new Map<string, { name: string; group: string; hours: number; outsideHours: number; used: number }>()
  for (const s of chart.sails) if (s.visible && !acc.has(s.name)) acc.set(s.name, { name: s.name, group: s.group, hours: 0, outsideHours: 0, used: 0 })
  let total = 0, outside = 0
  for (const path of paths) {
    const mine = new Map<string, number>()
    for (let k = 0; k < path.length - 1; k++) {
      const h = (path[k + 1].t - path[k].t) / 3600e3
      if (!(h > 0)) continue
      const s = pick(path[k].twa, path[k].tws)
      const a = acc.get(s.name)!
      a.hours += h; total += h
      mine.set(s.name, (mine.get(s.name) ?? 0) + h)
      if (!s.inside) { a.outsideHours += h; outside += h }
    }
    // "Used" = carried for at least an hour in that race, so a sail the route
    // brushes for one step at a seam does not count as a race it was needed in.
    mine.forEach((h, name) => { if (h >= 1) acc.get(name)!.used++ })
  }
  const n = Math.max(1, paths.length)
  return {
    sails: Array.from(acc.values()).map(({ used, ...a }) => ({ ...a, hours: a.hours / n, outsideHours: a.outsideHours / n, share: total ? a.hours / total : 0, usedIn: used / n })),
    totalHours: total / n,
    outsideShare: total ? outside / total : 0,
  }
}

/** The shape of routing/climatology.ts's TwaTwsTable, which is what a study saves. */
export interface HoursTable { twaEdges: number[]; twsEdges: number[]; hours: number[][]; totalHours: number }

/**
 * Hours per sail from a study's saved TWA x TWS table instead of its routes, so
 * an existing study can be read against a chart without routing it again. Each
 * bin's hours are spread evenly over a 6 x 6 grid of points inside it and each
 * point charged to its sail — a bin a shape's edge cuts through is split, not
 * given whole to one side. The open bins (TWA under the first edge or over the
 * last, TWS over the last) are taken as 5° / 4 kn wide. No `usedIn`: that needs
 * the individual races, which the table has already summed away.
 */
export function sailHoursFromTable(chart: SailChart, t: HoursTable, sub = 6): SailHours | null {
  const pick = makeSailPicker(chart)
  if (!pick) return null
  const acc = new Map<string, { name: string; group: string; hours: number; outsideHours: number }>()
  for (const s of chart.sails) if (s.visible && !acc.has(s.name)) acc.set(s.name, { name: s.name, group: s.group, hours: 0, outsideHours: 0 })
  const A = t.twaEdges, W = t.twsEdges
  const aStep = A.length > 2 ? A[2] - A[1] : 5
  let total = 0, outside = 0
  for (let r = 0; r < A.length; r++) for (let c = 0; c < W.length; c++) {
    const h = t.hours[r]?.[c] ?? 0
    if (!(h > 0)) continue
    const a0 = r === 0 ? A[1] - aStep : A[r], a1 = r === 0 ? A[1] : r === A.length - 1 ? A[r] + aStep : A[r + 1]
    const w0 = W[c], w1 = c === W.length - 1 ? W[c] + 4 : W[c + 1]
    const hh = h / (sub * sub)
    for (let i = 0; i < sub; i++) for (let j = 0; j < sub; j++) {
      const p = pick(a0 + ((i + 0.5) / sub) * (a1 - a0), w0 + ((j + 0.5) / sub) * (w1 - w0))
      const a = acc.get(p.name)!
      a.hours += hh; total += hh
      if (!p.inside) { a.outsideHours += hh; outside += hh }
    }
  }
  return {
    sails: Array.from(acc.values()).map(a => ({ ...a, share: total ? a.hours / total : 0 })),
    totalHours: total,
    outsideShare: total ? outside / total : 0,
  }
}

// src/lib/sailchart/assign.ts
// ─────────────────────────────────────────────────────────────────────────────
// Which sail a boat carries at a given TWA × TWS, read off its crossover chart —
// the same shapes the Boat → Sail chart tab draws (outline() through the control
// points), so a point the editor shows inside J2 is J2 here.
//
// A chart rarely covers the whole plane. Ryujin's stops at 148° TWA and 28.5 kn,
// while an ocean race spends most of its hours at 145-160°, so "outside" cannot be
// left as a hole: it goes to the NEAREST sail on the chart, distance measured in
// chart cells (5° of TWA and 2 kn of TWS, the steps the tables are binned on),
// and is flagged so a report can say how much of the answer was extrapolated.
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
  return (twaSigned, tws) => {
    const p: ChartPoint = { twa: Math.abs(twaSigned), tws }
    for (let i = shapes.length - 1; i >= 0; i--) {
      if (contains(shapes[i].o, p)) return { name: shapes[i].name, group: shapes[i].group, inside: true }
    }
    let best = shapes[0], bd = Infinity
    for (const s of shapes) {
      const o = s.o
      for (let k = 0, j = o.length - 1; k < o.length; j = k++) {
        const d = segDist2(p, o[j], o[k])
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
  sails: { name: string; group: string; hours: number; share: number; outsideHours: number; usedIn: number }[]
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

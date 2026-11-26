// src/lib/sailchart/geometry.ts
// ─────────────────────────────────────────────────────────────────────────────
// Shapes and polar overlays for the sail chart, in DATA units (TWA °, TWS kn).
//
// OUTLINE. A closed UNIFORM Catmull-Rom spline through the control points.
// Uniform rather than centripetal because uniform Catmull-Rom is affine
// invariant: the curve computed in degrees × knots is the same curve the screen
// shows after the axes are scaled, so a shape does not change when the chart is
// resized and a point dragged on screen sits exactly on the drawn line.
//
// OVERLAYS (from the boat's active polar, via polarCalc):
//   • AWS isolines  — for each TWA, the TWS at which apparent wind = N kn
//   • AWA isolines  — for each TWS, the TWA at which apparent angle = N°
//   • VMG lines     — the polar's best upwind and downwind TWA per TWS
// Below the polar's lightest TWS row, BSP is scaled down in proportion to TWS
// rather than held at that row's speed — holding it would put 6 kn of boat speed
// under 1 kn of wind and bend every AWS line at the bottom of the chart.
// ─────────────────────────────────────────────────────────────────────────────

import { polarInterp, polarVMGTarget } from '../polarCalc'
import type { ChartPoint } from './model'

const D2R = Math.PI / 180

export function outline(points: ChartPoint[], steps = 12, straight = false): ChartPoint[] {
  const n = points.length
  if (n < 3 || straight) return points.slice()
  const out: ChartPoint[] = []
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n]
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push({ twa: f(p0.twa, p1.twa, p2.twa, p3.twa), tws: f(p0.tws, p1.tws, p2.tws, p3.tws) })
    }
  }
  return out
}

/** Ray-cast point-in-polygon on an outline. */
export function contains(poly: ChartPoint[], pt: ChartPoint): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a.tws > pt.tws) !== (b.tws > pt.tws) &&
        pt.twa < ((b.twa - a.twa) * (pt.tws - a.tws)) / (b.tws - a.tws) + a.twa) inside = !inside
  }
  return inside
}

/**
 * Where a new control point clicked at `pt` belongs: the index to INSERT it at,
 * i.e. the segment of the drawn curve it is nearest to. `sx`/`sy` are the
 * screen pixels per degree / per knot, so "nearest" is what the eye sees.
 */
export function insertIndex(points: ChartPoint[], pt: ChartPoint, sx = 1, sy = 1, steps = 12): number {
  const curve = outline(points, steps)
  let best = 0, bestD = Infinity
  curve.forEach((c, k) => {
    const d = ((c.twa - pt.twa) * sx) ** 2 + ((c.tws - pt.tws) * sy) ** 2
    if (d < bestD) { bestD = d; best = k }
  })
  return Math.floor(best / steps) + 1
}

export interface Apparent { aws: number; awa: number }
export function apparent(tws: number, twa: number, bsp: number): Apparent {
  const x = bsp + tws * Math.cos(twa * D2R), y = tws * Math.sin(twa * D2R)
  return { aws: Math.hypot(x, y), awa: Math.atan2(y, x) / D2R }
}

/** Polar BSP at (tws, twa), scaled to zero below the polar's lightest row. */
export function bspAt(polar: any, tws: number, twa: number): number {
  if (!polar?.entries?.length) return 0
  const t0 = polar.entries[0].tws
  if (tws < t0) return (polarInterp(polar, t0, twa) || 0) * (tws / t0)
  return polarInterp(polar, tws, twa) || 0
}

const bisect = (f: (x: number) => number, lo: number, hi: number, it = 30) => {
  let flo = f(lo)
  for (let i = 0; i < it; i++) {
    const mid = (lo + hi) / 2, fm = f(mid)
    if ((fm > 0) === (flo > 0)) { lo = mid; flo = fm } else hi = mid
  }
  return (lo + hi) / 2
}

/** First root of f on [lo, hi], scanning in `step`s. */
const firstRoot = (f: (x: number) => number, lo: number, hi: number, step: number): number | null => {
  let a = lo, fa = f(a)
  for (let b = lo + step; b <= hi + 1e-9; b += step) {
    const fb = f(b)
    if (fa === 0) return a
    if ((fa > 0) !== (fb > 0)) return bisect(f, a, b)
    a = b; fa = fb
  }
  return null
}

export interface Range { twaMin: number; twaMax: number; twsMin: number; twsMax: number }

/** For each TWA, the TWS whose apparent wind is `aws` knots. */
export function awsIsoline(polar: any, aws: number, r: Range, step = 1): ChartPoint[] {
  const out: ChartPoint[] = []
  for (let twa = r.twaMin; twa <= r.twaMax + 1e-9; twa += step) {
    const tws = firstRoot(t => apparent(t, twa, bspAt(polar, t, twa)).aws - aws, 0, Math.max(r.twsMax * 2, 60), 0.5)
    if (tws != null && tws >= r.twsMin && tws <= r.twsMax) out.push({ twa, tws })
  }
  return out
}

/** For each TWS, the TWA whose apparent angle is `awa` degrees. */
export function awaIsoline(polar: any, awa: number, r: Range, step = 0.25): ChartPoint[] {
  const out: ChartPoint[] = []
  for (let tws = Math.max(r.twsMin, 0.5); tws <= r.twsMax + 1e-9; tws += step) {
    const twa = firstRoot(a => apparent(tws, a, bspAt(polar, tws, a)).awa - awa, 1, 180, 1)
    if (twa != null && twa >= r.twaMin && twa <= r.twaMax) out.push({ twa, tws })
  }
  return out
}

/** The polar's optimal upwind / downwind TWA, per TWS. */
export function vmgLine(polar: any, side: 'up' | 'down', r: Range, step = 0.5): ChartPoint[] {
  if (!polar?.entries?.length) return []
  const lo = Math.max(r.twsMin, polar.entries[0].tws)
  const hi = Math.min(r.twsMax, polar.entries[polar.entries.length - 1].tws)
  const out: ChartPoint[] = []
  for (let tws = lo; tws <= hi + 1e-9; tws += step) {
    const t = polarVMGTarget(polar, tws)
    const twa = side === 'up' ? t.up : t.down
    if (Number.isFinite(twa) && twa >= r.twaMin && twa <= r.twaMax) out.push({ twa, tws })
  }
  return out
}

/** Round isoline levels that fall inside the chart, e.g. AWS 6,8,…,30. */
export function levels(lo: number, hi: number, step: number): number[] {
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 10) / 10)
  return out
}

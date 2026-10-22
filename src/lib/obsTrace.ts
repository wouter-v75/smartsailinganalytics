// Geometry for the two station traces: speed/gust, and direction.
//
// Pure, because the one thing here that is easy to get wrong is invisible in a
// screenshot and obvious in a test: DIRECTION WRAPS. A trace running 350° → 10°
// is a 20° veer, but joined naively it draws a line plunging the full height of
// the chart, which reads as a 340° backing wind. Every shift through north would
// look like a catastrophe. So the series is cut into segments wherever a step
// crosses the wrap, and each segment is drawn as its own polyline.

import type { ObsPoint } from './windObs'

/** A sensible axis top: round up to 5 kn, never less than 10, with headroom. */
export function niceKnMax(maxKn: number): number {
  if (!Number.isFinite(maxKn) || maxKn <= 0) return 10
  return Math.max(10, Math.ceil((maxKn * 1.1) / 5) * 5)
}

/** The biggest value the speed chart has to fit — gusts included. */
export function traceMaxKn(points: ObsPoint[]): number {
  let m = 0
  for (const p of points) {
    if (Number.isFinite(p.twsKn)) m = Math.max(m, p.twsKn)
    if (p.gustKn != null && Number.isFinite(p.gustKn)) m = Math.max(m, p.gustKn)
  }
  return m
}

/**
 * Split a direction series wherever it crosses the 0/360 wrap, so each run can
 * be drawn as its own line. Points with no direction (calm, variable) break the
 * series too — a line drawn straight through them would invent a direction the
 * station never reported.
 */
export function wrapSegments(points: ObsPoint[]): Array<Array<{ t: number; deg: number }>> {
  const out: Array<Array<{ t: number; deg: number }>> = []
  let run: Array<{ t: number; deg: number }> = []
  let prev: number | null = null
  for (const p of points) {
    const t = Date.parse(p.t)
    if (!Number.isFinite(t) || p.twdDeg == null) { if (run.length) out.push(run); run = []; prev = null; continue }
    const deg = p.twdDeg
    // A step of more than 180 cannot be a real swing between two samples minutes
    // apart; it is the series going round the top or the bottom of the dial.
    if (prev != null && Math.abs(deg - prev) > 180) { out.push(run); run = [] }
    run.push({ t, deg })
    prev = deg
  }
  if (run.length) out.push(run)
  return out.filter((r) => r.length > 0)
}

export interface Box { w: number; h: number; left: number; right: number; top: number; bottom: number }

/** x for a time, within the plot area. */
export function xOf(t: number, t0: number, t1: number, b: Box): number {
  if (!(t1 > t0)) return b.left
  const f = (t - t0) / (t1 - t0)
  return b.left + Math.min(1, Math.max(0, f)) * (b.w - b.left - b.right)
}

/** y for a value on a 0..max axis, within the plot area. */
export function yOf(v: number, max: number, b: Box): number {
  const inner = b.h - b.top - b.bottom
  if (!(max > 0)) return b.top + inner
  const f = Math.min(1, Math.max(0, v / max))
  return b.top + inner * (1 - f)
}

/** An SVG polyline `points` attribute, or '' when there is nothing to draw. */
export function polyline(
  pts: Array<{ x: number; y: number }>,
): string {
  return pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

/**
 * Hour ticks across the window, on the hour. Labels are LOCAL time, because the
 * person reading it is standing at the venue — but the underlying values stay
 * UTC, which is the distinction CLAUDE.md keeps insisting on.
 */
export function hourTicks(t0: number, t1: number): number[] {
  const out: number[] = []
  const d = new Date(t0)
  d.setMinutes(0, 0, 0)
  if (d.getTime() < t0) d.setHours(d.getHours() + 1)
  for (let t = d.getTime(); t <= t1; t += 3600_000) out.push(t)
  return out
}

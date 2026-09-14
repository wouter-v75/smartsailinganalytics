// src/lib/phasePlot.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers behind PhaseXYPlot: phase stats → plot points, a trend per tack,
// padded axis domains, and the polar target line for "BSP vs TWS" / "TWA vs TWS".
// ─────────────────────────────────────────────────────────────────────────────

import type { Mode, PhaseStat, Tack } from './phaseStats'
import { polarInterp, polarVMGTarget } from './polarCalc'

export interface PlotPoint {
  x: number
  y: number
  tack: Tack
  utc: number
  endUtc: number
  sails: string
  n: number
}

// One point per phase that has both values.
export function phasePoints(phases: PhaseStat[] | null | undefined, xKey: string, yKey: string): PlotPoint[] {
  const out: PlotPoint[] = []
  for (const p of phases || []) {
    const x = p.mean[xKey], y = p.mean[yKey]
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue
    out.push({ x, y, tack: p.tack, utc: p.utc, endUtc: p.endUtc, sails: p.sailCombo, n: p.n })
  }
  return out
}

export interface Trend { slope: number; intercept: number; r2: number; x0: number; x1: number }

// Least-squares line over the points' own x-extent; null below 3 points or no x spread.
export function linearTrend(pts: { x: number; y: number }[]): Trend | null {
  const n = pts.length
  if (n < 3) return null
  const mx = pts.reduce((s, p) => s + p.x, 0) / n
  const my = pts.reduce((s, p) => s + p.y, 0) / n
  const den = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0)
  if (!den) return null
  const slope = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / den
  const intercept = my - slope * mx
  const ssTot = pts.reduce((s, p) => s + (p.y - my) ** 2, 0)
  const ssRes = pts.reduce((s, p) => s + (p.y - (slope * p.x + intercept)) ** 2, 0)
  const xs = pts.map(p => p.x)
  return { slope, intercept, r2: ssTot ? 1 - ssRes / ssTot : 0, x0: Math.min(...xs), x1: Math.max(...xs) }
}

export function tackTrends(pts: PlotPoint[]): Record<Tack, Trend | null> {
  return {
    port: linearTrend(pts.filter(p => p.tack === 'port')),
    stbd: linearTrend(pts.filter(p => p.tack === 'stbd')),
  }
}

// [min, max] over the finite values (plus reference values such as a 100 % line),
// padded so dots don't sit on the axes. A flat series gets a ±1 window.
export function plotDomain(values: number[], extra: number[] = [], padFrac = 0.06): [number, number] {
  const v = values.concat(extra).filter(Number.isFinite)
  if (!v.length) return [0, 1]
  let lo = Math.min(...v), hi = Math.max(...v)
  if (hi - lo < 1e-9) return [lo - 1, hi + 1]
  const pad = (hi - lo) * padFrac
  return [lo - pad, hi + pad]
}

// The polar's target across a TWS range: BSP at the best-VMG angle, or that angle
// itself. Only meaningful for x = TWS, upwind or downwind.
export function polarTargetLine(
  polar: any, mode: Mode, yKey: string, x0: number, x1: number, steps = 24
): { x: number; y: number }[] | null {
  if (!polar || mode === 'reach' || (yKey !== 'bsp' && yKey !== 'twa') || !(x1 > x0)) return null
  const out: { x: number; y: number }[] = []
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps
    const t = polarVMGTarget(polar, x)
    const angle = mode === 'up' ? t.up : t.down
    const y = yKey === 'twa' ? angle : polarInterp(polar, x, angle)
    if (y != null && Number.isFinite(y)) out.push({ x, y })
  }
  return out.length >= 2 ? out : null
}

// ── Speed vs TWA per wind band (the KND "Performance Graphs") ───────────────

export interface TwsBand { centre: number; lo: number; hi: number; phases: PhaseStat[] }

// Phases in TWS bands `width` kn wide, centred on multiples of the width —
// KND's "BSP vs TWA for TWS 20kn" holds 19–21 kn (lower bound inclusive).
// Bands with fewer than `minPhases` phases are dropped.
export function twsBands(phases: PhaseStat[], width = 2, minPhases = 3): TwsBand[] {
  const by = new Map<number, PhaseStat[]>()
  for (const p of phases) {
    const t = p.mean.tws
    if (t == null || !Number.isFinite(t)) continue
    const c = Math.round(t / width) * width
    const b = by.get(c)
    if (b) b.push(p)
    else by.set(c, [p])
  }
  return Array.from(by.entries())
    .filter(([, ps]) => ps.length >= minPhases)
    .sort((a, b) => a[0] - b[0])
    .map(([c, ps]) => ({ centre: c, lo: c - width / 2, hi: c + width / 2, phases: ps }))
}

// The polar's BSP along |TWA| at one wind speed, over the angles every TWS row of
// the polar covers (from 30°). Null outside the polar's TWS range — clamping to its
// last row would draw a curve for a wind speed the polar doesn't describe.
export function polarCurve(polar: any, tws: number, step = 2): { x: number; y: number }[] | null {
  const entries: any[] = polar?.entries || []
  if (entries.length < 2) return null
  const speeds = entries.map(e => e.tws)
  if (!(tws >= Math.min(...speeds) && tws <= Math.max(...speeds))) return null
  const lo = Math.max(30, ...entries.map(e => e.xMin ?? 0))
  const hi = Math.min(180, ...entries.map(e => e.xMax ?? 180))
  const out: { x: number; y: number }[] = []
  for (let a = lo; a <= hi + 1e-9; a += step) {
    const y = polarInterp(polar, tws, a)
    if (y != null && Number.isFinite(y) && y > 0) out.push({ x: a, y })
  }
  return out.length >= 2 ? out : null
}

// ── Axis ticks ──────────────────────────────────────────────────────────────

// Round tick values inside [lo, hi]: steps of 1, 2, 2.5 or 5 × 10ⁿ, about `count`
// intervals across the range (18 · 20 · 22 kn, 50 · 100 · 150°).
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return Number.isFinite(lo) ? [lo] : []
  const raw = (hi - lo) / Math.max(1, count)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw * (1 - 1e-9)) ?? 10 * mag
  const out: number[] = []
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + 1e-9; k++) out.push(Number((k * step).toFixed(10)))
  return out
}

// Decimals that show a tick series exactly: 0.25 steps → 2, 2.5 → 1, 5 → 0.
export function tickDecimals(ticks: number[]): number {
  return ticks.reduce((d, v) => {
    const s = String(v)
    return Math.max(d, s.includes('.') ? s.length - s.indexOf('.') - 1 : 0)
  }, 0)
}

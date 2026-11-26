// Twenty starts, one per year, and what they add up to.
//
// The same LOCAL start time is used every year — "11:00 on the third Saturday of
// October" is not what this does; it is "11:00 on 17 October", because the
// question asked is what the wind does on these dates. The local time is turned
// into UTC per year with the start position's own zone, so a start that is
// inside summer time in one year and outside it in another is still 11:00 on
// the clock at the start line.

import type { RouteResult, PathPoint } from './isochrone'

export interface ElapsedStats {
  n: number; failed: number
  minSec: number; maxSec: number; meanSec: number; medianSec: number; sdSec: number
}

export function elapsedStats(results: RouteResult[]): ElapsedStats {
  const ok = results.filter(r => r.ok && r.elapsedSec != null).map(r => r.elapsedSec as number).sort((a, b) => a - b)
  const n = ok.length
  const mean = n ? ok.reduce((a, b) => a + b, 0) / n : NaN
  // Sample standard deviation: twenty years are a sample of the climate, not all of it.
  const sd = n > 1 ? Math.sqrt(ok.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN
  const median = !n ? NaN : n % 2 ? ok[(n - 1) / 2] : (ok[n / 2 - 1] + ok[n / 2]) / 2
  return { n, failed: results.length - n, minSec: n ? ok[0] : NaN, maxSec: n ? ok[n - 1] : NaN, meanSec: mean, medianSec: median, sdSec: sd }
}

/**
 * Time spent per TWA x TWS bin. TWA is |TWA| in 5 deg bins from 30 to 160, TWS
 * in 2 kn bins from 0 to 30, with an under and an over bin on each axis so no
 * time is silently dropped (a beat at 28 deg or a run at 170 is still time
 * sailed). `hours[r][c]` is the MEAN hours per race in that bin.
 */
export interface TwaTwsTable {
  twaEdges: number[]   // row lower edges; first row is "< 30", last is ">= 160"
  twsEdges: number[]   // column lower edges; last column is ">= 30"
  hours: number[][]
  totalHours: number
}

export function twaTwsTable(paths: PathPoint[][], opts: { twaLo?: number; twaHi?: number; twaStep?: number; twsHi?: number; twsStep?: number } = {}): TwaTwsTable {
  const lo = opts.twaLo ?? 30, hi = opts.twaHi ?? 160, as = opts.twaStep ?? 5
  const th = opts.twsHi ?? 30, ts = opts.twsStep ?? 2
  const twaEdges = [0]; for (let a = lo; a <= hi; a += as) twaEdges.push(a)
  const twsEdges: number[] = []; for (let s = 0; s <= th; s += ts) twsEdges.push(s)
  const hours = twaEdges.map(() => twsEdges.map(() => 0))
  let total = 0
  for (const path of paths) {
    for (let k = 0; k < path.length - 1; k++) {
      const h = (path[k + 1].t - path[k].t) / 3600e3
      if (!(h > 0)) continue
      const a = Math.abs(path[k].twa), s = path[k].tws
      let r = 0
      if (a >= lo - 1e-6) r = Math.min(twaEdges.length - 1, 1 + Math.floor((a - lo) / as + 1e-6))
      // The epsilon keeps a float32 12.0 kn (11.9999995) in the 12-14 kn bin.
      const c = Math.min(twsEdges.length - 1, Math.floor(s / ts + 1e-6))
      hours[r][c] += h
      total += h
    }
  }
  const n = Math.max(1, paths.length)
  return { twaEdges, twsEdges, hours: hours.map(row => row.map(x => x / n)), totalHours: total / n }
}

/** Format a TWA/TWS table as CSV (percent of sailing time, or mean hours). */
export function tableCsv(t: TwaTwsTable, unit: 'pct' | 'hours' = 'pct'): string {
  const lo = t.twaEdges[1], step = t.twaEdges[2] - t.twaEdges[1]
  const twsStep = t.twsEdges[1] - t.twsEdges[0]
  const head = ['TWA\\TWS', ...t.twsEdges.map((s, i) => (i === t.twsEdges.length - 1 ? `>=${s}` : `${s}-${s + twsStep}`))]
  const rows = t.hours.map((row, r) => {
    const label = r === 0 ? `<${lo}` : r === t.twaEdges.length - 1 ? `>=${t.twaEdges[r]}` : `${t.twaEdges[r]}-${t.twaEdges[r] + step}`
    return [label, ...row.map(h => (unit === 'pct' ? (t.totalHours ? (100 * h) / t.totalHours : 0).toFixed(2) : h.toFixed(2)))]
  })
  return [head, ...rows].map(r => r.join(',')).join('\n')
}

/**
 * Local wall time at the start, in a given year, to UTC epoch ms.
 * `offsetMinutesAt(utcMs)` is the zone's offset at an instant; it is asked
 * twice so a start near a DST change resolves to the offset actually in force.
 */
export function localStartToUtc(
  year: number, month: number, day: number, hour: number, minute: number,
  offsetMinutesAt: (utcMs: number) => number,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  const guess = wall - offsetMinutesAt(wall) * 60e3
  return wall - offsetMinutesAt(guess) * 60e3
}

/** Share of sailing time upwind (|TWA| < 70), reaching (70-120), downwind (> 120), and on starboard. */
export function pointOfSail(paths: PathPoint[][]): { upwind: number; reach: number; downwind: number; starboard: number } {
  let up = 0, re = 0, dn = 0, stb = 0, tot = 0
  for (const path of paths) for (let k = 0; k < path.length - 1; k++) {
    const h = (path[k + 1].t - path[k].t) / 3600e3
    if (!(h > 0)) continue
    const a = Math.abs(path[k].twa)
    if (a < 70) up += h; else if (a <= 120) re += h; else dn += h
    if (path[k].twa >= 0) stb += h
    tot += h
  }
  const f = (x: number) => (tot ? x / tot : NaN)
  return { upwind: f(up), reach: f(re), downwind: f(dn), starboard: f(stb) }
}

/**
 * Percentile bootstrap interval for the median and the mean. Twenty years is a
 * small sample of a climate and its tails most of all: the interval says how
 * much of a difference between two studies is the sample, not the weather.
 * Seeded, so a rerun prints the same interval.
 */
export function bootstrap(values: number[], n = 4000, seed = 1): { median: [number, number]; mean: [number, number] } {
  const v = values.filter(Number.isFinite)
  if (v.length < 3) return { median: [NaN, NaN], mean: [NaN, NaN] }
  let s = seed >>> 0
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  const meds: number[] = [], means: number[] = []
  const x = new Array<number>(v.length)
  for (let b = 0; b < n; b++) {
    for (let i = 0; i < v.length; i++) x[i] = v[Math.floor(rnd() * v.length)]
    x.sort((p, q) => p - q)
    const m = v.length
    meds.push(m % 2 ? x[(m - 1) / 2] : (x[m / 2 - 1] + x[m / 2]) / 2)
    means.push(x.reduce((p, q) => p + q, 0) / m)
  }
  const q = (a: number[], p: number) => { a.sort((p1, q1) => p1 - q1); return a[Math.min(a.length - 1, Math.floor(p * a.length))] }
  return { median: [q(meds, 0.05), q(meds, 0.95)], mean: [q(means, 0.05), q(means, 0.95)] }
}

/**
 * The same interval, resampling whole GROUPS (years) rather than values. With
 * several starts a year the routes inside one year share its weather regimes,
 * so they are not independent draws; resampling them one by one treats 320
 * correlated routes as 320 samples and makes the interval far too narrow.
 * Resampling years keeps each year's starts together, which is the honest unit.
 */
export function bootstrapBlocks(groups: number[][], n = 4000, seed = 1): { median: [number, number]; mean: [number, number] } {
  const g = groups.map(x => x.filter(Number.isFinite)).filter(x => x.length)
  if (g.length < 3) return { median: [NaN, NaN], mean: [NaN, NaN] }
  if (g.every(x => x.length === 1)) return bootstrap(g.map(x => x[0]), n, seed)
  let s = seed >>> 0
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  const meds: number[] = [], means: number[] = []
  for (let b = 0; b < n; b++) {
    const x: number[] = []
    for (let i = 0; i < g.length; i++) for (const v of g[Math.floor(rnd() * g.length)]) x.push(v)
    x.sort((p, q) => p - q)
    const m = x.length
    meds.push(m % 2 ? x[(m - 1) / 2] : (x[m / 2 - 1] + x[m / 2]) / 2)
    means.push(x.reduce((p, q) => p + q, 0) / m)
  }
  const q = (a: number[], p: number) => { a.sort((p1, q1) => p1 - q1); return a[Math.min(a.length - 1, Math.floor(p * a.length))] }
  return { median: [q(meds, 0.05), q(meds, 0.95)], mean: [q(means, 0.05), q(means, 0.95)] }
}

/**
 * Fold a TWA x TWS table onto the VMG targets: in each TWS band, time DEEPER than
 * the downwind target angle is moved into the box holding that target, and time
 * TIGHTER than the upwind target into the upwind target's box. A table read as
 * "which angle are we sailing" then never shows time past the targets — on an
 * ocean leg the router runs at and beyond the downwind target for hours, and that
 * time belongs to the target's sail and trim, not to a wider bin of its own.
 * The target is the polar's at the band's centre (the open top band at its edge
 * + 1 kn). `movedShare` is the share of all sailing time that was moved.
 */
export function foldToTargets(
  t: TwaTwsTable,
  vmg: (tws: number) => { upTwa: number; dnTwa: number },
): { table: TwaTwsTable; movedShare: number } {
  const A = t.twaEdges, W = t.twsEdges
  const rowOf = (a: number) => {
    if (a < A[1]) return 0
    let r = 1
    while (r < A.length - 1 && a >= A[r + 1]) r++
    return r
  }
  const hours = t.hours.map(row => row.slice())
  let moved = 0
  for (let c = 0; c < W.length; c++) {
    const tws = c === W.length - 1 ? W[c] + 1 : (W[c] + W[c + 1]) / 2
    const v = vmg(tws)
    if (!(v.upTwa > 0) || !(v.dnTwa > v.upTwa)) continue
    const rUp = rowOf(v.upTwa), rDn = rowOf(v.dnTwa)
    for (let r = 0; r < A.length; r++) {
      const into = r > rDn ? rDn : r < rUp ? rUp : r
      if (into === r || !(hours[r][c] > 0)) continue
      hours[into][c] += hours[r][c]; moved += hours[r][c]; hours[r][c] = 0
    }
  }
  return { table: { ...t, hours }, movedShare: t.totalHours ? moved / t.totalHours : 0 }
}

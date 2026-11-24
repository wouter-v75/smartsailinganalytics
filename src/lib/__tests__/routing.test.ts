import { describe, it, expect } from 'vitest'
import { buildRoutingPolar, parseRoutingPolar } from '../routing/polar'
import { syntheticGrid, liftToHeight, sampleWind } from '../routing/windField'
import { routeIsochrone } from '../routing/isochrone'
import { routeGrid } from '../routing/gridRouter'
import { parseCourseGpx, type Course } from '../routing/course'
import { distNm, destination } from '../routing/geo'
import { elapsedStats, twaTwsTable, localStartToUtc, bootstrap, bootstrapBlocks } from '../routing/climatology'
import type { Env } from '../routing/motion'
import { sunAltitudeDeg, isDark, makePerf } from '../routing/daylight'
import type { LandMask } from '../routing/land'

// A plausible 50-footer: an Expedition-format polar, one TWS row per line.
const TWAS = [40, 45, 52, 60, 75, 90, 110, 120, 135, 150, 165, 180]
const row = (tws: number) => {
  const k = Math.min(1, tws / 14)
  const base = [6.2, 6.8, 7.3, 7.7, 8.1, 8.3, 8.4, 8.2, 7.7, 6.9, 6.0, 5.6]
  return TWAS.map((a, i) => `${a}\t${(base[i] * (0.45 + 0.55 * k) + (tws > 14 ? (tws - 14) * 0.12 * (a > 90 ? 1.5 : 0.6) : 0)).toFixed(2)}`).join('\t')
}
const POLAR_TXT = ['!Expedition polar', ...[4, 6, 8, 10, 12, 14, 16, 20, 25].map(t => `${t}\t${row(t)}`)].join('\n')
const polar = parseRoutingPolar(POLAR_TXT, { tackSec: 60, gybeSec: 45 })

const T0 = Date.UTC(2025, 9, 18, 10, 0)
const box = { latMin: 35, latMax: 39, lonMin: 13, lonMax: 17 }
const env = (twd: number, tws = 12, land: LandMask | null = null): Env =>
  ({ polar, wind: syntheticGrid(box, T0, 120, 0.25, () => ({ tws, twd })), land })

const course = (pts: [number, number][], radiusNm = 0.05): Course => ({
  name: 't',
  marks: pts.map(([lat, lon], i) => ({ name: `m${i}`, lat, lon, radiusNm, kind: i === 0 ? 'start' : i === pts.length - 1 ? 'finish' : 'mark' })),
  rhumbNm: pts.slice(1).reduce((s, p, i) => s + distNm(pts[i][0], pts[i][1], p[0], p[1]), 0),
})

describe('routing polar', () => {
  it('reproduces tabulated points and keeps the no-go edge', () => {
    const v = parseFloat(row(10).split('\t')[2 * 5 + 1])   // 90 deg at 10 kn
    expect(polar.speed(10, 90)).toBeCloseTo(v, 2)
    expect(polar.speed(10, 35)).toBe(0)
    expect(polar.speed(10, 40)).toBeGreaterThan(0)
  })
  it('holds the top row and scales to zero below the bottom one', () => {
    expect(polar.speed(40, 90)).toBeCloseTo(polar.speed(25, 90), 5)
    expect(polar.speed(2, 90)).toBeCloseTo(polar.speed(4, 90) / 2, 2)
  })
  it('finds VMG angles inside the table', () => {
    const v = polar.vmg(12)
    expect(v.upTwa).toBeGreaterThanOrEqual(40); expect(v.upTwa).toBeLessThan(60)
    expect(v.dnTwa).toBeGreaterThan(130)
    expect(v.upVmg).toBeGreaterThan(3)
  })
  it('PCHIP never leaves the range of its neighbours', () => {
    const p = buildRoutingPolar([{ tws: 10, points: [{ twa: 40, bsp: 5 }, { twa: 90, bsp: 8 }, { twa: 100, bsp: 8 }, { twa: 180, bsp: 6 }] }, { tws: 20, points: [{ twa: 40, bsp: 6 }, { twa: 180, bsp: 8 }] }])
    for (let a = 90; a <= 100; a++) expect(p.speed(10, a)).toBeLessThanOrEqual(8.0001)
  })
})

describe('wind field', () => {
  it('interpolates in u/v across north', () => {
    const g = syntheticGrid(box, T0, 2, 0.25, (_la, lon) => ({ tws: 10, twd: lon < 15 ? 350 : 10 }))
    const out = { tws: 0, twd: 0, u: 0, v: 0 }
    sampleWind(g, 37, 14.875, T0, out)
    expect(out.twd > 340 || out.twd < 20).toBe(true)
  })
  it('lifts 10 -> 30 m on the model shear, between the levels', () => {
    const n = 4
    const f = { lat0: 0, dLat: 1, nLat: 2, lon0: 0, dLon: 1, nLon: 2, t0: 0, dtMs: 3600e3, nT: 1,
      u10: new Float32Array(n).fill(5), v10: new Float32Array(n).fill(0),
      u100: new Float32Array(n).fill(7), v100: new Float32Array(n).fill(0) }
    const { grid, stats } = liftToHeight(f, 30, 'power')
    const s30 = grid.u[0] / 1.9438445
    expect(s30).toBeGreaterThan(5); expect(s30).toBeLessThan(7)
    expect(s30).toBeCloseTo(5 * Math.pow(7 / 5, Math.log(3) / Math.log(10)), 4)
    expect(stats.fallbacks).toBe(0)
  })
})

describe('the last isochrone', () => {
  // A beam reach in steady wind: the answer is distance / polar speed, exactly.
  const c = course([[36, 14], [37.5, 14]])           // 90 nm due north
  const e = env(270)                                  // wind from the west: TWA 90
  const exact = (c.rhumbNm - 0.05) / polar.speed(12, 90) * 3600

  it('arrives between isochrones, not on one', () => {
    for (const stepMin of [20, 30, 60]) {
      const r = routeIsochrone(e, c, T0, { stepMin })
      expect(r.ok).toBe(true)
      expect(Math.abs(r.elapsedSec! - exact) / exact).toBeLessThan(0.002)
    }
  })
  it('does not depend on the step (the quantisation is gone)', () => {
    const a = routeIsochrone(e, c, T0, { stepMin: 15 }).elapsedSec!
    const b = routeIsochrone(e, c, T0, { stepMin: 90 }).elapsedSec!
    expect(Math.abs(a - b)).toBeLessThan(60)
  })
  it('the naive rule is late by up to a step, always in the same direction', () => {
    const naive = routeIsochrone(e, c, T0, { stepMin: 60, arrival: 'naive' }).elapsedSec!
    expect(naive).toBeGreaterThan(exact)
    expect(naive - exact).toBeLessThanOrEqual(3600)
    expect(naive % 3600).toBe(0)           // quantised to the isochrones
  })
  it('the grid router agrees on a reach', () => {
    const r = routeGrid(e, c, T0)
    expect(r.ok).toBe(true)
    expect(Math.abs(r.elapsedSec! - exact) / exact).toBeLessThan(0.01)
  })
})

describe('beating', () => {
  const c = course([[36, 15], [37, 15]])             // 60 nm dead upwind
  const e = env(0)
  const vm = polar.vmg(12)
  const ideal = ((c.rhumbNm - 0.05) / vm.upVmg) * 3600   // the VMG bound, no tacks

  it('isochrone time is the VMG bound plus a few tacks', () => {
    const r = routeIsochrone(e, c, T0, { stepMin: 30 })
    expect(r.ok).toBe(true)
    expect(r.elapsedSec!).toBeGreaterThanOrEqual(ideal * 0.999)
    expect(r.elapsedSec!).toBeLessThan(ideal * 1.02 + 4 * polar.tackSec)
    expect(r.tacks).toBeGreaterThanOrEqual(1)
  })
  it('the grid pays for its stencil, but not much at 32 directions', () => {
    const r = routeGrid(e, c, T0, { stencil: 32 })
    expect(r.ok).toBe(true)
    expect(r.elapsedSec!).toBeGreaterThanOrEqual(ideal * 0.999)
    expect(r.elapsedSec!).toBeLessThan(ideal * 1.12)
  })
})

describe('courses and land', () => {
  it('chains marks leg by leg', () => {
    const c = course([[36, 14], [37, 14], [37, 15.25], [36, 15.25]])
    const r = routeIsochrone(env(225), c, T0)
    expect(r.ok).toBe(true)
    expect(r.legSec).toHaveLength(3)
    expect(r.legSec.reduce((a, b) => a + b, 0)).toBeCloseTo(r.elapsedSec!, 0)
  })
  it('goes round an island that sits on the rhumb line', () => {
    const res = 0.02, lat0 = 35, lon0 = 13, nLat = 201, nLon = 201
    const cells = new Uint8Array(nLat * nLon)
    for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) {
      const la = lat0 + i * res, lo = lon0 + j * res
      if (Math.hypot(la - 36.5, (lo - 14) * Math.cos(36.5 * Math.PI / 180)) < 0.12) cells[i * nLon + j] = 1
    }
    const land: LandMask = { lat0, dLat: res, nLat, lon0, dLon: res, nLon, cells }
    const c = course([[36, 14], [37, 14]])
    const free = routeIsochrone(env(270), c, T0).elapsedSec!
    const r = routeIsochrone(env(270, 12, land), c, T0)
    expect(r.ok).toBe(true)
    expect(r.elapsedSec!).toBeGreaterThan(free)
    const g = routeGrid(env(270, 12, land), c, T0)
    expect(g.ok).toBe(true)
    expect(g.elapsedSec!).toBeGreaterThan(free)
  })
  it('parses a GPX route', () => {
    const gpx = `<gpx><rte><name>MSR</name><rtept lat="35.9" lon="14.52"><name>Start</name></rtept><rtept lat="38.8" lon="15.21"><name>Stromboli</name></rtept><rtept lon="14.5" lat="35.91"><name>Finish</name></rtept></rte></gpx>`
    const c = parseCourseGpx(gpx)
    expect(c.marks.map(m => m.name)).toEqual(['Start', 'Stromboli', 'Finish'])
    expect(c.marks[2].lat).toBeCloseTo(35.91)
    expect(c.marks[1].kind).toBe('mark')
  })
  it('names the course after the route, not its first waypoint', () => {
    // Expedition writes the waypoints before the route.
    const gpx = `<gpx><metadata><time>2026-11-24T14:35:37Z</time></metadata><wpt lat="33.6" lon="-118.2"><name>Mark100</name></wpt><wpt lat="21.3" lon="-157.3"><name>Mark101</name></wpt><rte><name>Transpac_study</name><rtept lat="33.6" lon="-118.2"><name>Mark100</name></rtept><rtept lat="21.3" lon="-157.3"><name>Mark101</name></rtept></rte></gpx>`
    expect(parseCourseGpx(gpx).name).toBe('Transpac_study')
    expect(parseCourseGpx(gpx).marks.map(m => m.name)).toEqual(['Mark100', 'Mark101'])
  })
})

describe('climatology', () => {
  it('statistics and a table that accounts for every hour', () => {
    const c = course([[36, 14], [37, 14.5]])
    const rs = [270, 250, 300].map(twd => routeIsochrone(env(twd), c, T0))
    const s = elapsedStats(rs)
    expect(s.n).toBe(3)
    expect(s.minSec).toBeLessThanOrEqual(s.medianSec); expect(s.medianSec).toBeLessThanOrEqual(s.maxSec)
    const t = twaTwsTable(rs.map(r => r.path))
    expect(t.totalHours).toBeCloseTo(s.meanSec / 3600, 1)
    expect(t.hours[0]).toHaveLength(16)                      // 0,2,...,30 kn
    expect(t.hours).toHaveLength(1 + 27)                     // <30, 30..160 by 5
    const col = t.twsEdges.indexOf(12)
    const sum = t.hours.reduce((a, r) => a + r[col], 0)
    expect(sum).toBeCloseTo(t.totalHours, 1)                 // all of it at 12 kn
  })
  it('local start to UTC follows summer time', () => {
    // Malta: CEST (+120) in October before the last Sunday, CET (+60) after.
    const off = (ms: number) => (ms < Date.UTC(2025, 9, 26, 1) ? 120 : 60)
    expect(new Date(localStartToUtc(2025, 10, 18, 11, 0, off)).toISOString()).toBe('2025-10-18T09:00:00.000Z')
    expect(new Date(localStartToUtc(2025, 10, 27, 11, 0, off)).toISOString()).toBe('2025-10-27T10:00:00.000Z')
  })
  it('starts within a year are resampled together, which widens the interval', () => {
    // 20 years x 16 starts; each year's starts sit close to that year's own level.
    const groups = Array.from({ length: 20 }, (_, y) => Array.from({ length: 16 }, (_, k) => 200 + 30 * Math.sin(y * 1.7) + (k % 4)))
    const flat = bootstrap(groups.flat()), blocks = bootstrapBlocks(groups)
    const w = (ci: [number, number]) => ci[1] - ci[0]
    expect(w(blocks.mean)).toBeGreaterThan(2 * w(flat.mean))
    expect(blocks.mean[0]).toBeLessThan(200 + 1); expect(blocks.mean[1]).toBeGreaterThan(200 - 1 - 30)
  })
  it('one start a year reduces to the ordinary bootstrap', () => {
    const v = [5, 9, 7, 12, 3, 8]
    expect(bootstrapBlocks(v.map(x => [x]))).toEqual(bootstrap(v))
  })
  it('a far destination point stays on the sphere', () => {
    const p = destination(36, 14, 45, 100)
    expect(distNm(36, 14, p.lat, p.lon)).toBeCloseTo(100, 3)
  })
})

describe('day and night', () => {
  it('puts the sun where the almanac does', () => {
    // March equinox 2026 (20 Mar 14:46 UTC): local noon on the equator is overhead.
    expect(sunAltitudeDeg(0, 0, Date.UTC(2026, 2, 20, 12, 7))).toBeGreaterThan(89)
    // Long Beach, 10 Jul 2026: sunrise 05:51 PDT (12:51 UTC), sunset 20:08 PDT (03:08 UTC on the 11th).
    const lb = [33.77, -118.19] as const
    expect(isDark(lb[0], lb[1], Date.UTC(2026, 6, 10, 12, 35))).toBe(true)
    expect(isDark(lb[0], lb[1], Date.UTC(2026, 6, 10, 13, 5))).toBe(false)
    expect(isDark(lb[0], lb[1], Date.UTC(2026, 6, 11, 2, 55))).toBe(false)
    expect(isDark(lb[0], lb[1], Date.UTC(2026, 6, 11, 3, 25))).toBe(true)
  })
  it('a constant factor slows a reach by exactly that factor', () => {
    const c = course([[36, 14], [37.5, 14]])
    const raw = routeIsochrone(env(270), c, T0).elapsedSec!
    const slow = routeIsochrone({ ...env(270), perf: () => 0.9 }, c, T0).elapsedSec!
    expect(slow / raw).toBeCloseTo(1 / 0.9, 2)
    const g = routeGrid({ ...env(270), perf: () => 0.9 }, c, T0).elapsedSec!
    expect(Math.abs(g / slow - 1)).toBeLessThan(0.01)
  })
  it('day and night factors land between the two constants', () => {
    const c = course([[36, 14], [37.5, 14]])
    const perf = makePerf({ dayFactor: 0.95, nightFactor: 0.9, darkBelowDeg: -0.833 })!
    const day = routeIsochrone({ ...env(270), perf: () => 0.95 }, c, T0).elapsedSec!
    const night = routeIsochrone({ ...env(270), perf: () => 0.9 }, c, T0).elapsedSec!
    const both = routeIsochrone({ ...env(270), perf }, c, T0).elapsedSec!
    expect(both).toBeGreaterThan(day); expect(both).toBeLessThan(night)
    expect(makePerf({ dayFactor: 1, nightFactor: 1, darkBelowDeg: -0.833 })).toBeUndefined()
  })
})

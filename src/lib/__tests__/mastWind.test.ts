// The interpolation the Mediterranean MOS specs were fitted through.
//
// The load-bearing test is the last one: it drives this module and the app's
// own wind30() with the same single-point ladder and asserts they agree. If
// they ever diverge, a spec fitted here is applied by a different function
// there, and the stored cv_rmse describes a regression nobody runs.

import { describe, expect, it } from 'vitest'
import { toUV, fromUV, fitPowerLaw, interpToMast, bilinearUV } from '../mastWind'
import { wind30 } from '../../components/weather/mos'

const KMH = 1 / 0.539957

describe('toUV / fromUV', () => {
  it('round-trips speed and direction', () => {
    for (const dir of [0, 45, 170, 269, 359]) {
      for (const sp of [1, 7.3, 22]) {
        const { u, v } = toUV(sp, dir)
        const back = fromUV(u, v)
        expect(back.speed).toBeCloseTo(sp, 10)
        expect(back.dir).toBeCloseTo(dir, 8)
      }
    }
  })

  it('puts a northerly flowing south', () => {
    // Wind FROM 0 degrees blows towards the south: v negative, u ~ 0.
    const { u, v } = toUV(10, 0)
    expect(u).toBeCloseTo(0, 10)
    expect(v).toBeCloseTo(-10, 10)
  })
})

describe('fitPowerLaw', () => {
  it('recovers the exponent of a clean power law', () => {
    const hs = [10, 20, 50, 80]
    const alpha = 0.14
    const sp = hs.map((h) => 9 * (h / 10) ** alpha)
    const f = fitPowerLaw(hs, sp)!
    expect(f.alpha).toBeCloseTo(alpha, 8)
    expect(Math.exp(f.alpha * Math.log(10) + f.lnIntercept)).toBeCloseTo(9, 8)
  })

  it('refuses a single level rather than inventing a shear', () => {
    expect(fitPowerLaw([10], [9])).toBeNull()
    expect(fitPowerLaw([10, 20], [0, 0])).toBeNull()
  })
})

describe('interpToMast', () => {
  const ladder = (alpha: number, dirs: Record<number, number> = {}) => {
    const m = new Map<number, { speed: number; dir: number }>()
    for (const h of [10, 20, 50, 80]) m.set(h, { speed: 9 * (h / 10) ** alpha, dir: dirs[h] ?? 300 })
    return m
  }

  it('lifts along the model\'s OWN shear when it publishes one', () => {
    const r = interpToMast(ladder(0.14), 30)!
    expect(r.alpha).toBeCloseTo(0.14, 8)
    expect(r.speed).toBeCloseTo(9 * 3 ** 0.14, 8)
    expect(r.nLevels).toBe(4)
  })

  it('falls back to the marine log law on one level, and SAYS it is one', () => {
    const one = new Map([[10, { speed: 9, dir: 300 }]])
    const r = interpToMast(one, 30)!
    expect(r.nLevels).toBe(1)
    // Solved, not assumed: about 1.088 at 9 kn, an equivalent alpha near 0.077.
    expect(r.speed / 9).toBeGreaterThan(1.05)
    expect(r.speed / 9).toBeLessThan(1.11)
    expect(r.alpha).toBeLessThan(0.11)
  })

  it('can still reproduce the 0.11 power law the old pipeline assumed', () => {
    // 3.6 % more wind than the log law at 9 kn, which is why the mode is
    // explicit: a fit and the app must lift a single-level model the same way.
    const one = new Map([[10, { speed: 9, dir: 300 }]])
    const log = interpToMast(one, 30)!
    const pow = interpToMast(one, 30, { mode: 'alpha' })!
    expect(pow.alpha).toBe(0.11)
    expect(pow.speed).toBeCloseTo(9 * 3 ** 0.11, 8)
    expect(pow.speed / log.speed).toBeGreaterThan(1.02)
    expect(pow.speed / log.speed).toBeLessThan(1.06)
  })

  it('backs the direction between the bracketing levels, through u/v', () => {
    // 10 m at 350, 20 m at 10: a mast at 15 m must come out near 0, not 180.
    const m = new Map([
      [10, { speed: 10, dir: 350 }],
      [20, { speed: 10, dir: 10 }],
    ])
    const r = interpToMast(m, 15)!
    expect(Math.min(r.dir, 360 - r.dir)).toBeLessThan(1)
  })

  it('clamps the direction at the ends of the ladder', () => {
    const m = ladder(0.12, { 10: 300, 20: 295, 50: 290, 80: 285 })
    expect(interpToMast(m, 5)!.dir).toBeCloseTo(300, 6)
    expect(interpToMast(m, 200)!.dir).toBeCloseTo(285, 6)
  })

  it('returns null when there is nothing to work with', () => {
    expect(interpToMast(new Map(), 30)).toBeNull()
    expect(interpToMast(new Map([[10, { speed: 0, dir: 300 }]]), 30)).toBeNull()
    expect(interpToMast(ladder(0.12), 0)).toBeNull()
  })

  it('lowers the evaluation height for heel, which is why z is a parameter', () => {
    // A 30 m mast at 26 degrees of heel puts the masthead at 27 m, and the
    // original fit evaluated the model there rather than at 30.
    const m = ladder(0.14)
    const up = interpToMast(m, 30)!.speed
    const heeled = interpToMast(m, 30 * Math.cos((26 * Math.PI) / 180))!.speed
    expect(heeled).toBeLessThan(up)
    expect(heeled / up).toBeCloseTo((Math.cos((26 * Math.PI) / 180)) ** 0.14, 8)
  })
})

describe('bilinearUV', () => {
  const grid = [
    { lat: 41.0, lon: 9.4, speed: 10, dir: 300 },
    { lat: 41.0, lon: 9.6, speed: 20, dir: 300 },
    { lat: 41.2, lon: 9.4, speed: 10, dir: 300 },
    { lat: 41.2, lon: 9.6, speed: 20, dir: 300 },
  ]

  it('returns a corner exactly at that corner', () => {
    const r = fromUV(...Object.values(bilinearUV(grid, 41.0, 9.4)!) as [number, number])
    expect(r.speed).toBeCloseTo(10, 8)
  })

  it('splits the difference in the middle', () => {
    const uv = bilinearUV(grid, 41.1, 9.5)!
    expect(fromUV(uv.u, uv.v).speed).toBeCloseTo(15, 8)
  })

  it('clamps outside the lattice instead of extrapolating', () => {
    const uv = bilinearUV(grid, 40.0, 9.0)!
    expect(fromUV(uv.u, uv.v).speed).toBeCloseTo(10, 8)
  })

  it('interpolates ACROSS NORTH correctly, which a mean of degrees cannot', () => {
    const wrap = [
      { lat: 41.0, lon: 9.4, speed: 10, dir: 350 },
      { lat: 41.0, lon: 9.6, speed: 10, dir: 10 },
      { lat: 41.2, lon: 9.4, speed: 10, dir: 350 },
      { lat: 41.2, lon: 9.6, speed: 10, dir: 10 },
    ]
    const uv = bilinearUV(wrap, 41.1, 9.5)!
    const d = fromUV(uv.u, uv.v).dir
    expect(Math.min(d, 360 - d)).toBeLessThan(1)   // ~0, not ~180
  })

  it('falls back to the nearest point when a corner is missing', () => {
    // At the edge of a model's domain some of a venue's nine points come back
    // empty. The original fit used the nearest point rather than dropping the
    // row, which would quietly shrink a regatta.
    const holey = [grid[0], grid[1], grid[2]]
    const uv = bilinearUV(holey, 41.199, 9.599)!
    expect(fromUV(uv.u, uv.v).speed).toBeCloseTo(20, 8)   // nearest is 41.0,9.6
  })

  it('returns null when every point is unusable', () => {
    expect(bilinearUV([], 41, 9.5)).toBeNull()
    expect(bilinearUV([{ lat: 41, lon: 9.4, speed: NaN, dir: NaN }], 41, 9.5)).toBeNull()
  })
})

describe('interpToMast IS the app\'s wind30', () => {
  it('agrees with it on the same ladder, at 30 m', () => {
    // wind30 takes an Open-Meteo payload in km/h and returns knots; this takes
    // a level map in knots. Same maths, two call shapes, and a test is the only
    // thing that keeps them the same maths.
    const heights = [10, 80, 120, 180]
    for (const alpha of [0.08, 0.14, 0.22]) {
      const speedsKn = heights.map((h) => 9 * (h / 10) ** alpha)
      const hourly: Record<string, unknown> = { time: ['2026-09-05T11:00'] }
      heights.forEach((h, i) => {
        hourly[`wind_speed_${h}m`] = [speedsKn[i] * KMH]
        hourly[`wind_direction_${h}m`] = [300 - i * 4]
      })
      const theirs = wind30(hourly, heights, 0, 30, 0.11, null)
      const levels = new Map(heights.map((h, i) => [h, { speed: speedsKn[i], dir: 300 - i * 4 }]))
      const mine = interpToMast(levels, 30)!
      expect(mine.speed).toBeCloseTo(theirs.ws30, 8)
      expect(mine.dir).toBeCloseTo(theirs.twd, 6)
    }
  })

  it('agrees on a single-level model too, where both guess 0.11', () => {
    const hourly = { time: ['2026-09-05T11:00'], wind_speed_10m: [9 * KMH], wind_direction_10m: [300] }
    const theirs = wind30(hourly as Record<string, unknown>, [10], 0, 30, 0.11, null)
    const mine = interpToMast(new Map([[10, { speed: 9, dir: 300 }]]), 30)!
    expect(mine.speed).toBeCloseTo(theirs.ws30, 8)   // the log law, both sides
    expect(mine.dir).toBeCloseTo(theirs.twd, 6)
  })
})

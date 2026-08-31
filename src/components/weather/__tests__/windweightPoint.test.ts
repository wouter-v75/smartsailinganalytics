import { describe, it, expect } from 'vitest'
import { pointWindweightByHour, asBoxHour, modelKeyForDomain } from '../windweightPoint'

const KMH = 1 / 0.539957            // kn -> km/h, the unit the payload carries

// Porto Cervo, point 1, 2026-08-31 11:00Z = 13:00 local (UTC+2). Real grid values.
const COORDS = { latitude: 41.13, longitude: 9.54 }   // inside the MOS venue radius
const windData = {
  '1': {
    surfaceByModel: {
      ICONRACE_1KM: {
        hourly: {
          time: ['2026-08-31T11:00:00Z'],
          wind_speed_10m: [9.6 * KMH], wind_speed_20m: [11.4 * KMH],
          wind_speed_30m: [12.8 * KMH], wind_speed_50m: [14.1 * KMH],
          wind_direction_10m: [309], wind_direction_20m: [306],
          wind_direction_30m: [304], wind_direction_50m: [300],
        },
      },
    },
  },
}
// UTC+2, injected the way each caller injects its own tz helpers
const localHour = (ms: number) => new Date(ms + 2 * 3600e3).getUTCHours()
const localDate = (ms: number) => new Date(ms + 2 * 3600e3).toISOString().slice(0, 10)
const base = { windData, locKey: '1', coords: COORDS, domain: 'porto_cervo_1km', mastHeight: 34, localHour, localDate, todayLocal: '2026-08-31' }

describe('modelKeyForDomain', () => {
  it('maps the published domain to the SSA-Race resolution it came from', () => {
    expect(modelKeyForDomain('porto_cervo_1km')).toBe('ICONRACE_1KM')
    expect(modelKeyForDomain('porto_cervo_2km')).toBe('ICONRACE')
    expect(modelKeyForDomain(undefined)).toBe('ICONRACE')
  })
})

describe('pointWindweightByHour', () => {
  it('keys rows by LOCAL hour — 11:00Z lands on 13:00 at Porto Cervo', () => {
    const out = pointWindweightByHour(base)
    expect(Object.keys(out)).toEqual(['13'])
  })

  it('anchors V_H at point 1, far above the box average that produced 9.3 kn', () => {
    const r = pointWindweightByHour(base)[13]
    expect(r.vHKt).toBeGreaterThan(14)     // ~13.1 raw, ~15.6 after MOS
    expect(r.mosOn).toBe(true)
  })

  it('applies the Porto Cervo icon_eu correction to the anchor only', () => {
    const withMos = pointWindweightByHour(base)[13]
    // same column outside any MOS venue -> no correction, lower anchor
    const noMos = pointWindweightByHour({ ...base, coords: { latitude: 55.0, longitude: 3.0 } })[13]
    expect(noMos.mosOn).toBe(false)
    expect(withMos.vHKt).toBeGreaterThan(noMos.vHKt)
    // MOS rescales the whole column, so the SHAPE index is untouched
    expect(withMos.ww).toBeCloseTo(noMos.ww, 6)
    expect(withMos.fProfile).toBeCloseTo(noMos.fProfile, 6)
  })

  it('reports the rig-band shear as backing today, and keeps it out of the weight', () => {
    const r = pointWindweightByHour(base)[13]
    expect(r.shearDeg).toBeLessThan(0)          // 309 -> ~303 at 34 m
    expect(r.shearDeg).toBeGreaterThan(-12)
    // shear is reported, never folded in: WW is unchanged if only direction changes
    const veered = JSON.parse(JSON.stringify(windData))
    const h = veered['1'].surfaceByModel.ICONRACE_1KM.hourly
    h.wind_direction_20m = [312]; h.wind_direction_30m = [318]; h.wind_direction_50m = [325]
    const r2 = pointWindweightByHour({ ...base, windData: veered })[13]
    expect(r2.shearDeg).toBeGreaterThan(0)      // now veering
    expect(r2.ww).toBeCloseTo(r.ww, 6)          // ... and the weight did not move
  })

  it('passes the published density / gust / funnel factors through', () => {
    const plain = pointWindweightByHour(base)[13]
    const withF = pointWindweightByHour({
      ...base,
      boxByHour: { 13: { factors: { rho: 0.974, gust: 1.032, funnel: 1 } } },
    })[13]
    expect(withF.ww).toBeCloseTo(plain.ww * 0.974 * 1.032, 4)
    expect(withF.hasBoxFactors).toBe(true)
  })

  it('holds V_eff = V_H x sqrt(WW/100)', () => {
    const r = pointWindweightByHour(base)[13]
    expect(r.vEffKt).toBeCloseTo(r.vHKt * Math.sqrt(r.ww / 100), 3)
  })

  it('returns nothing rather than guessing when inputs are missing', () => {
    expect(pointWindweightByHour({ ...base, windData: {} })).toEqual({})
    expect(pointWindweightByHour({ ...base, coords: null })).toEqual({})
    expect(pointWindweightByHour({ ...base, todayLocal: '2026-09-09' })).toEqual({})
  })
})

describe('asBoxHour', () => {
  it('shapes a point row like a published windweight hour so renderers need no change', () => {
    const pt = pointWindweightByHour(base)[13]
    const boxHour = { t: '2026-08-31T11:00:00Z', WW: 79.5, V_eff: 8.3, V_H: 9.3, cls: 'Light', factors: { rho: 0.974 } }
    const merged = asBoxHour(pt, boxHour)!
    expect(merged.t).toBe(boxHour.t)                   // published fields survive
    expect(merged.factors).toEqual(boxHour.factors)
    expect(merged.V_H).toBeGreaterThan(14)             // ... but the numbers are the point-1 ones
    expect(merged.V_eff).not.toBeCloseTo(8.3, 1)
    expect(merged.shearDeg).toBe(pt.shearDeg)
    expect(Array.isArray(merged.profile)).toBe(true)
  })

  it('falls back to the published hour when there is no point row', () => {
    const boxHour = { WW: 79.5, V_eff: 8.3, cls: 'Light' }
    expect(asBoxHour(null, boxHour)).toBe(boxHour)
    expect(asBoxHour(null, null)).toBeNull()
  })
})

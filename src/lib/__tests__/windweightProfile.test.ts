import { describe, it, expect } from 'vitest'
import { windweightFromProfile, profileReader } from '../windweight'

const KN = 1.94384
// Point 1, Porto Cervo, 2026-08-31 11:00Z (13:00 local) straight off the venue grid.
// kn -> m/s. This is the hour that read V_H 9.3 / V_eff 8.3 from the box average.
const PC_HEIGHTS = [10, 30, 50]
const PC_SPEEDS = [9.6, 12.8, 14.1].map((k) => k / KN)

describe('profileReader', () => {
  it('returns the published value at a published height', () => {
    const v = profileReader(PC_HEIGHTS, PC_SPEEDS)!
    expect(v(10) * KN).toBeCloseTo(9.6, 4)
    expect(v(30) * KN).toBeCloseTo(12.8, 4)
    expect(v(50) * KN).toBeCloseTo(14.1, 4)
  })

  it('interpolates in log-height between levels, not linearly in z', () => {
    const v = profileReader(PC_HEIGHTS, PC_SPEEDS)!
    const atMast = v(34) * KN
    expect(atMast).toBeGreaterThan(12.8)
    expect(atMast).toBeLessThan(14.1)
    // 34 m is 24.5% of the way from 30->50 in log-height but only 20% linearly,
    // so the log reading sits ABOVE the linear one.
    const linear = 12.8 + (34 - 30) / (50 - 30) * (14.1 - 12.8)   // 13.06
    expect(atMast).toBeGreaterThan(linear)
    expect(atMast).toBeCloseTo(13.119, 2)
  })

  it('fills below the lowest level with a log law, monotonic and never negative', () => {
    const v = profileReader(PC_HEIGHTS, PC_SPEEDS)!
    let prev = -1
    for (const z of [0.5, 1, 2, 5, 8, 10]) {
      const s = v(z)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
    expect(v(10) * KN).toBeCloseTo(9.6, 4)
  })

  it('clamps above the top level rather than extrapolating', () => {
    const v = profileReader(PC_HEIGHTS, PC_SPEEDS)!
    expect(v(500) * KN).toBeCloseTo(14.1, 4)
  })

  it('survives a degenerate column (no shear, single level, empty)', () => {
    const flat = profileReader([10, 30], [5, 5])!
    expect(flat(20)).toBeCloseTo(5, 6)
    expect(profileReader([10], [7])!(34)).toBeCloseTo(7, 6)
    expect(profileReader([], [])).toBeNull()
  })
})

describe('windweightFromProfile', () => {
  const base = { heightsM: PC_HEIGHTS, speedsMs: PC_SPEEDS, H: 34 }

  it('anchors V_H at masthead height from the point-1 column', () => {
    const r = windweightFromProfile(base)!
    // the box average said 9.3 kn at 34 m; point 1 is ~13
    expect(r.vHKt).toBeGreaterThan(12.5)
    expect(r.vHKt).toBeLessThan(13.5)
  })

  it('reports a sheared column as below a standard day', () => {
    const r = windweightFromProfile(base)!
    expect(r.fProfile).toBeLessThan(1)
    expect(r.ww).toBeLessThan(100)
  })

  it('holds V_eff = V_H x sqrt(WW/100) exactly', () => {
    const r = windweightFromProfile(base)!
    expect(r.vEffKt).toBeCloseTo(r.vHKt * Math.sqrt(r.ww / 100), 3)
  })

  it('MOS moves V_H and V_eff but NOT WW — a uniform rescale cannot change the shape', () => {
    const raw = windweightFromProfile(base)!
    const mos = windweightFromProfile({ ...base, vHKtOverride: raw.vHKt * 1.19 })!
    expect(mos.ww).toBeCloseTo(raw.ww, 6)
    expect(mos.fProfile).toBeCloseTo(raw.fProfile, 6)
    expect(mos.vHKt).toBeCloseTo(raw.vHKt * 1.19, 4)
    expect(mos.vEffKt).toBeCloseTo(raw.vEffKt * 1.19, 3)
  })

  it('is scale-invariant in WW: doubling every level leaves the index alone', () => {
    const a = windweightFromProfile(base)!
    const b = windweightFromProfile({ ...base, speedsMs: PC_SPEEDS.map((v) => v * 2) })!
    expect(b.ww).toBeCloseTo(a.ww, 6)
    expect(b.vHKt).toBeCloseTo(a.vHKt * 2, 3)
  })

  it('a perfectly logarithmic column scores ~100 against the standard day', () => {
    const z0 = 2e-4
    const H = 34
    const hs = [1, 5, 10, 20, 30]
    const ss = hs.map((z) => 10 * Math.log(z / z0) / Math.log(H / z0))
    const r = windweightFromProfile({ heightsM: hs, speedsMs: ss, H })!
    expect(r.fProfile).toBeGreaterThan(0.97)
    expect(r.fProfile).toBeLessThan(1.03)
  })

  it('a low-shear (unstable) column scores heavier than a strongly sheared one', () => {
    const hs = [10, 30, 50]
    const flat = windweightFromProfile({ heightsM: hs, speedsMs: [11.5, 12.0, 12.2], H: 34 })!
    const sheared = windweightFromProfile({ heightsM: hs, speedsMs: [7.0, 12.0, 14.0], H: 34 })!
    expect(flat.fProfile).toBeGreaterThan(sheared.fProfile)
  })

  it('passes density / gust / funnel through multiplicatively', () => {
    const plain = windweightFromProfile(base)!
    const withF = windweightFromProfile({ ...base, fRho: 0.974, fGust: 1.032, fFunnel: 1 })!
    expect(withF.ww).toBeCloseTo(plain.ww * 0.974 * 1.032, 4)
  })

  it('classifies on the corrected numbers and refuses a dead column', () => {
    const z0 = 2e-4, H = 34
    const hs = [1, 5, 10, 20, 30]
    const logCol = hs.map((z) => 10 * Math.log(z / z0) / Math.log(H / z0))
    expect(windweightFromProfile({ heightsM: hs, speedsMs: logCol, H })!.cls).toBe('Standard')
    expect(windweightFromProfile({ heightsM: hs, speedsMs: logCol, H, fGust: 1.15 })!.cls).toBe('Heavy')
    expect(windweightFromProfile(base)!.cls).toBe('Light')   // today's sheared column
    expect(windweightFromProfile({ heightsM: [10, 30], speedsMs: [0, 0], H: 34 })).toBeNull()
  })
})

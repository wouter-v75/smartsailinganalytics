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

  // The sub-lowest-level fill is a log law whose slope and z0 are a matched pair.
  // Clamping z0 into its sane band without re-deriving the slope left a STEP at the
  // lowest level: a well-mixed column (v10 4.0, v20 4.05 — the ordinary sea-breeze
  // case) read ~1 m/s through the bottom 10 m of the rig against 4 m/s above it.
  // That fed shearIntegral, so WW% was wrong too, not just the deck's profile chart.
  it('the sub-lowest-level fill meets the lowest published level, at any shear', () => {
    const hs = [10, 20, 30, 50]
    const cases: Array<[string, number[]]> = [
      ['well mixed',        [4.0, 4.05, 4.08, 4.12]],
      ['mild shear',        [4.0, 4.4, 4.65, 4.95]],
      ['strong shear',      [4.0, 8.0, 9.0, 9.8]],
      ['light + big shear', [1.0, 4.5, 5.2, 5.8]],
      ['inverted',          [5.0, 4.0, 3.6, 3.3]],
      ['calm at 10 m',      [0.0, 4.0, 4.5, 5.0]],
    ]
    for (const [label, ss] of cases) {
      const v = profileReader(hs, ss)!
      expect(`${label}: ${v(10).toFixed(3)}`).toBe(`${label}: ${ss[0].toFixed(3)}`)
      // and it approaches that level from below, never crossing it
      expect(v(9.5)).toBeLessThanOrEqual(ss[0] + 1e-9)
    }
  })

  it('a well-mixed column loads the rig MORE than the standard log day', () => {
    // Uniform wind puts more air on the bottom of the rig than a log profile does,
    // so the index belongs above 100. Pre-fix this read 64%.
    const r = windweightFromProfile({ heightsM: [10, 20, 30, 50], speedsMs: [4.0, 4.05, 4.08, 4.12], H: 34 })!
    expect(r.ww).toBeGreaterThan(100)
    expect(r.vEffKt).toBeGreaterThan(r.vHKt)
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

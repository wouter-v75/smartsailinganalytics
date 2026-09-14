import { describe, it, expect } from 'vitest'
import { valueAt, startAnalyses, START_FROM_S, START_TO_S, START_STEP_S } from '../startAnalysis'

const GUN = Date.UTC(2026, 8, 11, 10, 18, 0)

describe('valueAt', () => {
  const rows = [
    { utc: 0, bsp: 10, twa: 170, twd: 350, dstLine: 4 },
    { utc: 6000, bsp: 16, twa: -170, twd: 10, dstLine: 0 },
    { utc: 12000, bsp: 12, twa: -160, twd: 20, dstLine: 2 },
    { utc: 40000, bsp: 20, twa: -150, twd: 30, dstLine: 1 },   // 28 s gap before this row
  ]
  it('interpolates between rows', () => {
    expect(valueAt(rows, 3000, 'bsp')).toBe(13)
    expect(valueAt(rows, 9000, 'twa', 'twa')).toBe(-165)
  })
  it('wraps TWD through north and never averages a TWA through a gybe', () => {
    expect(valueAt(rows, 3000, 'twd', 'deg360')).toBeCloseTo(0)
    expect(valueAt(rows, 2000, 'twa', 'twa')).toBe(170)
    expect(valueAt(rows, 4000, 'twa', 'twa')).toBe(-170)
  })
  it('looks past a zero distance to line (no line) to the values either side, and gives nothing across a long gap or outside the log', () => {
    // The 0 at 6 s is dropped, so 5 s and 7 s interpolate between 4 at 0 s and 2 at 12 s.
    expect(valueAt(rows, 5000, 'dstLine', 'lin', true)).toBeCloseTo(4 - (2 * 5) / 12)
    expect(valueAt(rows, 7000, 'dstLine', 'lin', true)).toBeCloseTo(4 - (2 * 7) / 12)
    expect(valueAt(rows, 20000, 'bsp')).toBeNull()
    expect(valueAt(rows, 50000, 'bsp')).toBeNull()
  })

  it('uses a lone value on one side only when it is within 3 s', () => {
    const sparse = [{ utc: 0, dstLine: 0 }, { utc: 6000, dstLine: 3 }, { utc: 12000, dstLine: 0 }]
    expect(valueAt(sparse, 4000, 'dstLine', 'lin', true)).toBe(3)       // 2 s from the only value
    expect(valueAt(sparse, 1000, 'dstLine', 'lin', true)).toBeNull()    // 5 s away: too far to stand in
  })
})

describe('startAnalyses', () => {
  // A 1 Hz run-in: reaching away on port, a tack at −100 s, then close-hauled on stbd to the line.
  const rows = Array.from({ length: 421 }, (_, i) => {
    const t = i - 330
    const stbd = t >= -100
    return {
      utc: GUN + t * 1000,
      bsp: stbd ? 11 : 16, vsTargPct: stbd ? 95 : 87.5, tws: 20, twd: 280, twaTarg: stbd ? 35 : 148,
      twa: stbd ? 40 : -120, vmg: stbd ? 8.4 : -8,
      ruddP: 3, ruddS: -6,
      dstLine: t < 0 ? -t / 20 : 0, tmLine: t < 0 ? 10 : null,
      // along a line running north from the pin; wind from the west (280°), so the course side is west
      lat: 41.15 + (t < 0 ? 0.0002 : 0.0003), lon: 9.64 + 0.002 * Math.max(0, -t) / 300,
    }
  })
  const xml = {
    raceGuns: [{ utc: GUN, raceNum: 5 }],
    tackJibes: [{ utc: GUN - 100_000, isTack: true }],
    sailsUpEvents: [{ utc: GUN - 3_600_000, sails: ['MAIN_B 2026', 'J4_A 2026'] }],
    startLines: [{ raceNum: 5, pin: { lat: 41.15, lon: 9.64 }, boat: { lat: 41.155, lon: 9.64 } }],
  }
  const polar = { entries: [{ tws: 10, upTwa: 40, downTwa: 150, upVMG: 8, downVMG: 16 }, { tws: 30, upTwa: 40, downTwa: 150, upVMG: 8, downVMG: 16 }] }
  const [s] = startAnalyses(rows, xml, polar)

  it('samples the run-in every 5 s from −5:00 to +1:00, with the gun and the tack as events', () => {
    expect(s.samples).toHaveLength((START_TO_S - START_FROM_S) / START_STEP_S + 1)
    expect(s.samples.find(x => x.t === 0)!.event).toBe('gun')
    expect(s.samples.find(x => x.t === -100)!.event).toBe('tack')
    expect(s.raceNum).toBe(5)
    expect(s.sails).toBe('J4_A 2026')
    expect(s.rowSpacingS).toBe(1)
  })

  it('computes the KND columns: ΔTwaTrg, VMG% against the polar, tack-relative rudder, burn', () => {
    const early = s.samples.find(x => x.t === -300)!
    expect(early).toMatchObject({ bsp: 16, bspTrgPct: 87.5, twa: -120, dTwaTrg: -28, rudder: 6, burn: 10, distLn: 15 })
    expect(early.vmgPct).toBeCloseTo(50)            // 8 of the 16 kn downwind VMG
    const late = s.samples.find(x => x.t === -60)!
    expect(late).toMatchObject({ twa: 40, dTwaTrg: 5, rudder: 3 })
    expect(late.vmgPct).toBeCloseTo(105)            // 8.4 of 8 kn upwind
    // Expedition writes 0 once past the line: the reading 1 s before the gun stands in at the gun
    // (within 3 s), but 10 s later the last real reading is 11 s old, so there is no value.
    expect(s.atGun!.distLn).toBeCloseTo(0.05)
    expect(s.samples.find(x => x.t === 10)!.distLn).toBeNull()
    expect(s.twsAtGun).toBe(20)
    expect(s.twdAtGun).toBeCloseTo(280)
  })

  it('places the track against the start line, course side up', () => {
    expect(s.line!.lengthM).toBeCloseTo(553, -1)
    expect(s.line!.gunAlongPct).toBeCloseTo(6, 0)    // 0.0003° north of the pin on a 0.005° line
    const atGun = s.track!.find(p => p.t === 0)!
    expect(atGun.over).toBeCloseTo(0, 0)
    const early = s.track!.find(p => p.t === -300)!
    expect(early.over).toBeLessThan(-150)             // east of the line: the pre-start side
  })

  it('explains when there is no track: rounded cloud positions, or no start line', () => {
    const roundedRows = rows.map(r => ({ ...r, lat: 41.15, lon: 9.64 }))
    expect(startAnalyses(roundedRows, xml, polar)[0].trackNote).toMatch(/rounded to about 1 km/)
    expect(startAnalyses(rows, { ...xml, startLines: [] }, polar)[0].trackNote).toMatch(/No start line/)
    expect(startAnalyses([], xml, polar)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { gradedPick, requiredSepNm, minSepNm, nmBetween, GRADED_DEFAULTS } from '../obsDensity'
import {
  seaProbePoints, seaNmFromElevations, seaProbeCost, SEA_PROBE_DEFAULTS,
} from '../coastSeaDistance'

const LA = 43.266897
const LO = 6.698371
const east = (nm: number) => ({ lat: LA, lon: LO + nm / (60 * Math.cos((LA * Math.PI) / 180)) })

describe('requiredSepNm', () => {
  it('is the plain spacing when no bias is asked for', () => {
    expect(requiredSepNm(30, 20)).toBe(minSepNm(30))
    expect(requiredSepNm(30, 20, { coastBias: 0 })).toBe(minSepNm(30))
  })

  it('widens the spacing for an inland station', () => {
    const coastal = requiredSepNm(30, 0, { coastBias: 1.5 })
    const inland = requiredSepNm(30, 20, { coastBias: 1.5 })
    expect(coastal).toBeCloseTo(minSepNm(30), 6)
    expect(inland).toBeCloseTo(minSepNm(30) * 2.5, 6)
  })

  it('saturates at coastScaleNm rather than growing without bound', () => {
    const at10 = requiredSepNm(30, 10, { coastBias: 1.5 })
    const at100 = requiredSepNm(30, 100, { coastBias: 1.5 })
    expect(at100).toBeCloseTo(at10, 6)
  })

  it('does NOT penalise a station whose distance from the sea is unknown', () => {
    // A missing measurement must not quietly drop a station that might be on
    // the quay. Null is "we did not look", not "miles inland".
    expect(requiredSepNm(30, null, { coastBias: 1.5 })).toBe(minSepNm(30))
    expect(requiredSepNm(30, undefined, { coastBias: 1.5 })).toBe(minSepNm(30))
    expect(requiredSepNm(30, NaN, { coastBias: 1.5 })).toBe(minSepNm(30))
  })

  it('leaves the inner circle alone, however far inland', () => {
    // Zero times any bias is still zero. Cap Camarat is 107 m up on a headland
    // and is the most useful station at St Tropez.
    expect(requiredSepNm(3, 50, { coastBias: 3 })).toBe(0)
    expect(requiredSepNm(GRADED_DEFAULTS.innerNm, 50, { coastBias: 3 })).toBe(0)
  })
})

describe('gradedPick with a coast bias', () => {
  // Two clusters at the same range, one on the water and one inland.
  const cluster = (atNm: number, n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => ({
      ...east(atNm),
      lat: LA + i * 0.004,
      tag,
    }))

  it('keeps more of the coastal cluster than the inland one at the same range', () => {
    const items = [...cluster(30, 8, 'coast'), ...cluster(30, 8, 'inland')]
    const seaNmOf = (s: { tag: string }) => (s.tag === 'coast' ? 0.5 : 20)
    const kept = gradedPick(items, LA, LO, { coastBias: 1.5 }, seaNmOf)
    const coast = kept.filter((s) => s.tag === 'coast').length
    const inland = kept.filter((s) => s.tag === 'inland').length
    expect(coast).toBeGreaterThan(inland)
  })

  it('changes nothing when the bias is off', () => {
    const items = [...cluster(30, 8, 'coast'), ...cluster(30, 8, 'inland')]
    const seaNmOf = (s: { tag: string }) => (s.tag === 'coast' ? 0.5 : 20)
    const biased = gradedPick(items, LA, LO, {}, seaNmOf).length
    const plain = gradedPick(items, LA, LO).length
    expect(biased).toBe(plain)
  })

  it('still keeps everything inside the inner circle', () => {
    const inside = Array.from({ length: 6 }, (_, i) => ({ lat: LA + i * 0.002, lon: LO, tag: 'inland' }))
    const kept = gradedPick(inside, LA, LO, { coastBias: 3 }, () => 40)
    expect(kept).toHaveLength(6)
  })

  it('never keeps MORE than the unbiased pick', () => {
    // The bias only ever widens a spacing requirement, so it can only remove.
    const grid: Array<{ lat: number; lon: number }> = []
    for (let dy = -0.6; dy <= 0.6; dy += 0.03) for (let dx = -0.8; dx <= 0.8; dx += 0.03) grid.push({ lat: LA + dy, lon: LO + dx })
    const seaNmOf = (s: { lat: number; lon: number }) => (s.lon < LO ? 25 : 0)
    const biased = gradedPick(grid, LA, LO, { coastBias: 1.5 }, seaNmOf).length
    const plain = gradedPick(grid, LA, LO).length
    expect(biased).toBeLessThanOrEqual(plain)
    expect(biased).toBeLessThan(plain)
  })
})

describe('seaProbePoints', () => {
  it('samples every bearing at every radius, radius-major', () => {
    const pts = seaProbePoints(LA, LO)
    const { radiiNm, bearings } = SEA_PROBE_DEFAULTS
    expect(pts).toHaveLength(radiiNm.length * bearings)
    // The first point of each ring is due north at that radius.
    for (let i = 0; i < radiiNm.length; i++) {
      const [plat, plon] = pts[i * bearings]
      expect(nmBetween(LA, LO, plat, plon)).toBeCloseTo(radiiNm[i], 2)
      expect(plon).toBeCloseTo(LO, 6)
      expect(plat).toBeGreaterThan(LA)
    }
  })

  it('puts every sample at its own radius, longitude scaled by latitude', () => {
    const pts = seaProbePoints(59.9, 10.73) // Oslo, where cos(lat) matters
    const { radiiNm, bearings } = SEA_PROBE_DEFAULTS
    pts.forEach(([plat, plon], i) => {
      const r = radiiNm[Math.floor(i / bearings)]
      expect(nmBetween(59.9, 10.73, plat, plon)).toBeCloseTo(r, 1)
    })
  })
})

describe('seaNmFromElevations', () => {
  const { radiiNm, bearings } = SEA_PROBE_DEFAULTS
  const allLand = () => new Array(radiiNm.length * bearings).fill(300)

  it('returns the SMALLEST radius that found sea', () => {
    const e = allLand()
    e[2 * bearings + 3] = 0      // sea on the outer ring
    expect(seaNmFromElevations(e)).toBe(radiiNm[2])
    e[0 * bearings + 5] = -2     // and also on the inner ring
    expect(seaNmFromElevations(e)).toBe(radiiNm[0])
  })

  it('returns the OUTERMOST radius when no sea is in the ring', () => {
    // Not null. "We looked ten miles and found no water" is the strongest
    // evidence a station is inland; returning null made Le Luc — the most
    // inland station in the St Tropez pick — the one the bias ignored.
    expect(seaNmFromElevations(allLand())).toBe(radiiNm[radiiNm.length - 1])
  })

  it('is null only when the measurement itself failed', () => {
    // Every sample a DEM hole: no verdict about the station.
    expect(seaNmFromElevations(new Array(radiiNm.length * bearings).fill(null))).toBeNull()
  })

  it('treats a sample at or below the threshold as sea', () => {
    const e = allLand(); e[0] = 1
    expect(seaNmFromElevations(e)).toBe(radiiNm[0])
    const f = allLand(); f[0] = 1.1
    expect(seaNmFromElevations(f)).toBe(radiiNm[radiiNm.length - 1])
  })

  it('ignores holes in the DEM response rather than calling them sea', () => {
    // A null elevation is a gap, not water. Reading it as sea would mark an
    // inland station coastal and defeat the bias.
    const e: Array<number | null> = allLand(); e[3] = null
    expect(seaNmFromElevations(e)).toBe(radiiNm[radiiNm.length - 1])
  })

  it('saturates the bias exactly, because the outer radius matches coastScaleNm', () => {
    const far = seaNmFromElevations(allLand()) as number
    expect(requiredSepNm(30, far, { coastBias: 1.5 })).toBeCloseTo(minSepNm(30) * 2.5, 6)
  })

  it('refuses a response of the wrong length instead of mis-aligning the rings', () => {
    expect(seaNmFromElevations([0, 0, 0])).toBeNull()
    expect(seaNmFromElevations([])).toBeNull()
  })
})

describe('seaProbeCost', () => {
  it('counts locations, because that is how Open-Meteo bills', () => {
    const { radiiNm, bearings } = SEA_PROBE_DEFAULTS
    expect(seaProbeCost(1)).toBe(radiiNm.length * bearings)
    expect(seaProbeCost(70)).toBe(70 * radiiNm.length * bearings)
  })
})

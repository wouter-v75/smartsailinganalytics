import { describe, expect, it } from 'vitest'
import { gradedPick, minSepNm, nmBetween, bandCounts, GRADED_DEFAULTS } from '../obsDensity'

// The Golfe de Saint-Tropez, the point the density is built around.
const LA = 43.266897
const LO = 6.698371

/** A station `nm` due east of the centre. */
const east = (nm: number) => ({
  lat: LA,
  lon: LO + nm / (60 * Math.cos((LA * Math.PI) / 180)),
})
/** A station `nm` due north. */
const north = (nm: number) => ({ lat: LA + nm / 60, lon: LO })

describe('nmBetween', () => {
  it('measures a degree of latitude as 60 nm', () => {
    expect(nmBetween(43, 6, 44, 6)).toBeCloseTo(60, 1)
  })

  it('shrinks a degree of longitude by the cosine of the latitude', () => {
    // At 43 N a degree of longitude is about 43.9 nm.
    expect(nmBetween(43, 6, 43, 7)).toBeCloseTo(60 * Math.cos((43 * Math.PI) / 180), 0)
  })

  it('agrees with the constructor used in the tests', () => {
    expect(nmBetween(LA, LO, east(7).lat, east(7).lon)).toBeCloseTo(7, 2)
    expect(nmBetween(LA, LO, north(12).lat, north(12).lon)).toBeCloseTo(12, 2)
  })
})

describe('minSepNm', () => {
  it('asks nothing of a station inside the inner circle', () => {
    expect(minSepNm(0)).toBe(0)
    expect(minSepNm(4.9)).toBe(0)
    expect(minSepNm(GRADED_DEFAULTS.innerNm)).toBe(0)
  })

  it('grows with range and reaches maxSep at the outer edge', () => {
    expect(minSepNm(GRADED_DEFAULTS.outerNm)).toBeCloseTo(GRADED_DEFAULTS.maxSepNm, 6)
    const a = minSepNm(10), b = minSepNm(25), c = minSepNm(45)
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
  })

  it('is monotonic all the way out', () => {
    let prev = -1
    for (let r = 0; r <= 60; r += 0.5) {
      const s = minSepNm(r)
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
  })

  it('clamps beyond the outer edge rather than growing without bound', () => {
    expect(minSepNm(200)).toBeCloseTo(GRADED_DEFAULTS.maxSepNm, 6)
  })
})

describe('gradedPick', () => {
  it('keeps EVERY station inside the inner circle, however crowded', () => {
    // Twelve stations packed into a tenth of a mile, all within 5 nm.
    const packed = Array.from({ length: 12 }, (_, i) => ({ lat: LA + i * 0.0002, lon: LO }))
    expect(gradedPick(packed, LA, LO)).toHaveLength(12)
  })

  it('drops nothing at all when everything is close in', () => {
    const near = [east(0.5), east(1), north(2), north(4.9)]
    expect(gradedPick(near, LA, LO)).toHaveLength(4)
  })

  it('thins a crowd that sits far out', () => {
    // Ten stations within a mile of each other, 40 nm away: the spacing
    // required out there is wide, so only one survives.
    const far = Array.from({ length: 10 }, (_, i) => ({ lat: LA + 40 / 60 + i * 0.002, lon: LO }))
    const kept = gradedPick(far, LA, LO)
    expect(kept.length).toBeGreaterThanOrEqual(1)
    expect(kept.length).toBeLessThan(far.length)
  })

  it('keeps nothing beyond the outer edge', () => {
    const kept = gradedPick([east(49), east(51), east(80)], LA, LO)
    expect(kept).toHaveLength(1)
    expect(nmBetween(LA, LO, kept[0].lat, kept[0].lon)).toBeLessThan(50)
  })

  it('returns nearest first, so the closest is never dropped for a farther one', () => {
    const kept = gradedPick([east(30), east(2), east(12), east(45)], LA, LO)
    const d = kept.map((s) => nmBetween(LA, LO, s.lat, s.lon))
    expect(d).toEqual([...d].sort((a, b) => a - b))
    expect(d[0]).toBeCloseTo(2, 1)
  })

  it('produces a density that genuinely falls with range', () => {
    // An even grid 0.02 deg apart over the whole 50 nm, then measure how many
    // survive per unit AREA in each band. That ratio must decrease.
    const grid: Array<{ lat: number; lon: number }> = []
    for (let dy = -0.9; dy <= 0.9; dy += 0.02) {
      for (let dx = -1.2; dx <= 1.2; dx += 0.02) grid.push({ lat: LA + dy, lon: LO + dx })
    }
    const kept = gradedPick(grid, LA, LO)
    const ring = (lo: number, hi: number) => {
      const n = kept.filter((s) => {
        const d = nmBetween(LA, LO, s.lat, s.lon)
        return d > lo && d <= hi
      }).length
      const area = Math.PI * (hi * hi - lo * lo)
      return n / area
    }
    const inner = ring(0, 5)
    const mid = ring(10, 20)
    const outer = ring(35, 50)
    expect(inner).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(outer)
  })

  it('is deterministic', () => {
    const grid = Array.from({ length: 200 }, (_, i) => ({ lat: LA + (i % 20) * 0.03, lon: LO + Math.floor(i / 20) * 0.04 }))
    expect(gradedPick(grid, LA, LO).map((s) => `${s.lat},${s.lon}`))
      .toEqual(gradedPick(grid, LA, LO).map((s) => `${s.lat},${s.lon}`))
  })

  it('keeps everything in range when no spacing is asked for', () => {
    const grid = Array.from({ length: 30 }, (_, i) => east(1 + i))
    expect(gradedPick(grid, LA, LO, { maxSepNm: 0 })).toHaveLength(30)
  })

  it('ignores stations with an unusable position', () => {
    const mixed = [east(1), { lat: NaN, lon: LO }, { lat: LA, lon: Infinity }, east(3)]
    expect(gradedPick(mixed, LA, LO)).toHaveLength(2)
  })

  it('honours a wider inner circle when asked', () => {
    const packed = Array.from({ length: 8 }, (_, i) => ({ lat: LA + 12 / 60 + i * 0.001, lon: LO }))
    // Default thins these; an inner circle of 15 nm keeps them all.
    expect(gradedPick(packed, LA, LO).length).toBeLessThan(8)
    expect(gradedPick(packed, LA, LO, { innerNm: 15 })).toHaveLength(8)
  })
})

describe('bandCounts', () => {
  it('counts cumulatively, each band including the ones inside it', () => {
    const c = bandCounts([east(1), east(7), east(7.5), east(25)], LA, LO)
    expect(c['5nm']).toBe(1)
    expect(c['10nm']).toBe(3)
    expect(c['30nm']).toBe(4)
    expect(c['50nm']).toBe(4)
  })
})

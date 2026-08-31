import { describe, it, expect } from 'vitest'
import { interpolateDirectionAtHeight, rigDirectionShearDeg } from '../openMeteo'

// Shape of a fetchBunnyModel payload: one array per published height.
function hourly(dirsByHeight: Record<number, number[]>) {
  const h: Record<string, number[]> = {}
  for (const [z, arr] of Object.entries(dirsByHeight)) h[`wind_direction_${z}m`] = arr
  return h
}
const HEIGHTS = [10, 30, 50]

describe('interpolateDirectionAtHeight', () => {
  it('interpolates as a vector, so it does not average 350° and 010° into 180°', () => {
    const h = hourly({ 10: [350], 30: [10], 50: [20] })
    const d = interpolateDirectionAtHeight(h, HEIGHTS, 30, 0)!
    expect(d).toBeCloseTo(10, 6)
    // midway in log-height between 10 and 30 must land near 000, not 180
    const mid = interpolateDirectionAtHeight(h, HEIGHTS, Math.sqrt(10 * 30), 0)!
    expect(Math.min(mid, 360 - mid)).toBeLessThan(2)
  })

  it('returns the exact level value when the target is a published height', () => {
    const h = hourly({ 10: [300], 30: [295], 50: [290] })
    expect(interpolateDirectionAtHeight(h, HEIGHTS, 10, 0)).toBeCloseTo(300, 6)
    expect(interpolateDirectionAtHeight(h, HEIGHTS, 50, 0)).toBeCloseTo(290, 6)
  })

  it('clamps rather than extrapolating above the top or below the bottom level', () => {
    const h = hourly({ 10: [300], 30: [295], 50: [290] })
    expect(interpolateDirectionAtHeight(h, HEIGHTS, 500, 0)).toBeCloseTo(290, 6)
    expect(interpolateDirectionAtHeight(h, HEIGHTS, 1, 0)).toBeCloseTo(300, 6)
  })

  it('copes with a single level, and with none', () => {
    expect(interpolateDirectionAtHeight(hourly({ 10: [123] }), [10], 34, 0)).toBeCloseTo(123, 6)
    expect(interpolateDirectionAtHeight(hourly({}), HEIGHTS, 34, 0)).toBeNull()
  })
})

describe('rigDirectionShearDeg', () => {
  it('is NEGATIVE when the wind backs with height (today at Porto Cervo)', () => {
    // measured at point 1, 11:00Z: 309° at 10 m, 304° at 30 m, 300° at 50 m
    const h = hourly({ 10: [309], 30: [304], 50: [300] })
    const sh = rigDirectionShearDeg(h, HEIGHTS, 34, 0)!
    expect(sh).toBeLessThan(0)
    expect(sh).toBeGreaterThan(-8)
    expect(Math.round(sh)).toBe(-6)
  })

  it('is POSITIVE when the wind veers with height', () => {
    const h = hourly({ 10: [180], 30: [195], 50: [205] })
    expect(rigDirectionShearDeg(h, HEIGHTS, 34, 0)!).toBeGreaterThan(0)
  })

  it('is ~zero in a unidirectional column', () => {
    const h = hourly({ 10: [270], 30: [270], 50: [270] })
    expect(Math.abs(rigDirectionShearDeg(h, HEIGHTS, 34, 0)!)).toBeLessThan(1e-6)
  })

  it('wraps across north instead of reporting a ~360° jump', () => {
    // backs from 005° through 000° to 355°: a 10° left turn, not −350 or +350
    const h = hourly({ 10: [5], 30: [0], 50: [355] })
    const sh = rigDirectionShearDeg(h, HEIGHTS, 50, 0)!
    expect(sh).toBeCloseTo(-10, 4)
  })

  it('scales with masthead height — a taller rig spans more of the turn', () => {
    const h = hourly({ 10: [300], 30: [290], 50: [284] })
    const short = Math.abs(rigDirectionShearDeg(h, HEIGHTS, 20, 0)!)
    const tall = Math.abs(rigDirectionShearDeg(h, HEIGHTS, 45, 0)!)
    expect(tall).toBeGreaterThan(short)
  })

  it('returns null when the payload carries no directions', () => {
    expect(rigDirectionShearDeg(hourly({}), HEIGHTS, 34, 0)).toBeNull()
    expect(rigDirectionShearDeg(null as never, HEIGHTS, 34, 0)).toBeNull()
  })
})

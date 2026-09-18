import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain-JS module, no d.ts
import { getVideoMode, calcAWA, bearingDeg, extractBoatLengthM, linReg } from '../sailMath'

// These five lived inside the 9.6k-line UI component and so were never covered.
// They are the arithmetic behind the video overlay and the analytics trend lines.

describe('calcAWA — apparent wind angle', () => {
  it('is zero dead downwind-of-nothing: head to wind with no lateral component', () => {
    expect(calcAWA(0, 10, 6)).toBe(0)
  })

  it('pulls the apparent angle forward of the true angle', () => {
    // Beam-on true wind, boat speed equal to wind speed → apparent is 45°,
    // i.e. dragged forward by the boat's own motion.
    expect(calcAWA(90, 10, 10)).toBeCloseTo(45, 6)
  })

  it('mirrors the sign of TWA so port and starboard stay apart', () => {
    expect(calcAWA(-90, 10, 10)).toBeCloseTo(-45, 6)
  })

  it('returns null rather than a wrong number when an input is missing', () => {
    expect(calcAWA(null, 10, 6)).toBeNull()
    expect(calcAWA(45, 0, 6)).toBeNull()   // no wind
    expect(calcAWA(45, 10, 0)).toBeNull()  // not moving
  })
})

describe('bearingDeg — compass bearing between two fixes', () => {
  it('reads 0 due north and 90 due east', () => {
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 6)
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 6)
  })

  it('wraps into 0–360 rather than returning a negative bearing', () => {
    const b = bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: -1 })
    expect(b).toBeCloseTo(270, 6)
  })

  it('narrows longitude by the cosine of latitude, so a Med start line is not skewed', () => {
    // At 43°N a degree of longitude is ~0.73 of a degree of latitude. Equal
    // degree deltas must therefore read well north of 45°.
    const b = bearingDeg({ lat: 43, lon: 9 }, { lat: 44, lon: 10 })
    expect(b).toBeGreaterThan(30)
    expect(b).toBeLessThan(45)
  })

  it('returns null for a zero-length leg instead of an arbitrary 0', () => {
    expect(bearingDeg({ lat: 43, lon: 9 }, { lat: 43, lon: 9 })).toBeNull()
    expect(bearingDeg(null, { lat: 43, lon: 9 })).toBeNull()
  })
})

describe('extractBoatLengthM', () => {
  it('reads feet out of the boat name and returns metres', () => {
    expect(extractBoatLengthM('NORTHSTAR72')).toBeCloseTo(72 * 0.3048, 6)
    expect(extractBoatLengthM('Northstar 76')).toBeCloseTo(76 * 0.3048, 6)
  })

  it('falls back to 12 m when the name carries no plausible length', () => {
    expect(extractBoatLengthM('Warp 5')).toBe(12)      // 5 is below the 20 ft floor
    expect(extractBoatLengthM('Rán')).toBe(12)
    expect(extractBoatLengthM('')).toBe(12)
    expect(extractBoatLengthM(null)).toBe(12)
    expect(extractBoatLengthM('Boat 900')).toBe(12)    // above the 150 ft ceiling
  })

  it('takes a class number at face value — a known limitation, pinned so it is not a surprise', () => {
    // A J/70 is 22.75 ft, but "70" is inside the 20–150 window, so the name
    // wins. Boats whose class number is not their length need the real length
    // from the boat config, not this helper.
    expect(extractBoatLengthM('J70')).toBeCloseTo(70 * 0.3048, 6)
  })
})

describe('linReg — the trend line under the analytics charts', () => {
  it('recovers slope and intercept exactly for collinear points', () => {
    const r = linReg([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }])
    expect(r.slope).toBeCloseTo(2, 9)
    expect(r.intercept).toBeCloseTo(1, 9)
    expect(r.r2).toBeCloseTo(1, 9)
  })

  it('reports a low r² for a cloud with no trend', () => {
    const r = linReg([{ x: 0, y: 1 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 0 }])
    expect(r.r2).toBeLessThan(0.5)
  })

  it('returns null where a line is meaningless instead of dividing by zero', () => {
    expect(linReg([])).toBeNull()
    expect(linReg([{ x: 1, y: 1 }])).toBeNull()
    expect(linReg([{ x: 1, y: 1 }, { x: 1, y: 5 }])).toBeNull() // vertical: no slope
  })
})

describe('getVideoMode — which instrument overlay a clip gets', () => {
  it('picks the start overlay for a race-start clip', () => {
    expect(getVideoMode(['race-start'])).toBe('start')
  })
  it('picks reach, and defaults everything else to upwind', () => {
    expect(getVideoMode(['reach'])).toBe('reach')
    expect(getVideoMode(['downwind'])).toBe('upwind')
    expect(getVideoMode(['some-random-tag'])).toBe('upwind')
    expect(getVideoMode([])).toBe('upwind')
    expect(getVideoMode(null)).toBe('upwind')
  })
  it('prefers race-start over a reach tag on the same clip', () => {
    expect(getVideoMode(['reach', 'race-start'])).toBe('start')
  })
})

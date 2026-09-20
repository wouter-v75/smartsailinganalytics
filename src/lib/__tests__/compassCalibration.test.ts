import { describe, it, expect } from 'vitest'
import { findSegments } from '../wind/segment'
import {
  solveCompassOffset, correctHeading, predictedHeadingDisagreement,
  NON_TIDAL_LIMIT_KN,
} from '../wind/compassCalibration'
import { beat } from './support/syntheticTrack'

const segsWith = (compassOffsetDeg: number, leewayDeg: number) =>
  findSegments(beat(270, { legs: 8, legSeconds: 150, compassOffsetDeg, leewayDeg }))

const solve = (compassOffsetDeg: number, leewayDeg: number, crossCurrentKn = 0.05) =>
  solveCompassOffset({
    segments: segsWith(compassOffsetDeg, leewayDeg), twdDeg: 270, crossCurrentKn,
  })

describe('solveCompassOffset recovers what was injected', () => {
  it.each([
    [0, 0], [5, 0], [-5, 3], [-14.5, 5.3], [12, 2],
  ])('recovers offset %s° and leeway %s°', (offset, leeway) => {
    const r = solve(offset, leeway)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.calibration.offsetDeg).toBeCloseTo(offset, 0)
    expect(r.calibration.leewayDeg).toBeCloseTo(leeway, 0)
  })

  it('separates the two even when both are large', () => {
    // The real pair: -5.1°/1.8° and -14.5°/5.3°.
    const a = solve(-5.1, 1.8)
    const b = solve(-14.5, 5.3)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.calibration.offsetDeg).toBeCloseTo(-5.1, 0)
    expect(b.calibration.offsetDeg).toBeCloseTo(-14.5, 0)
    expect(a.calibration.leewayDeg).toBeCloseTo(1.8, 0)
    expect(b.calibration.leewayDeg).toBeCloseTo(5.3, 0)
  })

  it('reproduces the cross-check that validated the whole decomposition', () => {
    // These offsets predicted a 9.4° heading-derived disagreement between the
    // two real boats; the independent symmetry fits measured 10.2°.
    const a = solve(-5.1, 1.8), b = solve(-14.5, 5.3)
    if (!a.ok || !b.ok) throw new Error('setup')
    expect(predictedHeadingDisagreement(a.calibration, b.calibration)).toBeCloseTo(9.4, 0)
  })

  it('reports the evidence behind the answer', () => {
    const r = solve(-5, 2)
    if (!r.ok) throw new Error('expected a solution')
    expect(r.calibration.segments).toBeGreaterThan(4)
    expect(Math.min(...r.calibration.secondsPerTack)).toBeGreaterThan(120)
    expect(r.calibration.uncertaintyDeg).toBeGreaterThanOrEqual(1)
  })
})

describe('the current/compass degeneracy', () => {
  it('refuses when the cross-wind current is unknown', () => {
    const r = solveCompassOffset({ segments: segsWith(-5, 2), twdDeg: 270 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/unknown/)
  })

  it('refuses when the current is large enough to masquerade as an offset', () => {
    // A cross-wind current produces exactly the same tack-independent signature
    // as a compass offset. In the Solent, -14.5° could be half a knot of tide.
    const r = solveCompassOffset({
      segments: segsWith(-5, 2), twdDeg: 270, crossCurrentKn: 0.8,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/non-tidal/)
  })

  it('accepts a genuinely non-tidal day', () => {
    expect(solveCompassOffset({
      segments: segsWith(-5, 2), twdDeg: 270, crossCurrentKn: NON_TIDAL_LIMIT_KN - 0.01,
    }).ok).toBe(true)
  })

  it('can be overridden deliberately, never by accident', () => {
    const r = solveCompassOffset({
      segments: segsWith(-5, 2), twdDeg: 270, requireNonTidal: false,
    })
    expect(r.ok).toBe(true)
  })
})

describe('insufficient evidence', () => {
  it('refuses when a tack is missing', () => {
    const oneTack = findSegments(beat(270, { legs: 1, legSeconds: 600, compassOffsetDeg: -5 }))
    const r = solveCompassOffset({ segments: oneTack, twdDeg: 270, crossCurrentKn: 0 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/each tack/)
  })

  it('refuses with no segments at all', () => {
    expect(solveCompassOffset({ segments: [], twdDeg: 270, crossCurrentKn: 0 }).ok).toBe(false)
  })

  it('refuses when the log carries no heading', () => {
    const noHdg = segsWith(-5, 2).map((s) => ({ ...s, hdg: null }))
    expect(solveCompassOffset({ segments: noHdg, twdDeg: 270, crossCurrentKn: 0 }).ok).toBe(false)
  })
})

describe('correctHeading', () => {
  it('subtracts the offset and wraps', () => {
    expect(correctHeading(10, 5)).toBeCloseTo(5, 6)     // reads 5 high -> true 5
    expect(correctHeading(2, 5)).toBeCloseTo(357, 6)
    expect(correctHeading(358, -5)).toBeCloseTo(3, 6)   // reads 5 low -> true 3
  })

  it('round-trips a device back to truth', () => {
    // A device reading 5° LOW logs 100 where the truth is 105.
    const r = solve(-5, 0)
    if (!r.ok) throw new Error('setup')
    expect(correctHeading(100, r.calibration.offsetDeg)).toBeCloseTo(105, 0)
  })
})

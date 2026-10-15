// src/lib/__tests__/combineDepths.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// A station depth's sigma has to survive contact with a SECOND set.
//
// residual × leverage measures how consistent the frames within one set are.
// It cannot see what a whole set gets wrong together — a ψ bias, a scale
// reference, a tack — and on Baraka (15 Oct 2026) three sets of the same
// stations came out 400-650 mm apart while each claimed ±10-70. Every residual
// was single-digit. That is the failure this guards.
//
// It matters beyond bookkeeping: the twist eligibility gate reads this sigma to
// decide whether an off-centreline frame may show twist at all, so an
// overconfident depth silently re-enables the measurement it should block.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { combineDepths } from '../sailTrimTriangulate'

describe('combineDepths', () => {
  it('leaves a lone estimate exactly alone', () => {
    const c = combineDepths({ mm: -6983, sigmaMm: 101 }, null)
    expect(c.mm).toBe(-6983)
    expect(c.sigmaMm).toBe(101)
    expect(c.from).toBe('single')
    expect(c.spreadMm).toBe(0)
  })

  it('tightens the sigma when two sets AGREE, which is the whole point of a second set', () => {
    const c = combineDepths({ mm: -2778, sigmaMm: 36 }, { mm: -2760, sigmaMm: 40 })
    expect(c.agrees).toBe(true)
    expect(c.sigmaMm).toBeLessThan(36)
    expect(c.mm).toBeGreaterThan(-2778)
    expect(c.mm).toBeLessThan(-2760)
  })

  it('refuses to be more confident than the SPREAD when they disagree', () => {
    // Baraka's jib@stripe25: 568 ±10 against 262 ±57, 306 mm apart. The
    // weighted mean with Birge inflation alone gives about ±52, because the
    // overconfident ±10 both dominates the weighting and drags the inflation
    // down. Two numbers 306 mm apart cannot be known to ±52: one of them is
    // wrong by at least 153.
    const c = combineDepths({ mm: 262, sigmaMm: 57 }, { mm: 568, sigmaMm: 10 })
    expect(c.agrees).toBe(false)
    expect(c.spreadMm).toBe(306)
    expect(c.sigmaMm).toBeCloseTo(153, 0)
    expect(c.from).toBe('half-spread')
  })

  it('converges rather than chasing the latest answer, applied set by set', () => {
    // All three of Baraka's jib@stripe25 solves, in the order they happened.
    let c = combineDepths({ mm: 262, sigmaMm: 57 }, { mm: 568, sigmaMm: 10 })
    expect(c.sigmaMm).toBeCloseTo(153, 0)
    c = combineDepths({ mm: -87, sigmaMm: 69 }, { mm: c.mm, sigmaMm: c.sigmaMm })
    // Three sets spanning 655 mm end up with a sigma that ADMITS it, instead of
    // the ±10 that was there before and that the twist gate believed.
    expect(c.sigmaMm).toBeGreaterThan(200)
    expect(c.agrees).toBe(false)
  })

  it('pushes a disagreeing station past the ±250 storage bar, which is the behaviour wanted', () => {
    // The bar exists so a depth nobody can pin down is not presented as
    // measured. Before this, set-to-set disagreement could not reach it: every
    // individual set was comfortably inside ±250.
    const first = combineDepths({ mm: -1814, sigmaMm: 34 }, { mm: -1676, sigmaMm: 14 })
    const second = combineDepths({ mm: -1050, sigmaMm: 69 }, { mm: first.mm, sigmaMm: first.sigmaMm })
    expect(first.sigmaMm).toBeLessThan(250)      // two sets, still plausible
    expect(second.sigmaMm).toBeGreaterThan(250)  // the third breaks it
  })

  it('inflates by the Birge ratio when the sigmas are honest enough for it to bite', () => {
    // Equal, believable sigmas: Birge does the work and the half-spread floor
    // is not what sets the answer.
    const c = combineDepths({ mm: 100, sigmaMm: 40 }, { mm: 220, sigmaMm: 40 })
    expect(c.birge).toBeGreaterThan(1)
    expect(c.mm).toBeCloseTo(160, 6)
    expect(c.sigmaMm).toBeCloseTo(60, 0)        // = half the 120 mm spread
    expect(c.agrees).toBe(false)
  })

  it('never returns a sigma under 1 mm, however many sets agree', () => {
    let c = combineDepths({ mm: 500, sigmaMm: 10 }, { mm: 500, sigmaMm: 10 })
    for (let i = 0; i < 20; i++) c = combineDepths({ mm: 500, sigmaMm: 10 }, { mm: c.mm, sigmaMm: c.sigmaMm })
    expect(c.sigmaMm).toBeGreaterThanOrEqual(1)
  })

  it('is symmetric in which estimate is called fresh', () => {
    const a = combineDepths({ mm: 262, sigmaMm: 57 }, { mm: 568, sigmaMm: 10 })
    const b = combineDepths({ mm: 568, sigmaMm: 10 }, { mm: 262, sigmaMm: 57 })
    expect(a.mm).toBeCloseTo(b.mm, 9)
    expect(a.sigmaMm).toBeCloseTo(b.sigmaMm, 9)
  })
})

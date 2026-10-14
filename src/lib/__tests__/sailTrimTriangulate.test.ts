import { describe, it, expect } from 'vitest'
import { triangulate, triangulateNote, type TriangulateView } from '../sailTrimTriangulate'

const D2R = Math.PI / 180
/** What a frame at this psi would report for a target at (Y, D). */
const view = (psiDeg: number, Y: number, D: number, assumed: number, noiseMm = 0): TriangulateView => {
  const p = psiDeg * D2R
  const raw = Y * Math.cos(p) - D * Math.sin(p) + noiseMm
  return { psiDeg, measuredMm: (raw + assumed * Math.sin(p)) / Math.cos(p), assumedDepthMm: assumed }
}

describe('triangulate', () => {
  // Northstar's main leech at half hoist, as the 27 Sep 11:43 set found it.
  const Y = 649, D = -6374, ASSUMED = -6000
  const PSIS = [-5.45, -0.34, 2.56]

  it('recovers the depth the rig model was guessing at', () => {
    const r = triangulate(PSIS.map((p) => view(p, Y, D, ASSUMED)))!
    expect(r.depthMm).toBeCloseTo(D, 3)
    expect(r.athwartshipsMm).toBeCloseTo(Y, 3)
    expect(r.rmsMm).toBeLessThan(0.001)
    expect(r.baselineDeg).toBeCloseTo(8.01, 2)
  })

  it('does not care what depth each frame assumed', () => {
    // Frames measured on different days carry different guesses; undoing them
    // is the first thing this does, so the answer must not move.
    const mixed = [view(-5.45, Y, D, -6000), view(-0.34, Y, D, -2500), view(2.56, Y, D, -9000)]
    expect(triangulate(mixed)!.depthMm).toBeCloseTo(D, 3)
  })

  it('reports a residual that catches a bad mark', () => {
    const good = triangulate(PSIS.map((p) => view(p, Y, D, ASSUMED)))!
    const bad = triangulate([
      view(-5.45, Y, D, ASSUMED), view(-0.34, Y, D, ASSUMED, 300), view(2.56, Y, D, ASSUMED),
    ])!
    expect(bad.rmsMm).toBeGreaterThan(50)
    expect(good.rmsMm).toBeLessThan(bad.rmsMm)
    expect(triangulateNote(bad)).toMatch(/views disagree/)
  })

  it('REFUSES views taken from the same place', () => {
    // The quiet failure: the solve succeeds, the residual is tiny because three
    // near-identical photographs agree with each other, and the depth is noise.
    expect(triangulate([view(1.0, Y, D, ASSUMED), view(1.1, Y, D, ASSUMED)])).toBeNull()
  })

  it('warns when the baseline is thin even though it solved', () => {
    const r = triangulate([view(0, Y, D, ASSUMED), view(2, Y, D, ASSUMED), view(2.5, Y, D, ASSUMED)])!
    expect(triangulateNote(r)).toMatch(/nearly the same photograph/)
  })

  it('says two views leave nothing to check it by', () => {
    const r = triangulate([view(-5.45, Y, D, ASSUMED), view(2.56, Y, D, ASSUMED)])!
    expect(r.rmsMm).toBeLessThan(0.001)          // exact, because it is not over-determined
    expect(triangulateNote(r)).toMatch(/no residual to check it by/)
  })

  it('refuses a single view', () => {
    expect(triangulate([view(0, Y, D, ASSUMED)])).toBeNull()
  })

  it('gets the BOOM back near the certificate, which is the only outside check', () => {
    // E is 10330 mm on Northstar. The solve is never told that.
    const r = triangulate(PSIS.map((p) => view(p, -416, -9839, -10330, 3)))!
    expect(Math.abs(r.depthMm)).toBeGreaterThan(9000)
    expect(Math.abs(r.depthMm)).toBeLessThan(11000)
  })
})

describe('triangulate — the image scale depends on the depth being solved for', () => {
  const D2R = Math.PI / 180
  /**
   * A frame, built FORWARDS from a known truth with the same maths measureTarget
   * uses, then reported the way a stored annotation reports it.
   */
  const frameFor = (truthY: number, truthD: number, psiDeg: number, rangeMm: number,
                    assumedDepthMm: number, heelDeg = 12) => {
    const p = psiDeg * D2R
    const ch = Math.cos(heelDeg * D2R)
    // The clicked pixel offset times the MAST-PLANE scale — the one quantity
    // that does not depend on any depth assumption. The projection says
    // pxK·(R+D)/R = Y·cos ψ − D·sin ψ·cos φ, so invert that.
    const pxK = (truthY * Math.cos(p) - truthD * Math.sin(p) * ch) * (rangeMm / (rangeMm + truthD))
    // What the tool then reports, having converted at the depth it ASSUMED and
    // corrected with that same depth.
    const measuredMm = (pxK * ((rangeMm + assumedDepthMm) / rangeMm)
      + assumedDepthMm * Math.sin(p) * ch) / Math.cos(p)
    return { psiDeg, measuredMm, assumedDepthMm, rangeMm, heelDeg }
  }

  it('recovers a boom at E from a CLOSE set, where the old model halved it', () => {
    // Baraka: E = 5700, shot at 22-29 m with the rig model still assuming the
    // generic -10000. D/R is 45 % here, so the depth-dependent scale is not a
    // rounding error — it is the answer.
    const truthY = -620, truthD = -5700
    const views = [
      frameFor(truthY, truthD, 4.72, 23_000, -10_000),
      frameFor(truthY, truthD, 0.67, 22_000, -10_000),
      frameFor(truthY, truthD, -1.66, 22_000, -10_000),
      frameFor(truthY, truthD, -5.66, 25_000, -10_000),
    ]
    const r = triangulate(views)!
    expect(r.depthMm).toBeGreaterThan(-6100)
    expect(r.depthMm).toBeLessThan(-5300)
    expect(r.athwartshipsMm).toBeCloseTo(truthY, -1)
    expect(r.rmsMm).toBeLessThan(5)

    // …and the old long-range model, handed the same frames, comes back short.
    // About 20 % here, with this error ISOLATED. Baraka's real set solved to
    // 51 % of her E, so this is part of that gap and not demonstrably all of
    // it — the rest is whatever else those frames carry.
    const flat = triangulate(views.map(({ psiDeg, measuredMm, assumedDepthMm }) =>
      ({ psiDeg, measuredMm, assumedDepthMm })))!
    expect(Math.abs(flat.depthMm)).toBeLessThan(0.85 * Math.abs(truthD))
    expect(Math.abs(flat.depthMm)).toBeGreaterThan(0.6 * Math.abs(truthD))
    // And it does NOT announce itself: the residual stays small while the
    // answer is half. That is why the boom-against-E check exists.
    expect(flat.rmsMm).toBeLessThan(60)
  })

  it('agrees with the old model at LONG range, where it was never wrong', () => {
    // Northstar, 260 m: D/R is 4 %, the approximation holds, and the fix must
    // not move an answer that was already right.
    const truthY = -2210, truthD = -10_330
    const views = [
      frameFor(truthY, truthD, 4.0, 260_000, -6_000),
      frameFor(truthY, truthD, 0.0, 260_000, -6_000),
      frameFor(truthY, truthD, -4.0, 260_000, -6_000),
    ]
    const withScale = triangulate(views)!
    const flat = triangulate(views.map(({ psiDeg, measuredMm, assumedDepthMm }) =>
      ({ psiDeg, measuredMm, assumedDepthMm })))!
    expect(withScale.depthMm).toBeGreaterThan(-10_900)
    expect(withScale.depthMm).toBeLessThan(-9_800)
    expect(Math.abs(withScale.depthMm - flat.depthMm)).toBeLessThan(900)
  })

  it('falls back to the old model when a frame has no range', () => {
    // No focal length, no range, no depth correction anywhere in the tool —
    // behaviour unchanged rather than refused.
    const views = [
      { psiDeg: 4, measuredMm: -2000, assumedDepthMm: -6000 },
      { psiDeg: -4, measuredMm: -2400, assumedDepthMm: -6000 },
    ]
    expect(triangulate(views)).not.toBeNull()
  })
})

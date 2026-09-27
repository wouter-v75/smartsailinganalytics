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

import { describe, it, expect } from 'vitest'
import { triangulate, triangulateNote, worstView, type TriangulateView } from '../sailTrimTriangulate'

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

describe('worstView — which frame is carrying the disagreement', () => {
  const clean = [
    view(5.5, -560, -5050, -10_000),
    view(0.7, -560, -5050, -10_000),
    view(-1.7, -560, -5050, -10_000),
    view(-5.7, -560, -5050, -10_000),
  ]

  it('names the one frame that is wrong, and what the set becomes without it', () => {
    // Baraka's 08:22 boom: one frame had solved ψ against a different, shorter
    // baseline. The rms was 94 mm over five views and 12 mm over four, and the
    // depth went from 79 % of her certificate E to 89 %. An average cannot say
    // that; only the per-view residuals can.
    const spoiled = [...clean]
    spoiled[1] = view(0.7, -560, -5050, -10_000, 300) // 300 mm out
    const w = worstView(spoiled)!
    expect(w.index).toBe(1)
    expect(w.without.rmsMm).toBeLessThan(triangulate(spoiled)!.rmsMm / 2)
  })

  it('says nothing when every frame agrees', () => {
    expect(worstView(clean)).toBeNull()
  })

  it('says nothing about a set that already fits well', () => {
    // Baraka's redone 08:22 set fitted every target to better than 7 mm and the
    // first version of this still offered to discard a frame from six of the
    // eight — because dropping one ALWAYS improves the residual: four views over
    // two unknowns leave two degrees of freedom and three leave one, so the rms
    // falls towards zero by arithmetic. Crying outlier at a good fit is how a
    // warning gets ignored when it finally means something.
    const slight = [...clean]
    slight[2] = view(-1.7, -560, -5050, -10_000, 12) // 12 mm, within marking noise
    const r = triangulate(slight)!
    expect(r.rmsMm).toBeLessThan(60)
    expect(worstView(slight)).toBeNull()
  })

  it('refuses to drop one when only three views are left to judge by', () => {
    // Three minus one is two, which solves exactly and has no residual at all.
    // "Improving" a fit by removing the evidence is not an improvement.
    const three = [clean[0], view(0.7, -560, -5050, -10_000, 300), clean[3]]
    expect(worstView(three)).toBeNull()
  })

  it('reports a residual per view, in the order given', () => {
    const r = triangulate(clean)!
    expect(r.residualsMm).toHaveLength(4)
    for (const v of r.residualsMm) expect(Math.abs(v)).toBeLessThan(1)
  })
})

describe('triangulate — the leeward flip must come out before the solve', () => {
  const D2R = Math.PI / 180
  /** A starboard frame, reported the way measureTarget reports one. */
  const stbdView = (psiDeg: number, Y: number, D: number, assumed: number, rangeMm = 34_000) => {
    const p = psiDeg * D2R
    const ch = Math.cos(10 * D2R)
    const pxK = (Y * Math.cos(p) - D * Math.sin(p) * ch) * (rangeMm / (rangeMm + D))
    const raw = (pxK * ((rangeMm + assumed) / rangeMm) + assumed * Math.sin(p) * ch) / Math.cos(p)
    // leewardSign(stbd) = -1, applied by measureTarget to the VALUE only.
    return { psiDeg, measuredMm: -raw, assumedDepthMm: assumed, rangeMm, heelDeg: 10, leewardSign: -1 }
  }

  it('recovers a starboard boom that the old code put three times too deep', () => {
    // Baraka's three starboard frames solved her boom to -13155 mm at a 6 mm
    // residual — against a certificate E of 5700. Un-flipped, the same frames
    // give -5750. The residual was small either way, which is the whole danger:
    // the fit was consistent, it was just consistent about the wrong thing.
    // Yimg is IMAGE-signed, which is what the projection produces. On starboard
    // measureTarget stores it multiplied by -1, and the answer comes back in
    // that same leeward-positive convention — so the expectation is -Yimg, and
    // writing it out is the point: getting this round the wrong way is the bug.
    const Yimg = 415, D = -5750
    const views = [stbdView(-0.32, Yimg, D, -10_000, 34_817),
                   stbdView(0.88, Yimg, D, -10_000, 33_466),
                   stbdView(3.87, Yimg, D, -10_000, 33_961)]
    const r = triangulate(views)!
    expect(r.depthMm).toBeGreaterThan(-6_200)
    expect(r.depthMm).toBeLessThan(-5_300)
    expect(r.athwartshipsMm).toBeCloseTo(-Yimg, -1)
    expect(r.rmsMm).toBeLessThan(5)
  })

  it('leaves PORT alone, where the flip is +1 and always was', () => {
    const Y = -662, D = -5590
    const port = [stbdView(0.81, Y, D, -10_000, 25_548),
                  stbdView(1.98, Y, D, -10_000, 25_721),
                  stbdView(6.09, Y, D, -10_000, 31_117)]
      .map((v) => ({ ...v, measuredMm: -v.measuredMm, leewardSign: 1 }))
    const r = triangulate(port)!
    expect(r.depthMm).toBeGreaterThan(-6_000)
    expect(r.depthMm).toBeLessThan(-5_200)
    expect(r.athwartshipsMm).toBeCloseTo(Y, -1)
  })

  it('defaults to port when no sign is given, which is the old behaviour', () => {
    const v = { psiDeg: 2, measuredMm: -600, assumedDepthMm: -5000 }
    const w = { ...v, leewardSign: 1 }
    expect(triangulate([v, { ...v, psiDeg: -2 }])!.depthMm)
      .toBeCloseTo(triangulate([w, { ...w, psiDeg: -2 }])!.depthMm, 6)
  })
})

describe('triangulateNote — the gap between 4° and 8°', () => {
  const at = (deg: number) => triangulateNote({
    athwartshipsMm: -600, depthMm: -5000, rmsMm: 3, views: 3,
    baselineDeg: deg, residualsMm: [1, -2, 1],
  })

  it('warns in the band the message always called insufficient', () => {
    // The sub-4° text has always ended "8° or more is what makes it a
    // measurement", and nothing covered 4-8. Baraka's two sets span 5.3° and
    // 4.2°, both fitted to 1-6 mm, and their station depths disagree across
    // tacks by up to 1100 mm on points that cannot have moved.
    expect(at(5.3)).toMatch(/under the 8°/)
    expect(at(4.2)).toMatch(/under the 8°/)
  })

  it('says which number survives a narrow span and which does not', () => {
    // The useful half: a narrow span costs the DEPTH, not the athwartships
    // figure, which every view pins. Saying only "not enough angle" would throw
    // away a good measurement along with a bad one.
    expect(at(5)).toMatch(/ATHWARTSHIPS/)
    expect(at(5)).toMatch(/DEPTH does not/)
  })

  it('keeps the harder warning below 4°, and stays quiet past 8°', () => {
    expect(at(3)).toMatch(/nearly the same photograph/)
    expect(at(3)).not.toMatch(/under the 8°/)
    expect(at(9)).toBe('')
  })
})

describe('triangulateNote — how hard the depth amplifies a bad click', () => {
  const at = (deg: number, views = 3) => triangulateNote({
    athwartshipsMm: -411, depthMm: -10_557, rmsMm: 0, views,
    baselineDeg: deg, residualsMm: [],
  })

  it('puts a NUMBER on it, not just a caution', () => {
    // Northstar's boom: two views 7.2° apart, 0 mm residual by construction,
    // marking sigmas of ±135 and ±69 — about ±1100 mm of depth. I read -10557
    // as a measurement several times while the note said only "no residual to
    // check it by". A figure is harder to wave past than a sentence.
    expect(at(7.2, 2)).toMatch(/moves this DEPTH by 8 mm/)
    expect(at(4.0)).toMatch(/moves this DEPTH by 14 mm/)
  })

  it('says nothing extra on a set with no other caution', () => {
    // At the 8° bar the leverage is still 7x, so printing it unconditionally
    // would put a warning on every good set — and a warning that is always
    // there is one people stop reading.
    expect(at(12)).toBe('')
    expect(at(9)).toBe('')
  })

  it('fires on a WIDE span that still has only two views', () => {
    // The two warnings are about different things: one is "no check", the other
    // is "the check would have to be very good". A set can need both.
    const n = at(7.2, 2)
    expect(n).toMatch(/two views solve it exactly/)
    expect(n).toMatch(/moves this DEPTH/)
  })
})

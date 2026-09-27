import { describe, it, expect } from 'vitest'
import { fitCamberMultiView, multiViewNote, rawAt, type MultiViewFrame } from '../sailCamberMultiView'

// Northstar's main at half hoist on 27 Sep: MHW 7040 mm, leech triangulated to
// 649 mm athwartships and -6374 mm aft, from the very frames being fitted.
const CH = 7040, LY = 649, LD = -6374
const PSIS = [-5.45, -0.34, 2.56]

/** What the three frames would show for a section of known shape. */
const framesFor = (c: number, d: number, ss: number[], noiseMm = 0): MultiViewFrame[] =>
  PSIS.map((psi, k) => ({
    psiDeg: psi,
    dots: ss.map((s, i) => ({
      rawMm: rawAt(s, c, d, CH, LY, LD, psi) + ((i + k) % 2 ? noiseMm : -noiseMm),
    })),
  }))

const SPAN = [0.08, 0.16, 0.24, 0.33, 0.42, 0.52, 0.62, 0.72]

describe('fitCamberMultiView', () => {
  it('recovers the depth from three frames', () => {
    const f = fitCamberMultiView({ frames: framesFor(0.11, 0.45, SPAN), chordMm: CH, leechAthwartshipsMm: LY, leechDepthMm: LD })!
    expect(f.camber * 100).toBeCloseTo(11.0, 0)
    expect(f.frames).toBe(3)
    expect(f.reachedPeak).toBe(true)
    // Not zero: the fit assumes evenly spaced dots and this fixture's are not
    // quite even, so a couple of pixels of residual is the prior doing its job
    // rather than a misfit.
    expect(f.rmsMm).toBeLessThan(20)
  })

  it('holds up under a pixel of marking noise', () => {
    // ~8 mm/px at this range, so one pixel is about 8 mm.
    const f = fitCamberMultiView({ frames: framesFor(0.11, 0.45, SPAN, 8), chordMm: CH, leechAthwartshipsMm: LY, leechDepthMm: LD })!
    expect(Math.abs(f.camber * 100 - 11.0)).toBeLessThan(1.5)
  })

  it('separates 10.5 % from 11.5 %, which is the resolution the targets need', () => {
    const lo = fitCamberMultiView({ frames: framesFor(0.105, 0.45, SPAN), chordMm: CH, leechAthwartshipsMm: LY, leechDepthMm: LD })!
    const hi = fitCamberMultiView({ frames: framesFor(0.115, 0.45, SPAN), chordMm: CH, leechAthwartshipsMm: LY, leechDepthMm: LD })!
    expect(hi.camber).toBeGreaterThan(lo.camber)
    expect((hi.camber - lo.camber) * 100).toBeGreaterThan(0.5)
  })

  it('says when no dot reaches past the deepest part', () => {
    // The failure that returns a plausible number: one flank only, reading low.
    const f = fitCamberMultiView({ frames: framesFor(0.11, 0.45, [0.05, 0.12, 0.2, 0.28]), chordMm: CH, leechAthwartshipsMm: LY, leechDepthMm: LD })!
    expect(f.reachedPeak).toBe(false)
    expect(multiViewNote(f)).toMatch(/extrapolated from one flank and reads LOW/)
  })

  it('REFUSES frames taken from nearly one spot', () => {
    // They agree with each other beautifully and say nothing about depth.
    const near: MultiViewFrame[] = [1.0, 1.2, 1.4].map((psi) => ({
      psiDeg: psi, dots: SPAN.map((s) => ({ rawMm: rawAt(s, 0.11, 0.45, CH, LY, LD, psi) })),
    }))
    expect(fitCamberMultiView({ frames: near, chordMm: CH, leechAthwartshipsMm: LY, leechDepthMm: LD })).toBeNull()
  })

  it('refuses a single frame, however many dots it has', () => {
    const one = [framesFor(0.11, 0.45, SPAN)[0]]
    expect(fitCamberMultiView({ frames: one, chordMm: CH, leechAthwartshipsMm: LY, leechDepthMm: LD })).toBeNull()
  })

  it('flags dots that sit nowhere on any section', () => {
    const bad = framesFor(0.11, 0.45, SPAN)
    bad[1].dots[3] = { rawMm: bad[1].dots[3].rawMm + 900 }
    const f = fitCamberMultiView({ frames: bad, chordMm: CH, leechAthwartshipsMm: LY, leechDepthMm: LD })!
    expect(multiViewNote(f)).toMatch(/past marking accuracy/)
  })

  it('needs no point correspondence — frames may mark different places', () => {
    // The thing that killed every earlier attempt: a dot on a painted stripe
    // cannot be matched between frames. Here each frame marks its own spots.
    const mixed: MultiViewFrame[] = [
      { psiDeg: -5.45, dots: [0.10, 0.25, 0.40, 0.55, 0.70].map((s) => ({ rawMm: rawAt(s, 0.11, 0.45, CH, LY, LD, -5.45) })) },
      { psiDeg: -0.34, dots: [0.07, 0.19, 0.31, 0.47, 0.63, 0.77].map((s) => ({ rawMm: rawAt(s, 0.11, 0.45, CH, LY, LD, -0.34) })) },
      { psiDeg: 2.56, dots: [0.12, 0.30, 0.50, 0.68].map((s) => ({ rawMm: rawAt(s, 0.11, 0.45, CH, LY, LD, 2.56) })) },
    ]
    const f = fitCamberMultiView({ frames: mixed, chordMm: CH, leechAthwartshipsMm: LY, leechDepthMm: LD })!
    expect(f.camber * 100).toBeCloseTo(11.0, 0)
  })
})

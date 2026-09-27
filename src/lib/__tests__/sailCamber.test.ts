// src/lib/__tests__/sailCamber.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Camber from a stern shot. The assertions that matter are the ones about what
// happens when the marks are BADLY PLACED, because that is the failure that
// looks like a number rather than like an error.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { fitCamber, sectionDeviation, alongAndOff, camberNote, athwartshipsMm, type Px } from '../sailCamber'

// Capricorno's main at half hoist, off its certificate: MHW 7.44 m. The 12:36
// frame put the leech 879 mm to leeward with a chord angle of about 7°.
const CHORD = 7440
const ANGLE = 7
const MM_PER_PX = 6.2
const PROJ = Math.cos(ANGLE * Math.PI / 180)

/** Build image marks for a section of known shape, as the tool would see them. */
function marksFor(camber: number, draft: number, ss: number[], noisePx = 0): {
  marks: Px[]; luff: Px; leech: Px
} {
  // A chord lying along the image x axis keeps the arithmetic checkable by eye.
  const luff: Px = { x: 1000, y: 3000 }
  const chordPx = (CHORD * Math.sin(ANGLE * Math.PI / 180)) / MM_PER_PX + 200
  const leech: Px = { x: luff.x + chordPx, y: 3000 }
  const marks = ss.map((s, i) => {
    const offMm = sectionDeviation(s, camber, draft) * CHORD
    const offPx = (offMm * PROJ) / MM_PER_PX
    return {
      x: luff.x + s * chordPx + (i % 2 ? noisePx : -noisePx),
      y: luff.y - offPx + (i % 3 ? -noisePx : noisePx),
    }
  })
  return { marks, luff, leech }
}
const fit = (camber: number, draft: number, ss: number[], noisePx = 0) =>
  fitCamber({ ...marksFor(camber, draft, ss, noisePx), chordMm: CHORD, mmPerPx: MM_PER_PX, chordAngleDeg: ANGLE })

describe('alongAndOff — the geometry does what the eye cannot', () => {
  it('reads position along the chord by projection', () => {
    const a = alongAndOff({ x: 1500, y: 3000 }, { x: 1000, y: 3000 }, { x: 2000, y: 3000 })!
    expect(a.s).toBeCloseTo(0.5, 9)
    expect(a.offPx).toBeCloseTo(0, 9)
  })

  it('signs the offset, so a mark on the wrong side shows up', () => {
    const above = alongAndOff({ x: 1500, y: 2900 }, { x: 1000, y: 3000 }, { x: 2000, y: 3000 })!
    const below = alongAndOff({ x: 1500, y: 3100 }, { x: 1000, y: 3000 }, { x: 2000, y: 3000 })!
    expect(Math.sign(above.offPx)).toBe(-Math.sign(below.offPx))
  })
})

describe('fitCamber — depth from front and back marks', () => {
  // Capricorno's main at half hoist, built the way the CAMERA resolves it:
  // athwartships offset only, which is all a stern shot gives. The offset rises
  // to a turning point and falls back to the leech, so two positions share one
  // offset. Which FACE a mark is on is what chooses between them.
  const CHORD = 7440, LEECH_MM = 879
  const ANG = Math.asin(LEECH_MM / CHORD) * 180 / Math.PI
  const MMPX = 6.2

  const imageAt = (s: number, c: number, d: number): Px => ({
    x: 1000 + athwartshipsMm(s, c, d, CHORD, ANG) / MMPX,
    y: 3000,
  })
  const luff = () => imageAt(0, 0, 0.45)
  const leech = () => imageAt(1, 0, 0.45)
  /** Where the observable stops rising, for splitting truth into two faces. */
  const turn = (c: number, d: number) => {
    let bs = 0.5, best = -Infinity
    for (let s = 0.01; s < 1; s += 0.002) {
      const v = athwartshipsMm(s, c, d, CHORD, ANG); if (v > best) { best = v; bs = s }
    }
    return bs
  }
  const marksFor = (c: number, d: number, fs: number[], bs: number[], noisePx = 0) => ({
    front: fs.map((s, i) => { const p = imageAt(s, c, d); return { x: p.x + (i % 2 ? noisePx : -noisePx), y: p.y } }),
    back: bs.map((s, i) => { const p = imageAt(s, c, d); return { x: p.x + (i % 2 ? -noisePx : noisePx), y: p.y } }),
    luff: luff(), leech: leech(), chordMm: CHORD, chordAngleDeg: ANG,
  })

  it('the observable really does turn over — this is not a modelling choice', () => {
    const t = turn(0.11, 0.45)
    expect(t).toBeGreaterThan(0.2)
    expect(t).toBeLessThan(0.9)
    // The stripe reaches further to leeward mid-chord than at its own leech.
    expect(athwartshipsMm(t, 0.11, 0.45, CHORD, ANG)).toBeGreaterThan(LEECH_MM)
  })

  it('recovers 11 % depth from marks on both faces', () => {
    const t = turn(0.11, 0.45)
    const f = fitCamber(marksFor(0.11, 0.45, [0.10, 0.22, t * 0.85], [t + 0.12, 0.78, 0.90]))!
    expect(f.camber * 100).toBeCloseTo(11.0, 0)
    expect(f.spansDraft).toBe(true)
  })

  it('IS NOT YET PRECISE ENOUGH, and this records why', () => {
    // The number that decides whether this is usable, and it says no. With
    // perfect marks the depth comes back exact; with ONE pixel of click noise
    // it is 2.3 points out, and with two pixels 1.4 — worse at one than at two,
    // which is the signature of an ill-conditioned fit rather than a noisy one.
    // Many camber/draft pairs reproduce the observed offsets almost equally
    // well, because the only observable is the athwartships offset and both
    // parameters move it the same way.
    //
    // The crew work to 10.5-11 % and call a half point a miss, so this is an
    // order of magnitude short. Left asserted rather than tuned away: the next
    // attempt needs to know what it has to beat.
    const t = turn(0.11, 0.45)
    const at = (noise: number) =>
      Math.abs(fitCamber(marksFor(0.11, 0.45, [0.10, 0.22, t * 0.85], [t + 0.12, 0.78, 0.90], noise))!.camber * 100 - 11.0)
    expect(at(0)).toBeLessThan(0.2)
    expect(at(1)).toBeGreaterThan(1.0)
  })

  it('separates 10.5 % from 11.5 %, which is the resolution the target needs', () => {
    const lo = fitCamber(marksFor(0.105, 0.45, [0.10, 0.22, 0.40], [0.62, 0.78, 0.90]))!
    const hi = fitCamber(marksFor(0.115, 0.45, [0.10, 0.22, 0.40], [0.62, 0.78, 0.90]))!
    expect(hi.camber).toBeGreaterThan(lo.camber)
    expect((hi.camber - lo.camber) * 100).toBeGreaterThan(0.5)
  })

  it('says so when only one face is marked', () => {
    const f = fitCamber(marksFor(0.11, 0.45, [0.10, 0.22, 0.40], []))!
    expect(f.spansDraft).toBe(false)
    expect(camberNote(f)).toMatch(/extrapolated and reads LOW/)
  })

  it('refuses fewer than two marks in total', () => {
    expect(fitCamber(marksFor(0.11, 0.45, [0.3], []))).toBeNull()
  })

  it('refuses a stripe seen edge-on', () => {
    expect(fitCamber({ ...marksFor(0.11, 0.45, [0.2], [0.8]), chordAngleDeg: 85 })).toBeNull()
  })
})

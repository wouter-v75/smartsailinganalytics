// src/lib/__tests__/sailCamber.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Camber from a stern shot. The assertions that matter are the ones about what
// happens when the marks are BADLY PLACED, because that is the failure that
// looks like a number rather than like an error.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { fitCamber, sectionDeviation, alongAndOff, camberNote, type Px } from '../sailCamber'

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

describe('fitCamber', () => {
  it('recovers a section marked across its whole length', () => {
    const f = fit(0.12, 0.45, [0.15, 0.3, 0.45, 0.6, 0.8])!
    expect(f.camber * 100).toBeCloseTo(12.0, 1)
    expect(f.draft * 100).toBeCloseTo(45, 0)
    expect(f.spansDraft).toBe(true)
    expect(f.rmsPx).toBeLessThan(0.1)
  })

  it('survives a pixel of click noise', () => {
    const f = fit(0.12, 0.45, [0.12, 0.28, 0.44, 0.62, 0.82], 1)!
    expect(Math.abs(f.camber * 100 - 12.0)).toBeLessThan(0.6)
  })

  it('READS LOW when the marks are all forward — and says so', () => {
    // The failure that matters, because it returns a plausible number. Marks
    // confined to the forward third under-read camber and collapse the draft.
    const f = fit(0.12, 0.45, [0.06, 0.13, 0.20, 0.27, 0.33])!
    expect(f.coverage.to).toBeLessThan(0.45)
    expect(f.spansDraft).toBe(false)
    expect(camberNote(f)).toMatch(/extrapolated and reads LOW/)
  })

  it('is rescued by marks near the leech, even where the sail is nearly flat', () => {
    // Wouter, 27 Sep: "often in the aft part of the sail, the back of the sail
    // and sailstripe are visible". That is not a curiosity — it is what makes
    // the measurement work.
    const forwardOnly = fit(0.12, 0.45, [0.06, 0.13, 0.20, 0.27, 0.33], 1)!
    const withAft = fit(0.12, 0.45, [0.06, 0.13, 0.20, 0.27, 0.88, 0.94], 1)!
    expect(withAft.spansDraft).toBe(true)
    expect(Math.abs(withAft.camber - 0.12)).toBeLessThan(Math.abs(forwardOnly.camber - 0.12))
  })

  it('ignores marks ON the ends, where the deviation is zero by construction', () => {
    const withEnds = fit(0.12, 0.45, [0.0, 0.2, 0.45, 0.7, 1.0])!
    expect(withEnds.n).toBe(3)
  })

  it('refuses a stripe seen edge-on', () => {
    const m = marksFor(0.12, 0.45, [0.2, 0.5, 0.8])
    expect(fitCamber({ ...m, chordMm: CHORD, mmPerPx: MM_PER_PX, chordAngleDeg: 85 })).toBeNull()
  })

  it('refuses fewer than two usable marks', () => {
    expect(fit(0.12, 0.45, [0.5])).toBeNull()
  })

  it('reports the foreshortening it undid', () => {
    const f = fit(0.12, 0.45, [0.2, 0.45, 0.7])!
    expect(f.projection).toBeCloseTo(PROJ, 6)
    // 7° of chord angle costs less than 1 % of the camber.
    expect(f.projection).toBeGreaterThan(0.99)
  })

  it('flags marks that do not sit on any plausible section', () => {
    const m = marksFor(0.12, 0.45, [0.2, 0.45, 0.7])
    m.marks[1] = { x: m.marks[1].x, y: m.marks[1].y - 60 }   // one mark off the stripe
    const f = fitCamber({ ...m, chordMm: CHORD, mmPerPx: MM_PER_PX, chordAngleDeg: ANGLE })!
    expect(f.rmsPx).toBeGreaterThan(5)
    expect(camberNote(f)).toMatch(/off the fitted section/)
  })
})

describe('when the chord stops being an axis', () => {
  // Capricorno's main at half hoist, built the way the CAMERA sees it rather
  // than by hand: the arc is smooth — nothing you would notice in the photo —
  // but the leech sits 879 mm to leeward of the luff while an 11 % camber puts
  // the deepest part about 1210 mm out. Two positions along the stripe then
  // share one offset from the luff-leech line, and marks resolve outside the
  // chord: a point 30 % along came back as 117 %. Discarding those silently
  // returned 1.0 % against a truth of 11 %.
  const CHORD = 7440, LEECH_MM = 879, MMPX = 6.2
  const ANG = Math.asin(LEECH_MM / CHORD) * 180 / Math.PI

  /** Athwartships millimetres of the section at s, as the camera resolves it. */
  const athwart = (s: number, camber: number, draft: number) => {
    const dev = sectionDeviation(s, camber, draft) * CHORD
    const a = ANG * Math.PI / 180
    return s * LEECH_MM + dev * Math.cos(a)
  }
  const imageMarks = (camber: number, draft: number, ss: number[]) => {
    const luff: Px = { x: 1000, y: 3000 }
    const at = (s: number) => ({ x: 1000 + athwart(s, camber, draft) / MMPX, y: 3000 })
    return { luff, leech: at(1), marks: ss.map(at) }
  }

  it('refuses rather than answering, when marks resolve past the chord', () => {
    const { luff, leech, marks } = imageMarks(0.11, 0.45, [0.10, 0.20, 0.30, 0.62, 0.78, 0.90])
    // The leech is 138 px out; the stripe reaches past 195 px in the middle.
    expect(Math.hypot(leech.x - luff.x, leech.y - luff.y)).toBeCloseTo(LEECH_MM / MMPX, 0)
    expect(Math.max(...marks.map((m) => m.x - luff.x))).toBeGreaterThan(leech.x - luff.x)
    expect(fitCamber({ marks, luff, leech, chordMm: CHORD, mmPerPx: MMPX, chordAngleDeg: ANG })).toBeNull()
  })

  it('still answers a flat sail, where the chord IS the larger extent', () => {
    // 4 % camber on the same station: the bulge no longer overruns the chord.
    const { luff, leech, marks } = imageMarks(0.04, 0.45, [0.15, 0.35, 0.55, 0.75])
    expect(Math.max(...marks.map((m) => m.x - luff.x))).toBeLessThan(leech.x - luff.x)
    expect(fitCamber({ marks, luff, leech, chordMm: CHORD, mmPerPx: MMPX, chordAngleDeg: ANG })).not.toBeNull()
  })
})

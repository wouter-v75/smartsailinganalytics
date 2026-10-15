// src/lib/__tests__/lidarFootBasis.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// KND's lidar twist is referenced to the FOOT, and this is the evidence.
//
// It was the open question that kept the photo-vs-lidar comparison on angles to
// the boat's midline: a constant offset down the absolute angles means a
// different zero point, and nothing we have documents KND's. Re-zeroing on a
// guess would have swapped a known offset for an unknown one.
//
// The 26 Sep 10:25 pair settles it, because one of them is shot at ψ = 0.00°,
// where the station-depth term drops out of the geometry entirely and the frame
// is exact rather than approximate. The numbers below are the real stored ones.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { angleRows } from '../sailTrimLidar'
import type { SailTrimAnnotation } from '../sailTrimOverlay'

/** 2026-09-26, Northstar 76, as stored. Angles are to the boat's midline. */
const frame = (clew: number, s25: number, s50: number, s75: number, withStored = false): SailTrimAnnotation => ({
  version: 'x', imageSize: { w: 6000, h: 4000 }, defn: 'boat', axis: null,
  targets: [], psiDeg: 0, psiMeasured: true, heelDeg: 12, measuredAt: 0,
  chords: [
    ['clew', 0, 10.33, clew], ['stripe25', 0.25, 8.685, s25],
    ['stripe50', 0.5, 7.04, s50], ['stripe75', 0.75, 4.93, s75],
  ].map(([tag, fraction, widthM, angleDeg]) => ({
    sail: 'main' as const, tag: tag as string, fraction: fraction as number,
    chordMm: 0, widthM: widthM as number, widthSource: 'certificate' as const,
    angleDeg: angleDeg as number, angleSigmaDeg: 0.15, luffMm: null,
    ...(withStored ? { twistFromFootDeg: (angleDeg as number) - clew } : {}),
  })),
} as unknown as SailTrimAnnotation)

/** The phase both 10:25 frames fall in: KND's main twist by height. */
const phase = { mean: { mnTw25: 2.87, mnTw50: 6.54, mnTw75: 11.52 } } as never

describe('KND’s lidar twist is foot-referenced', () => {
  it('agrees to 0.02° on the ψ = 0 frame, once converted to the foot basis', () => {
    // 10:25:33, ψ = 0.00° — the best-conditioned frame available, because at
    // ψ = 0 the unknown station depth cannot affect the answer at all.
    const rows = angleRows(frame(-5.15, -2.26, 0.65, 4.10), phase)
    const at25 = rows.find((r) => r.height === 25)!
    expect(at25.basis).toBe('foot-derived')
    expect(at25.photoDeg).toBeCloseTo(2.89, 2)      // -2.26 - (-5.15)
    expect(Math.abs(at25.diffDeg!)).toBeLessThan(0.05)
  })

  it('is 250x worse read as an angle to the MIDLINE, which is the old behaviour', () => {
    // The same frame, the same lidar, the same stripe: -2.26 against 2.87.
    // That 5.13° gap is the clew angle, and nothing else.
    const rows = angleRows(frame(-5.15, -2.26, 0.65, 4.10), phase)
    const converted = Math.abs(rows.find((r) => r.height === 25)!.diffDeg!)
    const asMidline = Math.abs(-2.26 - 2.87)
    expect(asMidline / converted).toBeGreaterThan(100)
    expect(asMidline).toBeCloseTo(Math.abs(-5.15) + 0.02, 1)
  })

  it('agrees LESS well on the off-axis frame, which is the predicted direction', () => {
    // 10:25:28, ψ = 4.96°, five seconds earlier and the same lidar phase. Off
    // the centreline the leech offset carries d·sinψ with d a model guess, so
    // this frame is expected to be worse — and it is, by an amount that is
    // still far better than the midline reading.
    const off = angleRows(frame(-4.63, -2.19, 0.55, 3.85), phase)
    const square = angleRows(frame(-5.15, -2.26, 0.65, 4.10), phase)
    const d = (r: typeof off) => Math.abs(r.find((x) => x.height === 25)!.diffDeg!)
    expect(d(off)).toBeGreaterThan(d(square))
    expect(d(off)).toBeLessThan(0.6)
  })

  it('prefers the annotation’s OWN stored twist when it has one', () => {
    const rows = angleRows(frame(-5.15, -2.26, 0.65, 4.10, true), phase)
    expect(rows.find((r) => r.height === 25)!.basis).toBe('foot-stored')
    expect(rows.find((r) => r.height === 25)!.photoDeg).toBeCloseTo(2.89, 2)
  })

  it('says so when no clew was marked, instead of quietly comparing a sheeting angle', () => {
    const noClew = frame(-5.15, -2.26, 0.65, 4.10)
    noClew.chords = (noClew.chords || []).filter((c) => c.tag !== 'clew')
    const rows = angleRows(noClew, phase)
    const at25 = rows.find((r) => r.height === 25)!
    expect(at25.basis).toBe('centreline')
    // Unconverted, so the diff carries the whole foot angle — which is exactly
    // the 5° that made this comparison look broken for weeks.
    expect(Math.abs(at25.diffDeg!)).toBeGreaterThan(4)
  })

  it('leaves the TWIST BETWEEN stripes untouched, since a common datum cancels', () => {
    // The pairwise rows never needed this conversion, and must not have changed
    // because of it: subtracting the same clew angle from both ends of a
    // difference does nothing.
    const rows = angleRows(frame(-5.15, -2.26, 0.65, 4.10), phase)
    const step = rows.find((r) => r.height === 50)!.photoDeg - rows.find((r) => r.height === 25)!.photoDeg
    expect(step).toBeCloseTo(0.65 - (-2.26), 9)
  })
})

// src/lib/__tests__/jibLuffRake.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Both rules girth a headsail PERPENDICULAR TO THE LUFF. The trim stripes are
// HORIZONTAL (Wouter, 6 Nov), and so is the chord this pipeline measures off a
// photograph — luff to leech at one height. The two are not the same line, and
// the angle between them is the luff's rake.
//
// THE CONVERSION IS EXACT. For a leech point at perpendicular distance w from a
// luff raked ρ, the horizontal distance to that luff is w / cos ρ. Writing the
// leech point as the luff point at fraction f plus w perpendicular,
//
//     L = f·HLU·sinρ + w·cosρ − (f·HLU·cosρ − w·sinρ)·tanρ
//       = w·cosρ + w·sin²ρ/cosρ  =  w / cosρ
//
// — the f·HLU terms cancel identically. So it depends on neither the station
// nor the LEECH's shape, which is the part that looked as though it would make
// this messy. It is just the horizontal distance from a point to a raked line.
//
// It is worth 2.8 % on Ryujin and 4.3-4.4 % on Northstar and Baraka. It is NOT
// worth doing for the main, whose luff is the mast at 2-4°: 0.14 %, and no
// certificate carries the figure.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { widthAt, type SailWidths } from '../sailTwist'

/** Ryujin's jib, from her 2026 ORR certificate. Forestay asin(5.700/24.420). */
const RYUJIN_JIB: SailWidths = {
  foot: 8.520, quarter: 6.620, half: 4.540, threeQuarter: 2.270, upper: 1.150,
  luffRakeDeg: 13.498,
}
const RHO = 13.498 * Math.PI / 180

describe('the jib girth is perpendicular to the luff', () => {
  it('converts a certificate width to the HORIZONTAL chord, exactly w / cos ρ', () => {
    const w = widthAt(RYUJIN_JIB, 0.5)!
    expect(w.m).toBeCloseTo(4.540 / Math.cos(RHO), 9)
    expect(w.m).toBeCloseTo(4.669, 3)
    expect(w.source).toBe('certificate')
    expect(w.note).toMatch(/÷cos 13.5° luff rake/)
  })

  it('reproduces the geometry it was derived from, at every station', () => {
    // Build the leech point from the luff point plus w perpendicular, then take
    // the horizontal distance back to the luff. That is the long way round and
    // it has to agree with w / cos ρ at every station, or the derivation is
    // wrong somewhere it happens not to show.
    const HLU = 24.420, s = Math.sin(RHO), c = Math.cos(RHO), t = Math.tan(RHO)
    for (const [f, w] of [[0.25, 6.620], [0.5, 4.540], [0.75, 2.270], [0.875, 1.150]] as const) {
      const bx = f * HLU * s + w * c
      const bz = f * HLU * c - w * s
      expect(bx - bz * t).toBeCloseTo(w / c, 9)
    }
  })

  it('scales the sigma with it, so the RELATIVE uncertainty is unchanged', () => {
    const plain = widthAt({ ...RYUJIN_JIB, luffRakeDeg: null }, 0.5)!
    const raked = widthAt(RYUJIN_JIB, 0.5)!
    expect(raked.sigmaM / raked.m).toBeCloseTo(plain.sigmaM / plain.m, 9)
  })

  it('is worth 2.8 % on Ryujin and 4.3 % on Northstar', () => {
    const pct = (deg: number) => (1 / Math.cos(deg * Math.PI / 180) - 1) * 100
    expect(pct(13.498)).toBeCloseTo(2.8, 1)
    expect(pct(16.83)).toBeCloseTo(4.5, 1)
    // The main's luff is the mast, and this is why it was right to ignore there.
    expect(pct(3)).toBeLessThan(0.2)
  })

  it('leaves a sail with no luff rake alone — the MAIN', () => {
    const main: SailWidths = { foot: 6.528, quarter: 5.510, half: 4.370, threeQuarter: 2.990, upper: 2.180 }
    const w = widthAt(main, 0.5)!
    expect(w.m).toBe(4.370)
    expect(w.note).not.toMatch(/luff rake/)
  })

  it('corrects an INTERPOLATED width too, not only the exact stations', () => {
    // A boat with no quarter girth interpolates the 25 % station, and that
    // interpolated width is just as perpendicular to the luff as a measured one.
    const noQuarter: SailWidths = { ...RYUJIN_JIB, quarter: null }
    const w = widthAt(noQuarter, 0.25)!
    expect(w.source).toBe('interpolated')
    expect(w.note).toMatch(/luff rake/)
    const plain = widthAt({ ...noQuarter, luffRakeDeg: null }, 0.25)!
    expect(w.m / plain.m).toBeCloseTo(1 / Math.cos(RHO), 9)
  })

  it('ignores a rake that cannot be one', () => {
    // A missing or absurd value must not silently scale every width by a
    // factor nobody chose; 60°+ is not a forestay.
    expect(widthAt({ ...RYUJIN_JIB, luffRakeDeg: 75 }, 0.5)!.m).toBe(4.540)
    expect(widthAt({ ...RYUJIN_JIB, luffRakeDeg: Number.NaN }, 0.5)!.m).toBe(4.540)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The merge has to let a NEW field through.
//
// mergeModels merged widths at the {main, jib} level, so a stored sail's widths
// object replaced the incoming one entire and any field the stored one predated
// was dropped — on every merge, for ever. Ryujin went in with no luffRakeDeg
// twice from a file that had it, because the first seed stored widths without
// the field and `--merge` then kept that object whole.
// ─────────────────────────────────────────────────────────────────────────────

import { mergeModels } from '../rigModelMerge'
import { defaultRigModel } from '../rigModel'

describe('mergeModels — widths', () => {
  const withJib = (jib: Record<string, unknown>) => ({
    ...defaultRigModel('Ryujin'),
    widths: { jib: jib as never, main: { foot: 6.528, half: 4.370 } as never },
  })

  it('takes a field the stored sail has never heard of', () => {
    const current = withJib({ foot: 8.52, half: 4.54 })                      // seeded before the field existed
    const incoming = withJib({ foot: 8.52, half: 4.54, luffRakeDeg: 13.498, quarter: 6.62 })
    const out = mergeModels(current, incoming)
    expect(out.widths!.jib!.luffRakeDeg).toBe(13.498)
    expect(out.widths!.jib!.quarter).toBe(6.62)
  })

  it('still lets the STORED number win where both have one', () => {
    // The stored value is the boat's own measurement; that rule is unchanged.
    const current = withJib({ foot: 8.52, half: 4.54 })
    const incoming = withJib({ foot: 8.52, half: 9.99 })
    expect(mergeModels(current, incoming).widths!.jib!.half).toBe(4.54)
  })

  it('treats an explicit null in the stored sail as an absence, not a measurement', () => {
    const current = withJib({ foot: 8.52, half: 4.54, quarter: null })
    const incoming = withJib({ foot: 8.52, half: 4.54, quarter: 6.62 })
    expect(mergeModels(current, incoming).widths!.jib!.quarter).toBe(6.62)
  })

  it('keeps a sail the incoming model does not mention', () => {
    const current = withJib({ foot: 8.52, half: 4.54 })
    const incoming = { ...defaultRigModel('Ryujin'), widths: { jib: undefined, main: undefined } }
    expect(mergeModels(current, incoming as never).widths!.jib!.half).toBe(4.54)
  })
})

import { describe, it, expect } from 'vitest'
import { barbParts, barbGeometry, barbSvg, kn1 } from '../windBarb'

describe('barbParts', () => {
  it('rounds to the nearest 5 kn, because a barb cannot say 7', () => {
    expect(barbParts(7).roundedKn).toBe(5)
    expect(barbParts(8).roundedKn).toBe(10)
    expect(barbParts(12.4).roundedKn).toBe(10)
    expect(barbParts(12.6).roundedKn).toBe(15)
  })

  it('feathers the standard way', () => {
    expect(barbParts(5)).toMatchObject({ pennants: 0, fulls: 0, halves: 1 })
    expect(barbParts(10)).toMatchObject({ pennants: 0, fulls: 1, halves: 0 })
    expect(barbParts(15)).toMatchObject({ pennants: 0, fulls: 1, halves: 1 })
    expect(barbParts(25)).toMatchObject({ pennants: 0, fulls: 2, halves: 1 })
    expect(barbParts(50)).toMatchObject({ pennants: 1, fulls: 0, halves: 0 })
    expect(barbParts(65)).toMatchObject({ pennants: 1, fulls: 1, halves: 1 })
    expect(barbParts(105)).toMatchObject({ pennants: 2, fulls: 0, halves: 1 })
  })

  it('always adds back up to the rounded speed', () => {
    for (let kn = 0; kn <= 120; kn += 0.5) {
      const p = barbParts(kn)
      expect(p.pennants * 50 + p.fulls * 10 + p.halves * 5).toBe(p.roundedKn)
    }
  })

  it('calls only a true zero calm — 2 kn is a bare shaft, not calm', () => {
    expect(barbParts(0).calm).toBe(true)
    expect(barbParts(2).calm).toBe(false)      // rounds to 0 feathers but is NOT calm
    expect(barbParts(2).roundedKn).toBe(0)
    expect(barbParts(5).calm).toBe(false)
  })

  it('treats junk as calm rather than drawing nonsense', () => {
    expect(barbParts(NaN).calm).toBe(true)
    expect(barbParts(-3).calm).toBe(true)
    expect(barbParts(Infinity).calm).toBe(true)
  })
})

describe('barbGeometry', () => {
  it('draws one stroke per feather, and fills pennants separately', () => {
    const g = barbGeometry(65)
    expect(g.pennants).toHaveLength(1)
    expect(g.strokes).toHaveLength(2)          // one full + one half
    expect(g.ring).toBe(false)
    expect(g.shaft).toContain('M22 22')        // starts at the station
  })

  it('moves a lone half barb off the tip', () => {
    // A 5 kn feather drawn at the very end of the shaft reads as a full barb
    // that was drawn short. It sits one step down instead.
    const g = barbGeometry(5)
    expect(g.strokes).toHaveLength(1)
    expect(g.strokes[0]).not.toContain('M22 6 ')
  })

  it('keeps every feather inside the viewBox', () => {
    // A feather that rises past y=0 is CLIPPED, and a clipped feather reads as
    // 10 kn that is not there. Caught exactly this way: the first full barb went
    // to y = -1.
    for (const kn of [5, 10, 15, 25, 35, 50, 65, 105]) {
      const g = barbGeometry(kn)
      const ys = [...g.strokes, ...g.pennants]
        .flatMap((d) => Array.from(d.matchAll(/-?\d+(?:\.\d+)?/g)).map(Number))
      for (const v of ys) expect(v).toBeGreaterThanOrEqual(0)
      for (const v of ys) expect(v).toBeLessThanOrEqual(44)
    }
  })

  it('is a ring when calm', () => {
    expect(barbGeometry(0).ring).toBe(true)
    expect(barbGeometry(0).strokes).toHaveLength(0)
  })
})

describe('barbSvg', () => {
  it('points the shaft at where the wind is FROM', () => {
    expect(barbSvg(15, 270, '#fff')).toContain('rotate(270 22 22)')
  })

  it('draws a RING when there is no direction, never a barb pointing north', () => {
    // A variable or calm wind has a speed but no direction. Rotating by a
    // defaulted 0 would draw a confident northerly that nobody measured.
    const svg = barbSvg(12, null, '#fff')
    expect(svg).toContain('<circle')
    expect(svg).not.toContain('rotate')
  })

  it('carries the colour and the age opacity through', () => {
    const svg = barbSvg(20, 180, '#22D3EE', 0.4)
    expect(svg).toContain('#22D3EE')
    expect(svg).toContain('opacity:0.4')
  })
})

describe('kn1', () => {
  it('always shows one decimal, as asked', () => {
    expect(kn1(7)).toBe('7.0')
    expect(kn1(12.34)).toBe('12.3')
    expect(kn1(0)).toBe('0.0')
  })
  it('says nothing rather than 0.0 when there is no value', () => {
    expect(kn1(null)).toBe('--')
    expect(kn1(undefined)).toBe('--')
    expect(kn1(NaN)).toBe('--')
  })
})

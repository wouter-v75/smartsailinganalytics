// Shape says which section, colour says which tack. These tests are about the shapes
// staying distinguishable: a plot where two sections look alike is a plot that misleads.
import { describe, it, expect } from 'vitest'
import { SECTION_SYMBOLS, symbolFor, symbolPath, symbolLabel } from '../phaseSymbols'

describe('symbolFor', () => {
  it('gives each section its own shape, in order', () => {
    expect(symbolFor(1)).toBe('circle')
    expect(symbolFor(2)).toBe('triangle')
    expect(symbolFor(3)).toBe('square')
    expect(new Set([1, 2, 3, 4, 5, 6].map(symbolFor)).size).toBe(6)
  })

  it('is a circle for a phase that belongs to no section — the plot’s old dot', () => {
    expect(symbolFor(null)).toBe('circle')
    expect(symbolFor(undefined)).toBe('circle')
    expect(symbolFor(0)).toBe('circle')
  })

  it('wraps rather than running out', () => {
    expect(symbolFor(SECTION_SYMBOLS.length + 1)).toBe(SECTION_SYMBOLS[0])
  })
})

describe('symbolPath', () => {
  it('draws every shape as a closed path', () => {
    for (const kind of SECTION_SYMBOLS) {
      const d = symbolPath(kind, 50, 40, 4)
      expect(d.startsWith('M')).toBe(true)
      expect(d.trim().endsWith('Z')).toBe(true)
      expect(d).not.toMatch(/NaN/)
    }
  })

  it('draws them differently — the whole point of using shapes', () => {
    const paths = SECTION_SYMBOLS.map(k => symbolPath(k, 50, 40, 4))
    expect(new Set(paths).size).toBe(SECTION_SYMBOLS.length)
  })

  it('centres each shape on the point it marks', () => {
    // Only the ABSOLUTE points are checked: the circle is drawn with two relative arcs,
    // whose numbers are offsets rather than positions.
    const absolutePoints = (d: string): [number, number][] =>
      Array.from(d.matchAll(/[ML](-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)).map(mm => [Number(mm[1]), Number(mm[2])])
    for (const kind of SECTION_SYMBOLS) {
      for (const [x, y] of absolutePoints(symbolPath(kind, 100, 60, 4))) {
        expect(Math.abs(x - 100)).toBeLessThan(12)
        expect(Math.abs(y - 60)).toBeLessThan(12)
      }
    }
  })

  it('grows with the radius it is given', () => {
    const small = symbolPath('square', 0, 0, 2), big = symbolPath('square', 0, 0, 8)
    expect(small).not.toBe(big)
  })

  it('has a name for every shape, for the legend', () => {
    for (const kind of SECTION_SYMBOLS) expect(symbolLabel[kind]).toBeTruthy()
  })
})

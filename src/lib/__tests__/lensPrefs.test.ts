// src/lib/__tests__/lensPrefs.test.ts
import { describe, it, expect } from 'vitest'
import { lensLabel, rememberIn, coerceLenses, MAX_LENSES, type Lens } from '../lensPrefs'

const lens = (label: string, focalMm: number, lastUsed = 1): Lens => ({ label, focalMm, lastUsed })

describe('lensLabel', () => {
  it('names the camera and the lens with the length', () => {
    expect(lensLabel('Canon EOS R5', 'RF100-500mm F4.5-7.1 L IS USM', 254))
      .toBe('Canon EOS R5 · RF100-500mm F4.5-7.1 L IS USM · 254 mm')
  })

  it('does not stutter when the lens name already contains the body', () => {
    // A phone reports both, and "iPhone 15 Pro · iPhone 15 Pro back camera"
    // reads as a mistake in a dropdown.
    expect(lensLabel('iPhone 15 Pro', 'iPhone 15 Pro back triple camera 6.86mm f/1.78', 7))
      .toBe('iPhone 15 Pro back triple camera 6.86mm f/1.78 · 7 mm')
  })

  it('falls back through whatever EXIF actually had', () => {
    expect(lensLabel('Canon EOS R5', null, 254)).toBe('Canon EOS R5 · 254 mm')
    expect(lensLabel(null, null, 254)).toBe('254 mm')
    expect(lensLabel(null, null, null)).toBe('unnamed lens')
    expect(lensLabel('  ', '  ', null)).toBe('unnamed lens')
  })

  it('rounds the length, since EXIF gives fractions nobody wants to read', () => {
    expect(lensLabel('X', null, 253.6)).toBe('X · 254 mm')
  })
})

describe('rememberIn', () => {
  it('puts the lens just used at the front', () => {
    const out = rememberIn([lens('A', 100, 1), lens('B', 200, 2)], lens('C', 300, 3))
    expect(out.map((l) => l.label)).toEqual(['C', 'B', 'A'])
  })

  it('moves an existing lens up rather than duplicating it', () => {
    const out = rememberIn([lens('A', 100, 1), lens('B', 200, 2)], lens('A', 100, 9))
    expect(out.map((l) => l.label)).toEqual(['A', 'B'])
    expect(out).toHaveLength(2)
  })

  it('keeps a ZOOM at each length it is used at', () => {
    // The thing being picked is a focal length, not a piece of glass — a
    // 100-500 at 254 and at 400 are two different answers to the question.
    const out = rememberIn([lens('RF100-500 · 254 mm', 254, 1)], lens('RF100-500 · 400 mm', 400, 2))
    expect(out).toHaveLength(2)
  })

  it('is case- and space-insensitive about the same lens', () => {
    const out = rememberIn([lens('Canon EOS R5', 254, 1)], lens(' canon eos r5 ', 254, 2))
    expect(out).toHaveLength(1)
    expect(out[0].lastUsed).toBe(2)
  })

  it('refuses a length that is not one', () => {
    const before = [lens('A', 100, 1)]
    expect(rememberIn(before, lens('B', 0, 2))).toBe(before)
    expect(rememberIn(before, lens('B', -5, 2))).toBe(before)
    expect(rememberIn(before, lens('B', NaN, 2))).toBe(before)
  })

  it('caps the list, dropping the least recently used', () => {
    let list: Lens[] = []
    for (let i = 0; i < MAX_LENSES + 5; i++) list = rememberIn(list, lens(`L${i}`, 100 + i, i))
    expect(list).toHaveLength(MAX_LENSES)
    expect(list[0].label).toBe(`L${MAX_LENSES + 4}`)
    expect(list.some((l) => l.label === 'L0')).toBe(false)
  })
})

describe('coerceLenses — a stored preference is not a promise', () => {
  it('reads back what was written', () => {
    expect(coerceLenses([{ label: 'A', focalMm: 254, lastUsed: 5 }])).toEqual([{ label: 'A', focalMm: 254, lastUsed: 5 }])
  })

  it('shrugs off anything else rather than taking the tool down', () => {
    // Not remembering a lens is a nuisance; failing to open the frame is not.
    expect(coerceLenses(null)).toEqual([])
    expect(coerceLenses('nonsense')).toEqual([])
    expect(coerceLenses([{ label: 'A' }, { focalMm: 5 }, null, 7])).toEqual([])
    expect(coerceLenses([{ label: 'A', focalMm: 0, lastUsed: 1 }])).toEqual([])
  })

  it('orders newest first and caps, whatever order it was stored in', () => {
    const many = Array.from({ length: MAX_LENSES + 3 }, (_, i) => ({ label: `L${i}`, focalMm: 50 + i, lastUsed: i }))
    const out = coerceLenses(many)
    expect(out).toHaveLength(MAX_LENSES)
    expect(out[0].label).toBe(`L${MAX_LENSES + 2}`)
  })

  it('treats a missing lastUsed as oldest rather than dropping the lens', () => {
    const out = coerceLenses([{ label: 'A', focalMm: 254 }, { label: 'B', focalMm: 100, lastUsed: 9 }])
    expect(out.map((l) => l.label)).toEqual(['B', 'A'])
  })
})

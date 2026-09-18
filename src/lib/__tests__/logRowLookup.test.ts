import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain-JS module, no d.ts
import { nearestRow, interpRow } from '../logRowLookup'

// The video overlay reads the instrument log through these two. nearestRow
// snaps to a sample; interpRow smooths between them so the numbers do not
// visibly step at the ~1 Hz log rate.

const T = Date.parse('2026-09-11T11:00:00Z')
const rows = [
  { utc: T,         bsp: 8,  twa: 40, sail: 'J1' },
  { utc: T + 1000,  bsp: 10, twa: 50, sail: 'J2' },
  { utc: T + 2000,  bsp: 12, twa: 60, sail: 'J2' },
]

describe('nearestRow', () => {
  it('returns the sample on either side of the midpoint, not an average', () => {
    expect(nearestRow(rows, T + 400)).toBe(rows[0])
    expect(nearestRow(rows, T + 600)).toBe(rows[1])
  })

  it('hits exact sample times and both ends', () => {
    expect(nearestRow(rows, T)).toBe(rows[0])
    expect(nearestRow(rows, T + 1000)).toBe(rows[1])
    expect(nearestRow(rows, T + 2000)).toBe(rows[2])
  })

  it('gives up beyond five minutes rather than showing a stale reading', () => {
    // A clip recorded outside the logged window must show "--", not the last
    // row of a session that ended hours earlier.
    // measured from the LAST row (T+2000), not from T
    expect(nearestRow(rows, T + 2000 + 5 * 60000 - 1)).toBe(rows[2])
    expect(nearestRow(rows, T + 2000 + 5 * 60000 + 1)).toBeNull()
    expect(nearestRow(rows, T - 5 * 60000 - 1)).toBeNull()
  })

  it('handles an empty or missing log', () => {
    expect(nearestRow([], T)).toBeNull()
    expect(nearestRow(null, T)).toBeNull()
  })
})

describe('interpRow', () => {
  it('interpolates numeric channels linearly between samples', () => {
    const r = interpRow(rows, T + 500)
    expect(r.bsp).toBeCloseTo(9, 9)
    expect(r.twa).toBeCloseTo(45, 9)
    expect(r.utc).toBeCloseTo(T + 500, 9)
  })

  it('snaps non-numeric channels to the nearer sample instead of blending them', () => {
    // A sail name has no midpoint — halfway through a change it must read as
    // one sail or the other.
    expect(interpRow(rows, T + 400).sail).toBe('J1')
    expect(interpRow(rows, T + 600).sail).toBe('J2')
  })

  it('returns the end samples unchanged outside the log, within tolerance', () => {
    expect(interpRow(rows, T - 1000)).toBe(rows[0])
    expect(interpRow(rows, T + 3000)).toBe(rows[2])
  })

  it('applies the same five-minute cut-off as nearestRow', () => {
    expect(interpRow(rows, T + 2000 + 5 * 60000 + 1)).toBeNull()
    expect(interpRow(rows, T - 5 * 60000 - 1)).toBeNull()
  })

  it('does not divide by zero on duplicate timestamps', () => {
    const dup = [{ utc: T, bsp: 8 }, { utc: T, bsp: 9 }, { utc: T + 1000, bsp: 10 }]
    expect(() => interpRow(dup, T + 500)).not.toThrow()
    expect(Number.isFinite(interpRow(dup, T + 500).bsp)).toBe(true)
  })

  it('handles an empty or missing log', () => {
    expect(interpRow([], T)).toBeNull()
    expect(interpRow(null, T)).toBeNull()
  })
})

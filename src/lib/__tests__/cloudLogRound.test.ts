// A day's positions rounded to 2 dp land on a kilometre grid, and the track redraws
// itself as a staircase. These tests are that regression, written down.
import { describe, it, expect } from 'vitest'
import { roundForCloud, slimRowForCloud, CLOUD_DP } from '../cloudLogRound'

describe('roundForCloud', () => {
  it('keeps position to about a metre', () => {
    expect(CLOUD_DP.lat).toBe(5)
    expect(roundForCloud('lat', 41.1543219)).toBe(41.15432)
    expect(roundForCloud('lon', 9.5987654)).toBe(9.59877)
  })

  it('does not put a day of sailing on a kilometre grid', () => {
    // 0.01° of latitude is ~1.1 km: two fixes a boat length apart must not collapse.
    const a = roundForCloud('lat', 41.154321) as number
    const b = roundForCloud('lat', 41.154500) as number
    expect(a).not.toBe(b)
  })

  it('still rounds instrument channels to 2 dp — they mean nothing past that', () => {
    expect(roundForCloud('bsp', 9.100000000000001)).toBe(9.1)
    expect(roundForCloud('tws', 12.3456)).toBe(12.35)
    expect(roundForCloud('heel', -20.987)).toBe(-20.99)
  })

  it('leaves integers, timestamps and non-numbers alone', () => {
    expect(roundForCloud('utc', 1789120800000)).toBe(1789120800000)
    expect(roundForCloud('sails', 'J4_A 2026')).toBe('J4_A 2026')
    expect(roundForCloud('bsp', null)).toBeNull()
    expect(roundForCloud('bsp', NaN)).toBeNaN()
  })
})

describe('slimRowForCloud', () => {
  const row = { utc: 1789120800000, lat: 41.1543219, lon: 9.5987654, bsp: 9.100000000000001, vang: null, junk: 5 }

  it('keeps only the named columns, each at its own precision', () => {
    expect(slimRowForCloud(row, ['utc', 'lat', 'lon', 'bsp', 'vang', 'junk'])).toEqual({
      utc: 1789120800000, lat: 41.15432, lon: 9.59877, bsp: 9.1, junk: 5,
    })
  })

  it('drops a column that is null in this row rather than writing null', () => {
    expect('vang' in slimRowForCloud(row, ['vang'])).toBe(false)
  })
})

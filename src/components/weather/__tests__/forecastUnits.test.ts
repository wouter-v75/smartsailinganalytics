// Temperature units on the forecast deck.
//
// The trap worth a test is the ROUNDING. Convert a value that has already been
// rounded for display and the two printed figures stop describing the same
// temperature: 12.3 °C is 54 °F, but the displayed "12 °C" converts to 54 (53.6
// rounds to 54) and 12.4 -> 54 °F while 12.6 -> 55 — so both must be rounded
// from the ORIGINAL, never one from the other.

import { describe, expect, it } from 'vitest'
import { FAHRENHEIT_VENUES, tempUnitFor, cToF, fmtTemp } from '../forecastUnits'

describe('tempUnitFor', () => {
  it('gives San Juan Fahrenheit', () => {
    expect(tempUnitFor('san-juan')).toBe('F')
  })

  it('leaves every other venue metric', () => {
    for (const v of ['porto-cervo', 'st-tropez', 'sorrento', 'solent', 'oslofjord', 'long-beach']) {
      expect(tempUnitFor(v), v).toBe('C')
    }
  })

  it('defaults to metric with no venue at all', () => {
    expect(tempUnitFor(null)).toBe('C')
    expect(tempUnitFor(undefined)).toBe('C')
    expect(tempUnitFor('')).toBe('C')
  })

  it('declares Long Beach is deliberately absent, not forgotten', () => {
    // Recorded so a later reader does not "fix" it by accident: the other US
    // venue was not asked for, and adding it is one entry.
    expect(FAHRENHEIT_VENUES).toEqual(['san-juan'])
  })
})

describe('cToF', () => {
  it('has the right fixed points', () => {
    expect(cToF(0)).toBe(32)
    expect(cToF(100)).toBe(212)
    expect(cToF(-40)).toBe(-40)
  })
})

describe('fmtTemp', () => {
  it('prints Celsius alone, exactly as the deck always has', () => {
    expect(fmtTemp(12.3, 'C')).toBe('12 °C')
    expect(fmtTemp(16.8, 'C')).toBe('17 °C')
  })

  it('leads with Fahrenheit and keeps Celsius in brackets', () => {
    expect(fmtTemp(12.3, 'F')).toBe('54 °F (12 °C)')
    expect(fmtTemp(0, 'F')).toBe('32 °F (0 °C)')
  })

  it('rounds each figure from the ORIGINAL, not from the other', () => {
    // 12.4 °C -> 54.32 °F -> 54; rounding 12.4 to 12 first gives 53.6 -> 54
    // here, but 12.6 -> 54.68 -> 55 while a pre-rounded 13 gives 55.4 -> 55.
    // The case that separates them: 17.5 °C is 63.5 °F -> 64, where a
    // pre-rounded 18 °C would give 64.4 -> 64 and a pre-rounded 17 gives 63.
    expect(fmtTemp(17.5, 'F')).toBe('64 °F (18 °C)')
    expect(fmtTemp(17.4, 'F')).toBe('63 °F (17 °C)')
  })

  it('defaults to Celsius when no unit is given', () => {
    expect(fmtTemp(9.2)).toBe('9 °C')
  })

  it('returns null for an absent or broken reading, never "NaN °F"', () => {
    expect(fmtTemp(null, 'F')).toBeNull()
    expect(fmtTemp(undefined, 'F')).toBeNull()
    expect(fmtTemp(Number.NaN, 'F')).toBeNull()
    expect(fmtTemp(Number.POSITIVE_INFINITY, 'C')).toBeNull()
  })

  it('handles a cold morning without a sign bug', () => {
    expect(fmtTemp(-3.2, 'F')).toBe('26 °F (-3 °C)')
  })
})

import { describe, it, expect } from 'vitest'
import { pctColour, pctBg, isPctScaleKey, PCT_STOPS } from '../pctScale'

const DARK_RED = '#7f1d1d'
const RED = '#dc2626'
const YELLOW = '#facc15'
const LIGHT_GREEN = '#86efac'
const GREEN = '#22c55e'
const DARK_GREEN = '#15803d'

const at = (v: number) => (pctColour(v) || '').toLowerCase()

describe('the stops are the ones that were asked for', () => {
  it('lands exactly on each named colour at its own number', () => {
    expect(at(85)).toBe(DARK_RED)
    expect(at(90)).toBe(RED)
    expect(at(95)).toBe(YELLOW)
    expect(at(97.5)).toBe(LIGHT_GREEN)
    expect(at(102.5)).toBe(LIGHT_GREEN)
    expect(at(105)).toBe(GREEN)
    expect(at(110)).toBe(DARK_GREEN)
  })

  it('clamps outside the ends rather than running off the scale', () => {
    // A boat at 40 % of polar is a broken log row, not a colour nobody has seen.
    expect(at(84)).toBe(DARK_RED)
    expect(at(40)).toBe(DARK_RED)
    expect(at(0)).toBe(DARK_RED)
    expect(at(140)).toBe(DARK_GREEN)
  })

  it('holds ONE colour across the plateau either side of 100', () => {
    // The point of the plateau: ordinary variation around the target must not
    // shimmer through three colours and suggest something is happening.
    for (const v of [97.5, 98, 99, 100, 101, 102, 102.5]) {
      expect(at(v), `at ${v}`).toBe(LIGHT_GREEN)
    }
  })
})

describe('it is a scale, not steps', () => {
  it('interpolates between stops', () => {
    // 92.5 is halfway from red to yellow and must be neither.
    const mid = at(92.5)
    expect(mid).not.toBe(RED)
    expect(mid).not.toBe(YELLOW)
    expect(mid).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('moves monotonically towards green as the number rises', () => {
    // Red falls and green rises across the whole run — so a column of numbers
    // reads as a direction without anybody parsing the digits.
    const greenOf = (v: number) => parseInt(at(v).slice(3, 5), 16)
    const vals = [85, 88, 90, 92, 95, 96, 97.5]
    for (let i = 1; i < vals.length; i++) {
      expect(greenOf(vals[i]), `${vals[i]} vs ${vals[i - 1]}`).toBeGreaterThanOrEqual(greenOf(vals[i - 1]))
    }
  })

  it('fills the 95 to 97.5 gap that the stops did not name', () => {
    const v = at(96)
    expect(v).not.toBe(YELLOW)
    expect(v).not.toBe(LIGHT_GREEN)
  })
})

describe('nothing is painted that should not be', () => {
  it('returns nothing for a missing or unusable value', () => {
    expect(pctColour(null)).toBeNull()
    expect(pctColour(undefined)).toBeNull()
    expect(pctColour(NaN)).toBeNull()
    expect(pctBg(null)).toBe('transparent')
    expect(pctBg(undefined)).toBe('transparent')
  })

  it('paints the target family and NOTHING else', () => {
    for (const k of ['vmgPct', 'bspPol', 'bspTrgPct', 'logPolPct', 'logTrgPct']) {
      expect(isPctScaleKey(k), k).toBe(true)
    }
    // These are percentages of something that is not a target. Painting 92 of
    // them amber would say the boat was slow when it was not.
    for (const k of ['upDflct', 'lwDflct', 'bspSog', 'tws', 'bsp', 'heel']) {
      expect(isPctScaleKey(k), k).toBe(false)
    }
  })
})

describe('the background stays readable, and keeps its order of weight', () => {
  it('is an rgba wash, not the solid colour', () => {
    expect(pctBg(100)).toMatch(/^rgba\(\d+, \d+, \d+, 0\.\d+\)$/)
  })

  it('gives the extremes MORE weight, not less', () => {
    // On a dark UI a dark fill recedes, so at a constant alpha the two ends —
    // the two a trimmer most needs to catch out of the corner of an eye — would
    // be the faintest cells on the table.
    const alpha = (s: string) => Number(s.match(/, (0\.\d+)\)$/)?.[1])
    expect(alpha(pctBg(80))).toBeGreaterThan(alpha(pctBg(100)))
    expect(alpha(pctBg(120))).toBeGreaterThan(alpha(pctBg(100)))
    expect(alpha(pctBg(100))).toBeGreaterThan(0.25)
  })

  it('never goes opaque enough to hide the number', () => {
    for (const v of [0, 60, 85, 100, 115, 200]) {
      const a = Number(pctBg(v).match(/, (0\.\d+)\)$/)?.[1])
      expect(a, `at ${v}`).toBeLessThanOrEqual(0.7)
    }
  })
})

describe('the stop table itself', () => {
  it('is sorted, so the interpolation can walk it', () => {
    for (let i = 1; i < PCT_STOPS.length; i++) {
      expect(PCT_STOPS[i].pct).toBeGreaterThan(PCT_STOPS[i - 1].pct)
    }
  })
})

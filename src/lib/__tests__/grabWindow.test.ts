import { describe, it, expect } from 'vitest'
import {
  grabWindow, sectionFromMarks, GRAB_LEAD_MS, MIN_SECTION_MS,
} from '../tagging/grabWindow'

const T = Date.UTC(2026, 8, 26, 10, 25, 0)

describe('grabWindow', () => {
  it('reads a plain press as a MOMENT, with the lead taken back off', () => {
    // What the button stores: 30 s either side of the press.
    const w = grabWindow({ t0: T - GRAB_LEAD_MS, t1: T + GRAB_LEAD_MS })
    expect(w.kind).toBe('moment')
    expect(w.at).toBe(T)
  })

  it('a span of exactly 2x the lead is the BUTTON, not a choice', () => {
    // The boundary is the whole rule. One second either way of it decides
    // whether ~150 stored presses are cut as padded moments that merge, or as
    // 150 fixed 60 s clips that do not.
    const exact = grabWindow({ t0: T, t1: T + 2 * GRAB_LEAD_MS })
    expect(exact.kind).toBe('moment')

    const longer = grabWindow({ t0: T, t1: T + 2 * GRAB_LEAD_MS + 1 })
    expect(longer.kind).toBe('section')
  })

  it('reads a marked window as a SECTION, exactly as marked', () => {
    const to = T + 3 * 60_000
    const w = grabWindow({ t0: T, t1: to })
    expect(w).toEqual({ kind: 'section', from: T, to })
  })

  it('a row with no t1 is a moment — every tag stored before windows existed', () => {
    expect(grabWindow({ t0: T - GRAB_LEAD_MS, t1: null }).kind).toBe('moment')
    expect(grabWindow({ t0: T - GRAB_LEAD_MS }).at).toBe(T)
  })

  it('a point tag written t1 = t0 is a moment', () => {
    expect(grabWindow({ t0: T, t1: T }).kind).toBe('moment')
  })

  it('honours a different lead, for a definition whose lead is changed', () => {
    // 60 s lead => a press spans 120 s, so 90 s is still the button's own.
    expect(grabWindow({ t0: T, t1: T + 90_000 }, 60_000).kind).toBe('moment')
    expect(grabWindow({ t0: T, t1: T + 150_000 }, 60_000).kind).toBe('section')
  })
})

describe('sectionFromMarks', () => {
  it('takes the two marks in the order they were watched', () => {
    expect(sectionFromMarks(T, T + 40_000)).toEqual({ from: T, to: T + 40_000 })
  })

  it('sorts a reversed pair — an out before an in is a change of mind', () => {
    expect(sectionFromMarks(T + 40_000, T)).toEqual({ from: T, to: T + 40_000 })
  })

  it('refuses a double press', () => {
    expect(sectionFromMarks(T, T + MIN_SECTION_MS - 1)).toBeNull()
    expect(sectionFromMarks(T, T)).toBeNull()
  })

  it('refuses marks it cannot read, rather than cutting from NaN', () => {
    expect(sectionFromMarks(NaN, T)).toBeNull()
    expect(sectionFromMarks(T, NaN)).toBeNull()
  })
})

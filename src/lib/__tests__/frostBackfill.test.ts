// A month-span generator that drops a month leaves a gap nobody sees: the
// import reports a cheerful row count and the hole surfaces a year later, when
// a correction is fitted on it.

import { describe, expect, it } from 'vitest'
import { monthSpans, onTheHour } from '../frostBackfill'
import type { WindObs } from '../windObs'

describe('monthSpans', () => {
  it('covers whole months back to back with no gap and no overlap', () => {
    const s = monthSpans('2026-01-01', '2026-04-01')
    expect(s).toEqual([
      ['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'],
      ['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'],
      ['2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'],
    ])
  })

  it('trims the first span to `from` instead of reaching back to the 1st', () => {
    // Asking for data before the window would be wrong in the expensive
    // direction: it is extra requests AND rows outside what was asked for.
    const s = monthSpans('2026-01-15', '2026-03-01')
    expect(s[0]).toEqual(['2026-01-15T00:00:00.000Z', '2026-02-01T00:00:00.000Z'])
  })

  it('trims the last span to `to`', () => {
    const s = monthSpans('2026-01-01', '2026-02-10')
    expect(s[s.length - 1]).toEqual(['2026-02-01T00:00:00.000Z', '2026-02-10T00:00:00.000Z'])
  })

  it('steps correctly from a 31st — the classic setUTCMonth trap', () => {
    // Stepping one month from 31 Jan lands on 2 or 3 March, skipping February
    // entirely. Normalising to the 1st before stepping is what prevents it.
    const s = monthSpans('2026-01-31', '2026-04-01')
    const starts = s.map(([a]) => a.slice(0, 10))
    expect(starts).toEqual(['2026-01-31', '2026-02-01', '2026-03-01'])
    // February must be present and a full month long.
    expect(s[1]).toEqual(['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'])
  })

  it('crosses a year boundary', () => {
    const s = monthSpans('2025-11-01', '2026-02-01')
    expect(s.map(([a]) => a.slice(0, 7))).toEqual(['2025-11', '2025-12', '2026-01'])
  })

  it('crosses a leap day without losing or duplicating a span', () => {
    const s = monthSpans('2028-02-01', '2028-04-01')
    expect(s).toEqual([
      ['2028-02-01T00:00:00.000Z', '2028-03-01T00:00:00.000Z'],
      ['2028-03-01T00:00:00.000Z', '2028-04-01T00:00:00.000Z'],
    ])
  })

  it('spans the real record depth without a hole', () => {
    // Strømtangen fyr serves hourly wind from 1994-05-09. 32 years of it is
    // the --from 1994-01-01 case, and every span must be contiguous.
    const s = monthSpans('1994-05-09', '2026-10-26')
    expect(s.length).toBeGreaterThan(380)
    for (let i = 1; i < s.length; i++) expect(s[i][0]).toBe(s[i - 1][1])
    expect(s[0][0]).toBe('1994-05-09T00:00:00.000Z')
    expect(s[s.length - 1][1]).toBe('2026-10-26T00:00:00.000Z')
  })

  it('returns nothing for an empty or inverted window', () => {
    expect(monthSpans('2026-03-01', '2026-03-01')).toEqual([])
    expect(monthSpans('2026-04-01', '2026-01-01')).toEqual([])
    expect(monthSpans('nonsense', '2026-01-01')).toEqual([])
  })
})

describe('onTheHour', () => {
  const o = (t: string) => ({ id: 'frost:SN30235', t } as WindObs)

  it('keeps the hourly readings out of a ten-minute series', () => {
    const kept = onTheHour([
      o('2026-10-25T06:00:00.000Z'),
      o('2026-10-25T06:10:00.000Z'),
      o('2026-10-25T06:20:00.000Z'),
      o('2026-10-25T07:00:00.000Z'),
    ])
    expect(kept.map((x) => x.t)).toEqual(['2026-10-25T06:00:00.000Z', '2026-10-25T07:00:00.000Z'])
  })

  it('does not mistake 10:00 past the hour for the hour', () => {
    // The slice is minutes+seconds, so an hour of 10 must not match on "10".
    expect(onTheHour([o('2026-10-25T10:10:00.000Z')])).toEqual([])
    expect(onTheHour([o('2026-10-25T10:00:00.000Z')])).toHaveLength(1)
  })

  it('survives a row with no timestamp', () => {
    expect(onTheHour([{ id: 'x' } as WindObs])).toEqual([])
  })
})

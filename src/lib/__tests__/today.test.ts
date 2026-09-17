import { describe, it, expect, vi, afterEach } from 'vitest'
import { todayIso, localToday, venueToday } from '../today'

afterEach(() => vi.useRealTimers())

describe('todayIso', () => {
  it('is the UTC date', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-17T23:30:00Z'))
    expect(todayIso()).toBe('2026-09-17')
  })

  it('still reads as the previous day just after local midnight in the Med — the\n     known UTC-vs-local gap the helper documents', () => {
    vi.useFakeTimers()
    // 01:00 on the 18th in La Spezia (UTC+2) is 23:00 on the 17th in UTC.
    vi.setSystemTime(new Date('2026-09-17T23:00:00Z'))
    expect(todayIso()).toBe('2026-09-17')
  })
})

describe('localToday', () => {
  it('pads month and day to two digits', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 5, 12, 0, 0)) // 5 Jan, local
    expect(localToday()).toBe('2026-01-05')
  })

  it('agrees with todayIso at midday UTC, when no offset can straddle a date', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'))
    expect(localToday()).toBe(todayIso())
  })
})

describe('venueToday', () => {
  it('is the venue’s date, not the viewer’s', () => {
    vi.useFakeTimers()
    // 20:30 UTC. In Auckland (+13) it is already 09:30 the NEXT day — the case
    // where a UTC "today" put a morning session on the previous day.
    vi.setSystemTime(new Date('2026-09-17T20:30:00Z'))
    expect(venueToday(13 * 60)).toBe('2026-09-18')
    expect(todayIso()).toBe('2026-09-17')
  })

  it('handles the Med crew sailing past local midnight', () => {
    vi.useFakeTimers()
    // 23:00 UTC = 01:00 on the 18th in La Spezia (+2).
    vi.setSystemTime(new Date('2026-09-17T23:00:00Z'))
    expect(venueToday(120)).toBe('2026-09-18')
    expect(todayIso()).toBe('2026-09-17')
  })

  it('handles a venue west of UTC', () => {
    vi.useFakeTimers()
    // 02:00 UTC = 22:00 on the 16th in Newport (-4).
    vi.setSystemTime(new Date('2026-09-17T02:00:00Z'))
    expect(venueToday(-4 * 60)).toBe('2026-09-16')
  })

  it('agrees with UTC at a venue on UTC', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-17T23:00:00Z'))
    expect(venueToday(0)).toBe(todayIso())
  })

  it('falls back to the device date when no session fixes a venue', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'))
    for (const v of [null, undefined, NaN, Infinity, 'x' as unknown as number]) {
      expect(venueToday(v as number)).toBe(localToday())
    }
  })
})

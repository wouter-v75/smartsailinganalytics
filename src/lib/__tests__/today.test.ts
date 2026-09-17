import { describe, it, expect, vi, afterEach } from 'vitest'
import { todayIso, localToday } from '../today'

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

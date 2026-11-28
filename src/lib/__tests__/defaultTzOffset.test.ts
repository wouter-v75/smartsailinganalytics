// The venue offset to assume when a session carries none.
//
// This existed as `DEFAULT_TZ = 120` — CEST, the SUMMER offset, applied all
// year. On 28 Nov 2026 clips stamped 12:00 and 12:15 in their filenames showed
// as 13:00 and 13:15 in both the Videos tab and the Timeline. Both tabs
// agreeing is what made it read as a convention rather than a fault.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { defaultTzOffsetMin } from '../defaultTzOffset'

/**
 * Pretend the machine is in a given zone, by stubbing the one method the
 * module uses. Real zone switching is not available inside a test process, and
 * what matters is the SIGN CONVENTION and that the DATE is what gets asked
 * about — both of which this pins exactly.
 */
function inZone(offsetsByMonth: Record<number, number>) {
  const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset')
  spy.mockImplementation(function (this: Date) {
    return offsetsByMonth[this.getUTCMonth() + 1] ?? 0
  })
  return spy
}

afterEach(() => { vi.restoreAllMocks() })

describe('defaultTzOffsetMin', () => {
  it('flips the sign of getTimezoneOffset — east of UTC is POSITIVE here', () => {
    // getTimezoneOffset returns minutes to ADD to local to reach UTC, so UTC+2
    // is −120. The app's tz_offset_minutes is east-positive, matching the
    // TZ_OPTIONS labels. Getting this backwards would move a clip FOUR hours.
    inZone({ 7: -120 })
    expect(defaultTzOffsetMin('2026-07-15')).toBe(120)
  })

  it('answers for the SESSION\'S date, not for today — which is the whole bug', () => {
    // Central Europe: CEST (+2) in July, CET (+1) in November. A constant
    // cannot express that, and the one that was there asserted summer.
    inZone({ 7: -120, 11: -60 })
    expect(defaultTzOffsetMin('2026-07-15')).toBe(120)
    expect(defaultTzOffsetMin('2026-11-27')).toBe(60)
  })

  it('gives a UK November day +0, where the old constant gave +2', () => {
    // The two-hour case. CLAUDE.md already warns about it for drone:coverage:
    // "the venue is not always the Med."
    inZone({ 11: 0, 7: -60 })
    expect(defaultTzOffsetMin('2026-11-27')).toBe(0)
    expect(defaultTzOffsetMin('2026-07-15')).toBe(60)   // BST
  })

  it('probes NOON, so a 01:00 DST change cannot land on the wrong side', () => {
    // Asked at midnight local, a date on a transition day can read as the
    // previous offset. Noon UTC is also inside the intended calendar day for
    // any venue within twelve hours of UTC.
    const spy = inZone({ 10: -120 })
    defaultTzOffsetMin('2026-10-25')
    const asked = spy.mock.instances[0] as unknown as Date
    expect(asked.getUTCHours()).toBe(12)
  })

  it('falls back to now when there is no date, for the Upload tab selectors', () => {
    inZone({ 1: -60, 2: -60, 3: -60, 4: -120, 5: -120, 6: -120, 7: -120,
             8: -120, 9: -120, 10: -120, 11: -60, 12: -60 })
    expect(typeof defaultTzOffsetMin()).toBe('number')
    expect(defaultTzOffsetMin(null)).toBe(defaultTzOffsetMin())
  })

  it('refuses a nonsense date rather than inventing an offset for it', () => {
    inZone({ 1: -60, 2: -60, 3: -60, 4: -60, 5: -60, 6: -60, 7: -60,
             8: -60, 9: -60, 10: -60, 11: -60, 12: -60 })
    // Not a date → treated as "no date", i.e. today, never as +2.
    expect(defaultTzOffsetMin('not-a-date')).toBe(60)
    expect(defaultTzOffsetMin('2026-13-45')).toBe(60)
  })

  it('answers UTC — never +2 — if the environment has no usable clock', () => {
    const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset')
    spy.mockReturnValue(NaN)
    expect(defaultTzOffsetMin('2026-11-27')).toBe(0)
    spy.mockReturnValue(-20 * 60)        // beyond any real zone
    expect(defaultTzOffsetMin('2026-11-27')).toBe(0)
  })
})

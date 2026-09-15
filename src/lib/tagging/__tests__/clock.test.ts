import { describe, it, expect } from 'vitest'
import {
  sessionClock, sessionClockHm, parseSessionClock, nudge, driftLabel, NUDGES,
} from '../clock'

const U = (iso: string) => Date.parse(iso)

describe('sessionClock', () => {
  it('shows the venue clock, not UTC', () => {
    expect(sessionClock(U('2026-09-11T11:04:07Z'), 120)).toBe('13:04:07')
  })

  it('handles a negative offset', () => {
    expect(sessionClock(U('2026-09-11T02:30:00Z'), -300)).toBe('21:30:00')
  })

  it('says so rather than printing a fake time for a missing instant', () => {
    expect(sessionClock(NaN, 120)).toBe('--:--:--')
  })

  it('hm drops the seconds', () => {
    expect(sessionClockHm(U('2026-09-11T11:04:07Z'), 120)).toBe('13:04')
  })
})

describe('parseSessionClock', () => {
  const anchor = U('2026-09-11T11:04:07Z') // 13:04:07 at +120

  it('reads a typed time back as an instant on the session clock', () => {
    expect(parseSessionClock('13:02:00', anchor, 120)).toBe(U('2026-09-11T11:02:00Z'))
  })

  it('accepts HH:MM without seconds', () => {
    expect(parseSessionClock('13:02', anchor, 120)).toBe(U('2026-09-11T11:02:00Z'))
  })

  it('round-trips whatever sessionClock rendered', () => {
    const t = U('2026-09-11T14:37:29Z')
    for (const tz of [0, 120, -300, 660]) {
      expect(parseSessionClock(sessionClock(t, tz), t, tz)).toBe(t)
    }
  })

  it('rejects nonsense instead of moving the tag to midnight', () => {
    for (const bad of ['', '13', 'abc', '25:00:00', '12:60', '12:00:61', '1:2:3']) {
      expect(parseSessionClock(bad, anchor, 120)).toBeNull()
    }
  })

  it('takes the nearer day when the session runs through local midnight', () => {
    // 00:20 local, and the crew corrects it to 23:50 — ten minutes earlier, not
    // twenty-three hours and fifty minutes later.
    const justAfterMidnight = U('2026-09-11T22:20:00Z') // 00:20 on the 12th at +120
    const out = parseSessionClock('23:50', justAfterMidnight, 120)!
    expect(sessionClock(out, 120)).toBe('23:50:00')
    expect(out).toBeLessThan(justAfterMidnight)
    expect(justAfterMidnight - out).toBe(30 * 60_000)
  })
})

describe('NUDGES', () => {
  it('offers the four steps back the brief asked for, then the same forward', () => {
    expect(NUDGES.map((n) => n.ms)).toEqual([
      -600_000, -60_000, -10_000, -1_000, 1_000, 10_000, 60_000, 600_000,
    ])
  })

  it('puts the backward steps first — people press late', () => {
    expect(NUDGES[0].ms).toBeLessThan(0)
    expect(NUDGES[NUDGES.length - 1].ms).toBeGreaterThan(0)
  })
})

describe('nudge', () => {
  const t = U('2026-09-11T11:04:07Z')

  it('adds the step', () => {
    expect(nudge(t, -10_000)).toBe(t - 10_000)
  })

  it('clamps to the day rather than landing before the boat left the dock', () => {
    const min = U('2026-09-11T11:00:00Z')
    expect(nudge(t, -600_000, { min })).toBe(min)
  })

  it('clamps at the end of the day too', () => {
    const max = U('2026-09-11T11:05:00Z')
    expect(nudge(t, 600_000, { min: null, max })).toBe(max)
  })

  it('ignores bounds that are not numbers', () => {
    expect(nudge(t, 1_000, { min: null, max: null })).toBe(t + 1_000)
  })
})

describe('driftLabel', () => {
  it('is empty when nothing moved', () => {
    expect(driftLabel(1000, 1000)).toBe('')
  })

  it('reads in seconds, then minutes and seconds', () => {
    expect(driftLabel(0, 4_000)).toBe('+4s')
    expect(driftLabel(0, -80_000)).toBe('−1m 20s')
    expect(driftLabel(0, -120_000)).toBe('−2m')
  })
})

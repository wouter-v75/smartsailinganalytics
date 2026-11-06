import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveVenueTz, tzAbbrev, isValidTz, _clearVenueTzCache, wallStamp, racingWindowIn } from '../venueTz'

const ok = (tz: string) => ({ ok: true, json: async () => ({ timezone: tz }) })

describe('resolveVenueTz', () => {
  beforeEach(() => _clearVenueTzCache())

  it("returns the venue's zone, not the device's", async () => {
    const f = vi.fn(async () => ok('America/New_York'))
    expect(await resolveVenueTz(41.49, -71.31, f)).toBe('America/New_York')
    expect(f.mock.calls[0][0]).toContain('timezone=auto')
  })

  it('asks once per spot — nearby points share the answer', async () => {
    const f = vi.fn(async () => ok('America/New_York'))
    await resolveVenueTz(41.49, -71.31, f)
    await resolveVenueTz(41.491, -71.312, f)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('does not pin a failure — the next call tries again', async () => {
    const bad = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }))
    expect(await resolveVenueTz(41.49, -71.31, bad)).toBeNull()
    const good = vi.fn(async () => ok('America/New_York'))
    expect(await resolveVenueTz(41.49, -71.31, good)).toBe('America/New_York')
  })

  it('rejects an answer that is not a real zone', async () => {
    expect(await resolveVenueTz(41.49, -71.31, vi.fn(async () => ok('Mars/Olympus')))).toBeNull()
  })

  it('returns null without a point', async () => {
    expect(await resolveVenueTz(null, null, vi.fn())).toBeNull()
  })
})

describe('tzAbbrev', () => {
  const sept = new Date('2026-09-13T14:00:00Z')
  it('names the zone the way a sailor reads it', () => {
    expect(tzAbbrev('America/New_York', sept)).toBe('EDT')
    expect(tzAbbrev('Europe/Amsterdam', sept)).toBe('CEST')
    expect(tzAbbrev('Europe/Rome', sept)).toBe('CEST')
  })
  it('handles UTC', () => {
    expect(tzAbbrev('UTC', sept)).toBe('UTC')
  })
})

describe('isValidTz', () => {
  it('accepts real zones only', () => {
    expect(isValidTz('America/New_York')).toBe(true)
    expect(isValidTz('Mars/Olympus')).toBe(false)
    expect(isValidTz('')).toBe(false)
  })
})

// ── chart x values ──────────────────────────────────────────────────────────
// Why these exist: every chart in the Weather tab is drawn from models that
// report time in TWO different shapes, and a Plotly date axis prints a Date in
// the BROWSER's zone (measured against plotly 2.24.1). So `new Date(t)` made
// the Open-Meteo curves right by accident and drew the SSA-Race ones in the
// viewer's clock — and the Stability tab's Boundary-layer chart has no source
// but SSA-Race, so the whole series was in the viewer's clock with nothing on
// the page to disagree with it.

describe('wallStamp', () => {
  it('leaves an Open-Meteo stamp alone — it is ALREADY venue wall time', () => {
    // The request asked for the venue's zone, so these digits are the answer.
    // Converting them again is the bug this guards: it would move 09:00 at
    // Newport to 03:00 for a viewer in Amsterdam.
    expect(wallStamp('2026-11-05T14:00', 'America/Los_Angeles')).toBe('2026-11-05T14:00')
    expect(wallStamp('2026-11-05T14:00', 'Europe/Rome')).toBe('2026-11-05T14:00')
  })

  it('converts an SSA-Race UTC stamp INTO venue wall time', () => {
    // The real shape, read off the box's published grid.json 2026-11-05:
    // seconds included, 20 characters. Its FIRST frame is 16:00:00Z, which is
    // 08:00 on the water at San Juan — the chart was drawing it at the
    // viewer's 16:00/17:00, eight hours out, right across the racing day.
    expect(wallStamp('2026-11-05T16:00:00Z', 'America/Los_Angeles')).toBe('2026-11-05T08:00')
    expect(wallStamp('2026-11-06T04:00:00Z', 'America/Los_Angeles')).toBe('2026-11-05T20:00')
    // The San Juan case: a 12z cycle at 20:00Z is 12:00 PST on the water.
    expect(wallStamp('2026-11-05T20:00Z', 'America/Los_Angeles')).toBe('2026-11-05T12:00')
    expect(wallStamp('2026-11-05T20:00Z', 'Europe/Rome')).toBe('2026-11-05T21:00')
    expect(wallStamp('2026-11-05T20:00Z', 'UTC')).toBe('2026-11-05T20:00')
  })

  it('rolls the DATE back across midnight, not just the hour', () => {
    // 04:00Z on the 6th is still the 5th at San Juan. An hours-only fix would
    // have put the point on tomorrow's chart.
    expect(wallStamp('2026-11-06T04:00Z', 'America/Los_Angeles')).toBe('2026-11-05T20:00')
    expect(wallStamp('2026-11-05T23:30Z', 'Europe/Rome')).toBe('2026-11-06T00:30')
  })

  it('reads an explicit offset as a zone too, not as a zone-less stamp', () => {
    expect(wallStamp('2026-11-05T20:00+01:00', 'UTC')).toBe('2026-11-05T19:00')
  })

  it('sorts chronologically as a plain string, which is what the band relies on', () => {
    const xs = ['2026-11-05T23:00', '2026-11-06T01:00', '2026-11-05T09:00']
    expect([...xs].sort()).toEqual(['2026-11-05T09:00', '2026-11-05T23:00', '2026-11-06T01:00'])
  })

  it('returns null rather than a broken stamp', () => {
    expect(wallStamp('', 'UTC')).toBeNull()
    expect(wallStamp('2026-11-05', 'UTC')).toBeNull()
    expect(wallStamp(null as unknown as string, 'UTC')).toBeNull()
  })
})

describe('racingWindowIn', () => {
  // Afternoon in Europe is still the small hours at San Juan — the case the
  // old `new Date().setHours(10)` got wrong twice over, in hours AND in date.
  const euroAfternoon = new Date('2026-11-05T16:00:00Z')

  it('opens on the VENUE\'s racing hours', () => {
    expect(racingWindowIn('America/Los_Angeles', euroAfternoon))
      .toEqual(['2026-11-05T10:00', '2026-11-05T16:00'])
    expect(racingWindowIn('Europe/Rome', euroAfternoon))
      .toEqual(['2026-11-05T10:00', '2026-11-05T16:00'])
  })

  it('uses the VENUE\'s date, which is not always the viewer\'s', () => {
    // 23:30 UTC: already the 6th in Rome, still the 5th at San Juan.
    const lateEvening = new Date('2026-11-05T23:30:00Z')
    expect(racingWindowIn('Europe/Rome', lateEvening)[0]).toBe('2026-11-06T10:00')
    expect(racingWindowIn('America/Los_Angeles', lateEvening)[0]).toBe('2026-11-05T10:00')
  })

  it('takes a different window when asked', () => {
    expect(racingWindowIn('UTC', euroAfternoon, 8, 20))
      .toEqual(['2026-11-05T08:00', '2026-11-05T20:00'])
  })
})

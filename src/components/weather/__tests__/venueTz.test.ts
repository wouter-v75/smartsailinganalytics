import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveVenueTz, tzAbbrev, isValidTz, _clearVenueTzCache } from '../venueTz'

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

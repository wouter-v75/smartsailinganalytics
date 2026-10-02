import { describe, it, expect } from 'vitest'
import { nameSaysDrone, planRowFixes, stampInName, type ClipRow } from '../clipRowRepair'

const TZ = 120                                   // St Tropez, UTC+2
const iso = (s: string) => new Date(s).toISOString()

const row = (over: Partial<ClipRow>): ClipRow => ({
  id: 'r1', title: '20261002120330_race-start_20261002_drone', start_utc: null, tags: [], ...over,
})

describe('stampInName', () => {
  it('reads the cutter\'s stamp as LOCAL wall time', () => {
    expect(stampInName('20261002120330_race-start_20261002_drone'))
      .toBe(Date.UTC(2026, 9, 2, 12, 3, 30))
  })
  it('is null for a name with no stamp, and for nonsense digits', () => {
    expect(stampInName('clip.mp4')).toBeNull()
    expect(stampInName('20261042120330_x')).toBeNull()      // day 42
    expect(stampInName('20261002990330_x')).toBeNull()      // hour 99
  })
})

describe('nameSaysDrone', () => {
  it('matches the shapes drone clips actually arrive in', () => {
    expect(nameSaysDrone('20261002120330_race-start_20261002_drone')).toBe(true)
    expect(nameSaysDrone('DJI_20260930141950_0001_D')).toBe(true)
    expect(nameSaysDrone('20260930_gate_day2_DJI-001')).toBe(true)
    expect(nameSaysDrone('20261002120330_gate_20261002_Camera')).toBe(false)
  })
})

describe('planRowFixes', () => {
  it('fixes a row written mid-probe with the ENCODE time', () => {
    // 12:03:30 local is 10:03:30Z. The row says 11:00:12Z — when ffmpeg made it.
    const fixes = planRowFixes([row({ start_utc: iso('2026-10-02T11:00:12Z') })], TZ)
    expect(fixes).toHaveLength(1)
    expect(fixes[0].startUtc).toBe(iso('2026-10-02T10:03:30Z'))
    expect(fixes[0].wasStartUtc).toBe(iso('2026-10-02T11:00:12Z'))
    expect(fixes[0].driftMs).toBe(-(56 * 60 + 42) * 1000)
  })

  it('leaves a row that is already right', () => {
    expect(planRowFixes([row({ start_utc: iso('2026-10-02T10:03:30Z'), tags: ['drone'] })], TZ)).toEqual([])
  })

  it('does not drag back a start somebody nudged by hand', () => {
    // Within tolerance: a second of sync offset typed in the Videos tab stays.
    expect(planRowFixes([row({ start_utc: iso('2026-10-02T10:03:31Z'), tags: ['drone'] })], TZ)).toEqual([])
    // Ten seconds is not a nudge, it is wrong.
    expect(planRowFixes([row({ start_utc: iso('2026-10-02T10:03:40Z'), tags: ['drone'] })], TZ)).toHaveLength(1)
  })

  it('adds the drone tag the timeline colours by, keeping the tags already there', () => {
    const fixes = planRowFixes([row({ start_utc: iso('2026-10-02T10:03:30Z'), tags: ['race-start'] })], TZ)
    expect(fixes[0].tags).toEqual(['race-start', 'drone'])
    expect(fixes[0].startUtc).toBeNull()        // the time was fine; only the tag was missing
  })

  it('fills a row with no start at all', () => {
    const fixes = planRowFixes([row({ start_utc: null, tags: ['drone'] })], TZ)
    expect(fixes[0].startUtc).toBe(iso('2026-10-02T10:03:30Z'))
    expect(fixes[0].driftMs).toBeNull()
  })

  it('leaves a clip whose name carries no stamp alone', () => {
    // There is nothing better to put there, and a guess is worse than a wrong
    // time somebody can see and correct.
    const fixes = planRowFixes([row({ title: 'Race 1.mp4', start_utc: iso('2026-10-02T11:00:00Z') })], TZ)
    expect(fixes).toEqual([])
  })

  it('applies the venue offset, not a guess', () => {
    const utcVenue = planRowFixes([row({ start_utc: null, tags: ['drone'] })], 0)
    expect(utcVenue[0].startUtc).toBe(iso('2026-10-02T12:03:30Z'))
  })
})

describe('a row with no start time at all', () => {
  // What the four RIB clips of 2 October look like: the cloud row was created
  // before anything could say when the clip was filmed. The timeline used to
  // park these at the day's own start — Date.parse(null) is NaN, which is
  // falsy, so `|| day.t0` swallowed it and they all showed 11:00.
  it('is reported, and left for the Videos tab when the name says nothing', () => {
    const noName = planRowFixes([{ id: 'r9', title: 'GX010041', start_utc: null, tags: [] }], TZ)
    expect(noName).toEqual([])            // nothing here can place it
    const named = planRowFixes([row({ start_utc: null })], TZ)
    expect(named[0].startUtc).toBe(iso('2026-10-02T10:03:30Z'))
  })
})

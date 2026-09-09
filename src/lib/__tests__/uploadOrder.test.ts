import { describe, it, expect } from 'vitest'
import { clipRank, clipTimeMs, sortForUpload } from '../uploadOrder'

// The real 8 Sept card, in the order the uploader actually sent it — newest
// first, race start last. This is the bug the module exists to fix.
const DAY7 = [
  { title: '20260908144537 gybe day7 drone', tags: ['gybe'] },
  { title: '20260908143955 gybe day7 drone', tags: ['gybe'] },
  { title: '20260908143913 gybe day7 drone', tags: ['gybe'] },
  { title: '20260908143728 gybe day7 drone', tags: ['gybe'] },
  { title: '20260908143448 gybe day7 drone', tags: ['gybe'] },
  { title: '20260908141039 gybe day7 drone', tags: ['gybe'] },
  { title: '20260908140911 gybe day7 drone', tags: ['gybe'] },
  { title: '20260908134507 tack day7 drone', tags: ['tack'] },
  { title: '20260908121154 gybe day7 drone', tags: ['gybe'] },
  { title: '20260908134932 topmark day7 drone', tags: ['topmark'] },
  { title: '20260908121330 race start day7 drone', tags: ['race-start'] },
]

describe('sortForUpload — the 8 Sept card', () => {
  const out = sortForUpload(DAY7)

  it('puts the race start FIRST, where it was previously last', () => {
    expect(out[0].title).toContain('race start')
    expect(DAY7[DAY7.length - 1].title).toContain('race start') // was last before
  })

  it('then the rounding, then the manoeuvres', () => {
    expect(out[1].title).toContain('topmark')
    expect(out.slice(2).every((c) => /gybe|tack/.test(c.title))).toBe(true)
  })

  it('is chronological within a rank', () => {
    const turns = out.slice(2).map((c) => clipTimeMs(c)!)
    expect(turns).toEqual([...turns].sort((a, b) => a - b))
  })

  it('does not mutate the caller’s array', () => {
    const before = DAY7.map((c) => c.title)
    sortForUpload(DAY7)
    expect(DAY7.map((c) => c.title)).toEqual(before)
  })
})

describe('clipRank', () => {
  it('reads tags first', () => {
    expect(clipRank({ tags: ['race-start'], title: 'whatever' })).toBe(0)
    expect(clipRank({ tags: ['topmark'] })).toBe(1)
    expect(clipRank({ tags: ['gate'] })).toBe(2)
    expect(clipRank({ tags: ['tack'] })).toBe(4)   // photos sit at 3, above manoeuvres
  })

  it('falls back to the title when tags are missing, rather than sinking the clip', () => {
    expect(clipRank({ title: '20260908121330_race-start_day7_drone' })).toBe(0)
    expect(clipRank({ name: '20260908134932_topmark_day7_drone.mp4' })).toBe(1)
  })

  it('takes the strongest signal when a clip covers several events', () => {
    // a segment spanning a gate AND the gun is a start first
    expect(clipRank({ tags: ['gate', 'race-start'] })).toBe(0)
  })

  it('does not match a word inside another word', () => {
    expect(clipRank({ title: 'restart of the day' })).toBe(9)
    expect(clipRank({ title: 'Gateway Marina delivery' })).toBe(9)
  })

  it('ranks the unclassifiable last instead of guessing', () => {
    expect(clipRank({ title: 'DJI_0169.MP4' })).toBe(9)
    expect(clipRank({})).toBe(9)
  })
})

describe('clipTimeMs', () => {
  it('prefers a real start time over the filename', () => {
    expect(clipTimeMs({ startUtc: 1788881982754, title: '20260908121330 x' })).toBe(1788881982754)
  })
  it('accepts an ISO string', () => {
    expect(clipTimeMs({ utc: '2026-09-08T12:13:30Z' })).toBe(Date.parse('2026-09-08T12:13:30Z'))
  })
  it('falls back to the stamp the clip script writes', () => {
    expect(clipTimeMs({ title: '20260908121330 race start' }))
      .toBe(Date.UTC(2026, 8, 8, 12, 13, 30))
  })
  it('returns null for a nonsense stamp rather than a date in year 1', () => {
    expect(clipTimeMs({ title: '00000000000000 x' })).toBeNull()
    expect(clipTimeMs({ title: 'no stamp here' })).toBeNull()
  })
  it('sorts undateable clips last, not first', () => {
    const out = sortForUpload([
      { title: 'mystery gybe', tags: ['gybe'] },
      { title: '20260908140911 gybe', tags: ['gybe'] },
    ])
    expect(out[0].title).toContain('20260908140911')
  })
})

describe('a training day of sail photos', () => {
  it('ranks photos above manoeuvres and below roundings', () => {
    expect(clipRank({ tags: ['photo'] })).toBe(3)
    expect(clipRank({ tags: ['photo'] })).toBeLessThan(clipRank({ tags: ['gybe'] }))
    expect(clipRank({ tags: ['photo'] })).toBeGreaterThan(clipRank({ tags: ['gate'] }))
  })

  it('orders a photo-only card chronologically', () => {
    const out = sortForUpload([
      { title: '20260909145222_photo_layday_drone', tags: ['photo'] },
      { title: '20260909134035_photo_layday_drone', tags: ['photo'] },
      { title: '20260909140911_photo_layday_drone', tags: ['photo'] },
    ])
    expect(out.map((c) => c.title.slice(0, 14))).toEqual([
      '20260909134035', '20260909140911', '20260909145222',
    ])
  })
})

import { describe, it, expect } from 'vitest'
import { buildDayTimeline, type ParsedEventLike } from '../buildNodes'

const T = Date.UTC(2026, 6, 3, 9, 0, 0) // 2026-07-03 09:00Z
const min = (m: number) => T + m * 60000

const xml: ParsedEventLike = {
  meta: { location: 'La Ciotat' },
  dayStartUtc: T,
  dayStopUtc: min(180),
  raceGuns: [
    { utc: min(5), raceNum: 1 },
    { utc: min(95), raceNum: 2 },
  ],
  tackJibes: [
    { utc: min(20), isTack: true, isValid: true }, // race 1
    { utc: min(40), isTack: false, isValid: false }, // race 1 gybe
    { utc: min(110), isTack: true, isValid: true }, // race 2
  ],
  markRoundings: [
    { utc: min(30), isTop: true, isValid: true }, // race 1
  ],
  sailsUpEvents: [
    { utc: min(2), sails: ['MN', 'J1'], label: 'MN + J1' }, // before race 1 → day
    { utc: min(50), sails: ['MN', 'J2'], label: 'MN + J2' }, // in race 1
  ],
}

describe('buildDayTimeline', () => {
  const nodes = buildDayTimeline({ xml, boatId: 'boat-1', date: '2026-07-03' })
  const by = (kind: string) => nodes.filter((n) => n.kind === kind)

  it('builds one day node spanning the session', () => {
    const day = by('day')
    expect(day).toHaveLength(1)
    expect(day[0].t0).toBe(T)
    expect(day[0].t1).toBe(min(180))
    expect(day[0].parentId).toBeNull()
    expect(day[0].subtitle).toBe('La Ciotat')
  })

  it('builds a race per gun with correct maneuver counts', () => {
    const races = by('race')
    expect(races).toHaveLength(2)
    const r1 = races.find((r) => r.meta?.raceNum === 1)!
    expect(r1.metrics).toMatchObject({ tacks: 1, gybes: 1, marks: 1 })
    expect(r1.t1).toBe(min(95)) // ends at next gun
  })

  it('parents events to the race window they fall in', () => {
    const tacks = by('tack')
    expect(tacks).toHaveLength(2)
    expect(tacks[0].parentId).toBe('boat-1:2026-07-03:race:1')
    const gybe = by('gybe')[0]
    expect(gybe.meta?.valid).toBe(false)
    // sail change at min(50) sits inside race 1; the one at min(2) sits on the day
    const sails = by('sail_change')
    expect(sails.find((s) => s.t0 === min(2))!.parentId).toBe('boat-1:2026-07-03:day')
    expect(sails.find((s) => s.t0 === min(50))!.parentId).toBe('boat-1:2026-07-03:race:1')
  })

  it('emits start + finish per race', () => {
    expect(by('start')).toHaveLength(2)
    expect(by('finish')).toHaveLength(2)
  })

  it('is deterministic (re-run yields identical ids)', () => {
    const again = buildDayTimeline({ xml, boatId: 'boat-1', date: '2026-07-03' })
    expect(again.map((n) => n.id)).toEqual(nodes.map((n) => n.id))
  })

  it('handles a training session with no races (events hang off the day)', () => {
    const training = buildDayTimeline({
      xml: { dayStartUtc: T, dayStopUtc: min(60), tackJibes: [{ utc: min(10), isTack: true }] },
      boatId: 'b', date: '2026-07-03',
    })
    const tack = training.find((n) => n.kind === 'tack')!
    expect(tack.parentId).toBe('b:2026-07-03:day')
  })
})

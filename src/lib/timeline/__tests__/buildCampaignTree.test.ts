import { describe, it, expect } from 'vitest'
import { buildDayTimeline } from '../buildNodes'
import { buildCampaignTree, type SessionRec } from '../buildCampaignTree'

const raceDay = buildDayTimeline({
  boatId: 'b', date: '2026-06-14',
  xml: {
    meta: { location: 'La Ciotat' },
    dayStartUtc: Date.parse('2026-06-14T09:00:00Z'), dayStopUtc: Date.parse('2026-06-14T15:00:00Z'),
    raceGuns: [{ utc: Date.parse('2026-06-14T10:00:00Z'), raceNum: 1 }],
    tackJibes: [{ utc: Date.parse('2026-06-14T10:20:00Z'), isTack: true }],
  },
})

const sessions: SessionRec[] = [
  { date: '2026-06-14', event: 'La Ciotat Regatta', video_count: 3, photo_count: 10 },
  { date: '2026-06-20', event: null, video_count: 1, photo_count: 0 }, // training, no event file
]

describe('buildCampaignTree', () => {
  const out = buildCampaignTree({ sessions, detail: raceDay, boatId: 'b' })
  const of = (k: string) => out.filter((n) => n.kind === k)

  it('makes a day for every session, even ones with no event file', () => {
    const days = of('day')
    expect(days.map((d) => d.id.split(':')[1]).sort()).toEqual(['2026-06-14', '2026-06-20'])
    // the training day (no event file) still exists, carrying its media counts
    const training = days.find((d) => d.id.includes('2026-06-20'))!
    expect(training.metrics).toMatchObject({ videos: 1, photos: 0 })
  })

  it('groups days into regattas by event (training in its own block) under one season', () => {
    expect(of('season')).toHaveLength(1)
    expect(of('regatta').map((r) => r.title).sort()).toEqual(['La Ciotat Regatta', 'Training'])
  })

  it('carries video/photo counts on the day and keeps event-file race detail', () => {
    const raceDayNode = of('day').find((d) => d.id.includes('2026-06-14'))!
    expect(raceDayNode.metrics).toMatchObject({ videos: 3, photos: 10 })
    // race detail from the event file still attached under that day
    const race = out.find((n) => n.kind === 'race')!
    expect(race.parentId).toBe('b:2026-06-14:day')
  })

  it('drops the persisted day node (campaign day replaces it, no duplicate)', () => {
    const dayIds = of('day').map((d) => d.id)
    expect(new Set(dayIds).size).toBe(dayIds.length)
  })
})

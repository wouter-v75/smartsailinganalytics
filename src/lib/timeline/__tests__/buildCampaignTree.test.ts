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

describe('buildCampaignTree — consecutive-run grouping', () => {
  it('splits non-contiguous training days into separate blocks (no season-long bar)', () => {
    const s: SessionRec[] = [
      { date: '2026-06-25', event: null },
      { date: '2026-06-26', event: null },
      { date: '2026-06-27', event: null }, // block A (25–27 Jun)
      { date: '2026-08-10', event: null }, // block B (weeks later)
    ]
    const out = buildCampaignTree({ sessions: s, detail: [], boatId: 'b' })
    const trainings = out.filter((n) => n.kind === 'regatta' && n.title === 'Training')
    expect(trainings).toHaveLength(2)
    // The June block must END on 27 Jun, not stretch to August.
    const june = trainings.find((r) => r.id.includes('2026-06-25'))!
    expect(new Date(june.t1).toISOString().slice(0, 10)).toBe('2026-06-27')
  })

  it('ignores stray pre-2000 (1900) dates so the season does not start in 1900', () => {
    const s: SessionRec[] = [
      { date: '1900-01-01', event: null }, // bad legacy row
      { date: '2026-06-25', event: null },
      { date: '2026-06-26', event: null },
    ]
    const out = buildCampaignTree({ sessions: s, detail: [], boatId: 'b' })
    const season = out.find((n) => n.kind === 'season')!
    expect(season.title).toBe('Season 2026')
    expect(new Date(season.t0).toISOString().slice(0, 4)).toBe('2026')
    expect(out.filter((n) => n.kind === 'day')).toHaveLength(2)
  })
})

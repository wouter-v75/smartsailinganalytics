import { describe, it, expect } from 'vitest'
import { pickCampaignEvent } from '../campaignEvent'

// The real calendar shape that produced the bug: the Maxi Worlds are being sailed
// (1-12 Sept) while Les Voiles de St Tropez already sits on the calendar for the
// 29th. Sorting the whole calendar descending and taking row 0 picked Les Voiles.
const CALENDAR = [
  { date: '2026-07-14', event: 'July training' },
  { date: '2026-08-30', event: 'Maxi Worlds' },
  { date: '2026-09-01', event: 'Maxi Worlds' },
  { date: '2026-09-12', event: 'Maxi Worlds' },
  { date: '2026-09-29', event: 'Les Voiles de St Tropez' },
]

describe('pickCampaignEvent', () => {
  it('picks the regatta being sailed today, not the furthest-future one', () => {
    expect(pickCampaignEvent(CALENDAR, '2026-09-01')).toBe('Maxi Worlds')
  })

  it('picks the NEXT event on a rest day mid-regatta', () => {
    // no session dated the 2nd; the next one is the 12th, still Maxi Worlds
    expect(pickCampaignEvent(CALENDAR, '2026-09-02')).toBe('Maxi Worlds')
  })

  it('rolls on to the next regatta once the current one is over', () => {
    expect(pickCampaignEvent(CALENDAR, '2026-09-13')).toBe('Les Voiles de St Tropez')
    expect(pickCampaignEvent(CALENDAR, '2026-09-29')).toBe('Les Voiles de St Tropez')
  })

  it('falls back to the most recent past event when nothing is upcoming', () => {
    expect(pickCampaignEvent(CALENDAR, '2026-12-01')).toBe('Les Voiles de St Tropez')
  })

  it('is not fooled by row order — the calendar may arrive in any order', () => {
    const shuffled = [CALENDAR[4], CALENDAR[0], CALENDAR[3], CALENDAR[1], CALENDAR[2]]
    expect(pickCampaignEvent(shuffled, '2026-09-01')).toBe('Maxi Worlds')
  })

  it('ignores sessions with no event name', () => {
    const rows = [
      { date: '2026-09-01', event: null },
      { date: '2026-09-03', event: 'Maxi Worlds' },
      { date: '2026-09-29', event: 'Les Voiles de St Tropez' },
    ]
    expect(pickCampaignEvent(rows, '2026-09-01')).toBe('Maxi Worlds')
  })

  it('ignores rows with a missing or malformed date', () => {
    const rows = [
      { date: null, event: 'Ghost regatta' },
      { date: 'someday', event: 'Ghost regatta 2' },
      { date: '2026-09-05', event: 'Maxi Worlds' },
    ]
    expect(pickCampaignEvent(rows, '2026-09-01')).toBe('Maxi Worlds')
  })

  it('tolerates a full timestamp in the date column', () => {
    const rows = [{ date: '2026-09-01T00:00:00Z', event: 'Maxi Worlds' }]
    expect(pickCampaignEvent(rows, '2026-09-01')).toBe('Maxi Worlds')
  })

  it('returns null for an empty or absent calendar rather than guessing', () => {
    expect(pickCampaignEvent([], '2026-09-01')).toBeNull()
    expect(pickCampaignEvent(null, '2026-09-01')).toBeNull()
    expect(pickCampaignEvent(undefined, '2026-09-01')).toBeNull()
  })

  it('reproduces the old behaviour as WRONG, so the regression is pinned', () => {
    const oldWay = [...CALENDAR].sort((a, b) => b.date.localeCompare(a.date))[0].event
    expect(oldWay).toBe('Les Voiles de St Tropez')          // what the deck showed
    expect(pickCampaignEvent(CALENDAR, '2026-09-01')).toBe('Maxi Worlds')  // what it should
  })
})

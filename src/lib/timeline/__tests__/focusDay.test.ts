import { describe, it, expect } from 'vitest'
import { pickFocusDay } from '../focusDay'
import type { TimelineNode } from '../types'

const day = (date: string, extra: Partial<TimelineNode> = {}): TimelineNode => ({
  id: `b:${date}:day`, parentId: 'b:season:2026', kind: 'day',
  t0: Date.parse(`${date}T09:00:00Z`), t1: Date.parse(`${date}T17:00:00Z`),
  title: 'Day', source: 'auto', producer: 'campaign', meta: { date }, ...extra,
})

describe('pickFocusDay', () => {
  it('lands on today when a session exists for today', () => {
    const today = new Date().toISOString().slice(0, 10)
    const tree = [day('2026-06-01', { metrics: { videos: 3 } }), day(today)]
    expect(pickFocusDay(tree)).toBe(`b:${today}:day`)
  })

  it('else picks the most recent day WITH data (video/photo/log detail)', () => {
    const tree: TimelineNode[] = [
      day('2026-06-01', { metrics: { videos: 2 } }),
      day('2026-06-20'), // most recent but no data
      day('2026-06-10', { metrics: { photos: 5 } }),
    ]
    expect(pickFocusDay(tree)).toBe('b:2026-06-10:day')
  })

  it('counts event-file detail (a child node) as data', () => {
    const tree: TimelineNode[] = [
      day('2026-06-01', { metrics: { videos: 1 } }),
      day('2026-06-15'),
      { id: 'b:2026-06-15:race:1', parentId: 'b:2026-06-15:day', kind: 'race', t0: 1, t1: 2, title: 'Race', source: 'auto', producer: 'eventfile' },
    ]
    expect(pickFocusDay(tree)).toBe('b:2026-06-15:day')
  })

  it('falls back to the most recent day when nothing has data', () => {
    const tree = [day('2026-06-01'), day('2026-06-09')]
    expect(pickFocusDay(tree)).toBe('b:2026-06-09:day')
  })
})

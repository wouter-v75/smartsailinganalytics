import { describe, it, expect } from 'vitest'
import {
  toShares, NO_SHARES, inertWithoutTracks, sharesSummary,
  SQUAD_CATEGORIES, TAG_OPTIONS,
} from '../squadCategories'

describe('toShares', () => {
  it('defaults everything OFF — joining a squad shares nothing', () => {
    expect(toShares(undefined)).toEqual(NO_SHARES)
    expect(toShares(null)).toEqual(NO_SHARES)
    expect(toShares({})).toEqual(NO_SHARES)
  })

  it('treats anything but a literal true as off', () => {
    // A JSONB round-trip or a sloppy client must never be able to turn
    // sharing ON by accident. Only `true` counts.
    const s = toShares({ tracks: 'true', videos: 1, photos: 'yes', notes: {} })
    expect(s.tracks).toBe(false)
    expect(s.videos).toBe(false)
    expect(s.photos).toBe(false)
    expect(s.notes).toBe(false)
  })

  it('clamps tags to the three values the policy understands', () => {
    expect(toShares({ tags: 'race' }).tags).toBe('race')
    expect(toShares({ tags: 'all' }).tags).toBe('all')
    expect(toShares({ tags: 'everything' }).tags).toBe('none')
    expect(toShares({ tags: true }).tags).toBe('none')
  })
})

describe('inertWithoutTracks', () => {
  it('names the categories that do nothing without tracks', () => {
    // These hang off a shared DAY, and a day is only visible when its session
    // is shared — which needs tracks. Silently inert is worse than flagged.
    const s = { ...NO_SHARES, notes: true, sailscans: true, tags: 'all' as const }
    expect(inertWithoutTracks(s)).toEqual(['Sail scans', 'Notes', 'Tags'])
  })

  it('says nothing once tracks are on', () => {
    expect(inertWithoutTracks({ ...NO_SHARES, tracks: true, notes: true })).toEqual([])
  })

  it('does not flag videos or photos, which stand alone', () => {
    // A clip carries its own shared_with_squad flag and does not need the
    // session's, so it is not inert without tracks.
    expect(inertWithoutTracks({ ...NO_SHARES, videos: true, photos: true })).toEqual([])
  })
})

describe('sharesSummary', () => {
  it('is honest when a team contributes nothing', () => {
    expect(sharesSummary(NO_SHARES)).toBe('Contributing nothing yet.')
  })

  it('lists what is on, including the tag setting', () => {
    expect(sharesSummary({ ...NO_SHARES, tracks: true })).toBe('Contributing tracks.')
    expect(sharesSummary({ ...NO_SHARES, tracks: true, tags: 'race' }))
      .toBe('Contributing tracks and race tags.')
    expect(sharesSummary({ ...NO_SHARES, tracks: true, videos: true, tags: 'all' }))
      .toBe('Contributing tracks, videos and all tags.')
  })
})

describe('the category list itself', () => {
  it('covers every shareable key exactly once', () => {
    const keys = SQUAD_CATEGORIES.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    // `tags` is deliberately absent: it is a tri-state, not a checkbox.
    expect(Object.keys(NO_SHARES).sort()).toEqual([...keys, 'tags'].sort())
  })

  it('explains each one — a vague label is how a privacy choice goes wrong', () => {
    for (const c of SQUAD_CATEGORIES) {
      expect(c.detail.length).toBeGreaterThan(30)
      expect(c.label).not.toBe('')
    }
    for (const o of TAG_OPTIONS) expect(o.detail.length).toBeGreaterThan(10)
  })
})

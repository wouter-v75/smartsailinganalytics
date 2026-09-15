import { describe, it, expect } from 'vitest'
import {
  BASE_TAGS, BASE_GENERAL_TAGS, BASE_SECTION_TAGS,
  slugify, labelFromSlug, migrateLegacyTagList,
} from '../baseTags'
import { SECTION_KEYS } from '../sections'

// These assert DESIGN DECISIONS, not implementation. Each one comes from the
// research in docs/tagger-prior-art-2026-09.md, and each would be easy to erode
// one convenient tag at a time — which is exactly how a coding scheme stops
// being usable.
describe('base vocabulary', () => {
  it('stays learnable in an evening — 20-30 general tags', () => {
    // Coder training in the literature is ~2 h to learn a scheme plus 1 h of
    // practice. That is the budget a crew will give this. (§26)
    expect(BASE_GENERAL_TAGS.length).toBeGreaterThanOrEqual(20)
    expect(BASE_GENERAL_TAGS.length).toBeLessThanOrEqual(30)
  })

  it('keeps the button bar to roughly eight', () => {
    // Rare codes depress coding consistency even when coders agree on nearly
    // every actual occurrence, so the bar is curated, not the whole list. (§25)
    const bar = BASE_TAGS.filter((t) => t.onButtonBar)
    expect(bar.length).toBeLessThanOrEqual(8)
    expect(bar.length).toBeGreaterThanOrEqual(6)
  })

  it('gives every tag lead time — people press late, always', () => {
    // §12: the operator has to see the moment, recognise it and find the button.
    for (const t of BASE_TAGS) expect(t.leadSec).toBeGreaterThan(0)
  })

  it('gives a race start the longest lead of any tag', () => {
    const start = BASE_TAGS.find((t) => t.slug === 'race-start')!
    const others = BASE_TAGS.filter((t) => t.slug !== 'race-start')
    expect(start.leadSec).toBeGreaterThanOrEqual(Math.max(...others.map((t) => t.leadSec)))
  })

  it('has no duplicate identities', () => {
    const keys = BASE_TAGS.map((t) => `${t.scope}:${t.section || ''}:${t.slug}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('only uses sections the database will accept', () => {
    for (const t of BASE_SECTION_TAGS) expect(SECTION_KEYS).toContain(t.section)
  })

  it('shapes every tag the way the scope CHECK constraint demands', () => {
    for (const t of BASE_TAGS) {
      if (t.scope === 'section') expect(t.section).toBeTruthy()
      else expect(t.section).toBeNull()
    }
  })

  it('offers descriptors on the manoeuvres worth judging', () => {
    // Category + descriptor is the two-level model every elite tool uses. (§1)
    for (const slug of ['tack', 'gybe', 'race-start']) {
      const t = BASE_TAGS.find((x) => x.slug === slug)!
      expect(t.labelGroups.length).toBeGreaterThan(0)
    }
  })

  it('keeps each descriptor group small enough to hold in your head', () => {
    for (const t of BASE_TAGS) {
      for (const g of t.labelGroups) {
        expect(g.options.length).toBeGreaterThan(1)
        expect(g.options.length).toBeLessThanOrEqual(8)
      }
    }
  })
})

describe('slugify', () => {
  it('produces the lower-kebab keys the old tag list used', () => {
    expect(slugify('  Race Start  ')).toBe('race-start')
    expect(slugify('A2 / B  2026')).toBe('a2-b-2026')
    expect(slugify('---')).toBe('')
    expect(slugify('x'.repeat(80)).length).toBe(48)
  })
  it('round-trips through labelFromSlug readably', () => {
    expect(labelFromSlug('spin-hoist')).toBe('Spin hoist')
    expect(labelFromSlug('')).toBe('')
  })
})

describe('migrateLegacyTagList', () => {
  it('carries a team’s own vocabulary across', () => {
    const out = migrateLegacyTagList(['Crew Work', 'boat handling'])
    expect(out.map((t) => t.slug)).toEqual(['crew-work', 'boat-handling'])
    expect(out[0].label).toBe('Crew work')
  })
  it('never shadows a base tag', () => {
    // A legacy "tack" must not become a second definition of the same thing.
    expect(migrateLegacyTagList(['tack', 'Tack', 'TACK'])).toEqual([])
  })
  it('drops empties and survives junk', () => {
    expect(migrateLegacyTagList(['', '  ', '---', null as never])).toEqual([])
    expect(migrateLegacyTagList(null)).toEqual([])
  })
})

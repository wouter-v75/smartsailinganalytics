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
  it('stays learnable in an evening — 20-32 general tags', () => {
    // Coder training in the literature is ~2 h to learn a scheme plus 1 h of
    // practice. That is the budget a crew will give this. (§26)
    //
    // The ceiling moved from 30 to 32 when Day start and Day end were added.
    // Raising it is a real cost and worth naming: every tag past the budget is
    // one more thing a crew has to hold, and the guardrail only works while
    // moving it is a decision rather than a reflex. These two earn it by being
    // detected from the event file on any day that has one — most crews will
    // never press them.
    expect(BASE_GENERAL_TAGS.length).toBeGreaterThanOrEqual(20)
    expect(BASE_GENERAL_TAGS.length).toBeLessThanOrEqual(32)
  })

  it('keeps the button bar to roughly eight', () => {
    // Rare codes depress coding consistency even when coders agree on nearly
    // every actual occurrence, so the bar is curated, not the whole list. (§25)
    const bar = BASE_TAGS.filter((t) => t.onButtonBar)
    expect(bar.length).toBeLessThanOrEqual(8)
    expect(bar.length).toBeGreaterThanOrEqual(6)
  })

  it('puts nothing on the bar that the detector already finds', () => {
    // The first principle, as a test: a button for something detectDay() finds
    // by itself is a button nobody presses. Sail change is the exception, and
    // earns it — a training day has no event file to detect one from.
    const bar = BASE_TAGS.filter((t) => t.onButtonBar).map((t) => t.slug)
    for (const detected of ['race-start', 'topmark', 'gate', 'tack', 'gybe']) {
      expect(bar).not.toContain(detected)
    }
    expect(bar).toContain('sail-change')
  })

  it('gives the crew their one-press paths', () => {
    // The trimmer, the engineer, the person who wants the footage, and anyone
    // with something to say.
    const bar = BASE_TAGS.filter((t) => t.onButtonBar).map((t) => t.slug)
    for (const slug of ['note', 'team-note', 'review', 'technical', 'grab-video', 'sail-change']) {
      expect(bar).toContain(slug)
    }
  })

  it('does not give one reflex two buttons', () => {
    // "Incident" and "Gear damage" were both pressed for "something went
    // wrong", and a crew choosing between them at 20 knots picks whichever is
    // nearer the thumb — which makes neither of them searchable afterwards.
    const bar = BASE_TAGS.filter((t) => t.onButtonBar).map((t) => t.slug)
    expect(bar).not.toContain('incident')
    expect(bar).not.toContain('gear-damage')
  })

  it('keeps Incident in the vocabulary it was taken off the bar from', () => {
    // Off the bar is not deleted: a season of tags placed under it has to keep
    // meaning something, and the picker is where the rare codes live anyway.
    const incident = BASE_TAGS.find((t) => t.slug === 'incident')
    expect(incident).toBeTruthy()
    expect(incident!.archived ?? false).toBe(false)
  })

  it('gives Grab video the longest lead on the bar', () => {
    // You ask for footage of something you are watching, and by then it has
    // been going on for a while.
    const grab = BASE_TAGS.find((t) => t.slug === 'grab-video')!
    const bar = BASE_TAGS.filter((t) => t.onButtonBar)
    for (const t of bar) expect(grab.leadSec).toBeGreaterThanOrEqual(t.leadSec)
  })

  it('keeps team comments to TL2 and up, and personal notes open to all', () => {
    expect(BASE_TAGS.find((t) => t.slug === 'team-note')!.minRole).toBe('tl2')
    const personal = BASE_TAGS.find((t) => t.slug === 'note')!
    expect(personal.minRole).toBe('tl1')
    expect(personal.privateByDefault).toBe(true)
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

describe('the day’s own two ends', () => {
  it('exist as vocabulary', () => {
    for (const slug of ['day-start', 'day-end']) {
      expect(BASE_TAGS.some((t) => t.slug === slug)).toBe(true)
    }
  })

  it('are not on the bar — they are behind the Racing button', () => {
    // The bar is for what happens several times a day. These happen once each,
    // and the file usually knows them anyway.
    const bar = BASE_TAGS.filter((t) => t.onButtonBar).map((t) => t.slug)
    expect(bar).not.toContain('day-start')
    expect(bar).not.toContain('day-end')
  })

  it('are separate from dock out and dock in', () => {
    // The dock is the dock; these are when the day's RECORD starts and stops,
    // which is what every other screen measures from.
    expect(BASE_TAGS.some((t) => t.slug === 'dock-out')).toBe(true)
    expect(BASE_TAGS.some((t) => t.slug === 'dock-in')).toBe(true)
  })
})

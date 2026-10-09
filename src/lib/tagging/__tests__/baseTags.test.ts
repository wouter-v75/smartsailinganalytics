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
    //
    // 33 → 34 for "Love this setup". Nothing was traded away for it, which is
    // the expensive kind of change, so the reason has to be worth it: every
    // other one-press path on the bar records a problem, and a vocabulary that
    // can only say what went wrong produces a season with no record of what the
    // boat felt like when it was fast. It is also a tag no detector can ever
    // supply — there is no signal in a GPS trace for "this is right".
    expect(BASE_GENERAL_TAGS.length).toBeGreaterThanOrEqual(20)
    expect(BASE_GENERAL_TAGS.length).toBeLessThanOrEqual(34)
  })

  it('keeps the button bar to roughly nine', () => {
    // Rare codes depress coding consistency even when coders agree on nearly
    // every actual occurrence, so the bar is curated, not the whole list. (§25)
    //
    // 8 → 9 for "Love this setup", and this ceiling is the one that matters
    // most: the bar is twelve square centimetres of thumb reach, and at ten
    // tags plus the Racing group it runs to two rows of five. A third row would
    // take a third of the screen off the thing being tagged, so the next
    // addition has to displace something rather than join it.
    const bar = BASE_TAGS.filter((t) => t.onButtonBar)
    expect(bar.length).toBeLessThanOrEqual(9)
    expect(bar.length).toBeGreaterThanOrEqual(6)
  })

  it('gives the crew somewhere to say it was GOOD', () => {
    // The bar was eight buttons and every one of them recorded a problem — a
    // note, a technical, something to review. The setup that made the boat fast
    // is the one thing nobody can reconstruct from the log a week later, not
    // because the numbers are missing but because nothing says which second to
    // look at.
    const love = BASE_TAGS.find((t) => t.slug === 'love-setup')!
    expect(love).toBeTruthy()
    expect(love.onButtonBar).toBe(true)
    expect(love.scope).toBe('general')
    // Anyone aboard. An opinion about the setup is not a curator's privilege.
    expect(love.minRole).toBe('tl1')
    // Shared, not private: the point is that the crew and the coach can find it.
    expect(love.privateByDefault ?? false).toBe(false)
    // A state, not an event — a minute of log to average over.
    expect(love.leadSec).toBe(30)
    expect(love.lagSec).toBe(30)
  })

  it('does not make the good-news button ask a question first', () => {
    // askOnAdd on a reflex button is how a reflex button stops being pressed.
    const love = BASE_TAGS.find((t) => t.slug === 'love-setup')!
    for (const g of love.labelGroups) expect(g.askOnAdd ?? false).toBe(false)
    // It still has a descriptor, for afterwards: "the whole boat" and "the jib"
    // are different findings.
    expect(love.labelGroups.length).toBe(1)
    expect(love.labelGroups[0].options).toContain('whole boat')
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
    expect(BASE_TAGS.find((t) => t.slug === 'team-note')!.minRole).toBe('tl3')
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

describe('the 5 minute gun', () => {
  const gun = BASE_TAGS.find((t) => t.slug === 'five-minute-gun')!

  it('exists, as a general racing point tag', () => {
    expect(gun).toBeTruthy()
    expect(gun.scope).toBe('general')
    expect(gun.kind).toBe('point')
  })

  it('offers exactly the three start types, and no quality', () => {
    // A practise start and a real one look identical in the data and mean
    // completely different things in a debrief — that distinction IS the tag.
    // Quality is deliberately absent: a gun is not textbook or scrappy.
    expect(gun.labelGroups).toHaveLength(1)
    expect(gun.labelGroups[0].group).toBe('Start type')
    expect(gun.labelGroups[0].options).toEqual([
      'practise start', 'practise race', 'race',
    ])
  })

  it('sorts before the start it precedes', () => {
    const start = BASE_TAGS.find((t) => t.slug === 'race-start')!
    expect(gun.sort).toBeLessThan(start.sort)
  })

  it('runs FORWARD from the press, not back', () => {
    // The interesting sailing is the five minutes AFTER the gun — the line
    // sight, the timed run — not before it. race-start's own lead-in begins
    // long after this.
    expect(gun.lagSec).toBeGreaterThan(gun.leadSec)
  })

  it('is NOT in racingTags.ts, which is the media-card whitelist', async () => {
    // Widening that whitelist changes every thumbnail in the app. This is a
    // tag definition and nothing more — the same rule the finish follows.
    const { RACING_TAGS } = await import('../../racingTags')
    expect(Object.keys(RACING_TAGS)).not.toContain('five-minute-gun')
  })
})

describe('race_tag_slugs() and the racing group agree', () => {
  it('lists the gun as a race tag in the migration', async () => {
    // "Share race tags only" is decided by race_tag_slugs() in SQL, while the
    // picker is decided by BAR_GROUPS. They answer the same question and a
    // policy and a picker must never disagree — but they are kept in step BY
    // HAND, so the drift is worth a test rather than a comment.
    const fs = await import('node:fs')
    // The LATEST migration that redefines it — an older one would pass while
    // the live function had moved on.
    const dir = 'supabase/migrations'
    const latest = fs.readdirSync(dir)
      .filter((f) => fs.readFileSync(`${dir}/${f}`, 'utf8').includes('FUNCTION public.race_tag_slugs'))
      .sort()
      .pop()!
    const sql = fs.readFileSync(`${dir}/${latest}`, 'utf8')
    const { BAR_GROUPS } = await import('../barGroups')
    const racing = BAR_GROUPS.find((g) => g.key === 'racing')!
    for (const slug of racing.slugs) {
      expect(sql, `${slug} is in the Racing picker but not in race_tag_slugs()`)
        .toContain(`'${slug}'`)
    }
  })
})

describe('askOnAdd — which descriptors are asked up front', () => {
  it('the gun asks for its start type while being added', () => {
    // It is what the tag MEANS, not how it went. A gun that does not say
    // whether the next twenty minutes were a practice or a race is a gun
    // nobody can use a week later.
    const gun = BASE_TAGS.find((t) => t.slug === 'five-minute-gun')!
    expect(gun.labelGroups[0].askOnAdd).toBe(true)
  })

  it('is the EXCEPTION — nothing else asks up front', () => {
    // "Press now, describe later" is how people tag on the water, and a
    // composer that asks five questions is one they stop using. Each new
    // askOnAdd is a tax on every press of that tag, so it should be a
    // decision rather than a habit — hence this guardrail.
    const asking = BASE_TAGS
      .filter((t) => (t.labelGroups || []).some((g) => g.askOnAdd))
      .map((t) => t.slug)
    expect(asking).toEqual(['five-minute-gun'])
  })

  it('never asks for Quality up front, on any tag', () => {
    // Whether a tack was scrappy is worth recording and can always wait.
    for (const t of BASE_TAGS) {
      for (const g of t.labelGroups || []) {
        if (g.group === 'Quality') expect(g.askOnAdd).toBeFalsy()
      }
    }
  })
})

describe('a new base tag reaches teams that already seeded', () => {
  // THE FAILURE THIS GUARDS. The seed route only runs for a boat with an EMPTY
  // vocabulary (TaggerTab seeds when defs.length === 0), so adding a tag to
  // baseTags.ts reaches new teams and nobody else: it is in the code, on the
  // dev page, in these tests, and on no existing crew's button bar. 0093, 0094,
  // 0096 and 0099 each exist because of that.
  //
  // Driven from THIS list rather than by scanning the migrations, because the
  // migrations also include the tagger's original seed and a rename, whose rows
  // are history and are allowed to differ from today's code. Adding a base tag
  // to an app teams are already using means two things: a migration, and a line
  // here. The list is the bookkeeping that makes forgetting the first one fail.
  const ADDED_BY_MIGRATION = [
    'five-minute-gun',
    'warning-signal',
    'practice-start',
    'love-setup',
  ]

  const migrations = () => {
    const dir = 'supabase/migrations'
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs')
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => ({ file: f, sql: fs.readFileSync(`${dir}/${f}`, 'utf8') }))
      .filter((m) => /INSERT INTO public\.ssa_tag_defs/.test(m.sql))
  }

  /**
   * The INSERT BLOCK that defines this slug, not just the file holding it.
   *
   * Per block because one migration may define several tags, and a file-wide
   * match reads the first block's values whichever slug it was asked about —
   * which is how this test first reported a drift that belonged to its
   * neighbour.
   */
  const insertFor = (slug: string) => {
    for (const { file, sql } of migrations()) {
      for (const block of sql.split(/INSERT INTO public\.ssa_tag_defs/).slice(1)) {
        if (new RegExp(`'${slug}', '`).test(block)) return { file, block }
      }
    }
    return null
  }

  it('ships a migration for each tag added since teams started using the tagger', () => {
    for (const slug of ADDED_BY_MIGRATION) {
      expect(BASE_TAGS.find((t) => t.slug === slug), `${slug} is not in baseTags.ts`).toBeTruthy()
      expect(insertFor(slug), `no migration inserts ${slug} — existing teams will never see it`)
        .toBeTruthy()
    }
  })

  it('and the migration row still matches the code definition', () => {
    for (const slug of ADDED_BY_MIGRATION) {
      const def = BASE_TAGS.find((t) => t.slug === slug)!
      const { file, block } = insertFor(slug)!
      expect(block, `${file}: label`).toContain(`'${def.label}'`)
      expect(block, `${file}: colour`).toContain(`'${def.color}'`)
      expect(block, `${file}: kind + lead/lag`).toMatch(
        new RegExp(`'${def.kind}',\\s*${def.leadSec},\\s*${def.lagSec}`)
      )
      expect(block, `${file}: on_button_bar + sort`).toMatch(
        new RegExp(`${def.onButtonBar ? 'TRUE' : 'FALSE'},\\s*TRUE,\\s*${def.sort}`)
      )
    }
  })

  it("names the one migration whose descriptors have drifted from the code", () => {
    // 0096 gave practice-start Quality ["good","ok","poor"]; the code's QUALITY
    // is ["textbook","good","scrappy","slow","bad"]. So a team seeded before
    // 0096 offers three options on that tag and a team seeded today offers
    // five — the same tag, two vocabularies, which is the thing a shared coding
    // scheme exists to prevent.
    //
    // Recorded rather than fixed: correcting it is a migration of its own and a
    // decision about a team's existing data, not a side effect of adding a
    // button. This fails the moment the list is wrong in EITHER direction, so
    // fixing 0096 means deleting a line here.
    const drifted: string[] = []
    for (const slug of ADDED_BY_MIGRATION) {
      const def = BASE_TAGS.find((t) => t.slug === slug)!
      const { block } = insertFor(slug)!
      const groups = block.match(/'(\[.*?\])'::jsonb/s)?.[1]
      if (groups !== JSON.stringify(def.labelGroups)) drifted.push(slug)
    }
    expect(drifted).toEqual(['practice-start'])
  })
})

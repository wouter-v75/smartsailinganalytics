import { describe, it, expect } from 'vitest'
import {
  isComment, authorOf, toComment, commentsOf, teamComments, myComments,
  firstName, clip, commentLine, textOf,
} from '../comments'
import type { TagEvent } from '../types'

const T = (h: number, m: number) => Date.parse(`2026-09-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)

let n = 0
const tag = (over: Partial<TagEvent> = {}): TagEvent => ({
  id: `e${++n}`, teamId: 't', boatId: 'b', sessionId: null, sessionDate: '2026-09-11',
  tagDefId: null, slug: 'team-note', label: 'Team comment', color: '#7F77DD',
  scope: 'general', section: null, ownerUserId: null,
  t0: T(12, 21), t1: T(12, 21), autoT0: null, autoT1: null,
  targetKind: 'track', targetId: null, note: 'Kite hourglassed at the hoist.', labels: [],
  source: 'human', producer: 'user', detectionKey: null, confidence: null,
  editedFields: [], verifiedByUserId: null, verifiedAt: null,
  rejected: false, rejectedReason: null, reelOrder: null,
  createdByUserId: 'u1', meta: null,
  ...over,
})

const NAMES: Record<string, string> = { u1: 'Sam Whitcombe', u2: 'Wouter van Dam' }
const nameOf = (id: string) => NAMES[id] ?? null

describe('isComment', () => {
  it('is a person saying something', () => {
    expect(isComment(tag())).toBe(true)
  })

  it('takes a note typed onto any tag, not just the comment button', () => {
    // The whole reason the rule is about the DATA: a line typed on the tack you
    // made a mess of is a comment, and no new button should be needed for it.
    expect(isComment(tag({ slug: 'tack', label: 'Tack', note: 'Late release.' }))).toBe(true)
  })

  it('is not an empty one', () => {
    expect(isComment(tag({ note: '' }))).toBe(false)
    expect(isComment(tag({ note: '   ' }))).toBe(false)
    expect(isComment(tag({ note: null }))).toBe(false)
  })

  it('is not a detection, whatever the detector wrote', () => {
    expect(isComment(tag({ source: 'auto', producer: 'manoeuvres' }))).toBe(false)
    expect(isComment(tag({ source: 'ai' }))).toBe(false)
  })

  it('does not outlive the moment it was about', () => {
    expect(isComment(tag({ rejected: true }))).toBe(false)
  })

  it('reads the text trimmed', () => {
    expect(textOf(tag({ note: '  spoke too late  ' }))).toBe('spoke too late')
  })
})

describe('authorOf', () => {
  it('is whoever placed it', () => {
    expect(authorOf(tag())).toBe('u1')
  })

  it('falls back to a personal tag’s owner, which is the same person', () => {
    expect(authorOf(tag({ scope: 'personal', ownerUserId: 'u2', createdByUserId: null }))).toBe('u2')
  })

  it('is null for a row with nobody behind it', () => {
    expect(authorOf(tag({ createdByUserId: null }))).toBeNull()
  })
})

describe('commentsOf', () => {
  const day = [
    tag({ t0: T(14, 2), note: 'Second beat felt slow.' }),
    tag({ t0: T(12, 21), note: 'Kite hourglassed.' }),
    tag({ t0: T(13, 0), note: 'nothing', source: 'auto' }),
    tag({ t0: T(11, 50), scope: 'personal', ownerUserId: 'u2', createdByUserId: 'u2', note: 'Try more forestay.' }),
  ]

  it('is in the order things were said', () => {
    expect(commentsOf(day).map((c) => c.t0)).toEqual([T(11, 50), T(12, 21), T(14, 2)])
  })

  it('resolves the author’s name', () => {
    expect(commentsOf(day, nameOf)[1].authorName).toBe('Sam Whitcombe')
  })

  it('leaves a name it cannot resolve null rather than inventing one', () => {
    expect(commentsOf([tag({ createdByUserId: 'ghost' })], nameOf)[0].authorName).toBeNull()
  })

  it('separates what was said to the crew from what was noted privately', () => {
    const all = commentsOf(day, nameOf)
    expect(teamComments(all)).toHaveLength(2)
    expect(teamComments(all).every((c) => !c.personal)).toBe(true)
  })

  it('gives me mine — both kinds', () => {
    const all = commentsOf(day, nameOf)
    expect(myComments(all, 'u2').map((c) => c.text)).toEqual(['Try more forestay.'])
    expect(myComments(all, 'u1')).toHaveLength(2)
  })

  it('gives a signed-out reader nothing rather than everything', () => {
    expect(myComments(commentsOf(day), null)).toEqual([])
  })

  it('keeps the tag’s own label, so a note on a tack still says Tack', () => {
    const c = toComment(tag({ slug: 'tack', label: 'Tack', note: 'Late release.' }))
    expect(c.label).toBe('Tack')
  })
})

describe('firstName', () => {
  it('is the one word people actually say', () => {
    expect(firstName('Sam Whitcombe')).toBe('Sam')
    expect(firstName('Wouter van Dam')).toBe('Wouter')
  })

  it('reads a surname-first crew list', () => {
    expect(firstName('van Dam, Wouter')).toBe('Wouter')
  })

  it('falls back to an email’s local part for a member who never set a name', () => {
    expect(firstName('sam@example.com')).toBe('sam')
  })

  it('is never empty — a card with no name on it is worse than a generic one', () => {
    expect(firstName('')).toBe('Crew')
    expect(firstName(null)).toBe('Crew')
    expect(firstName('   ')).toBe('Crew')
    expect(firstName('@')).toBe('Crew')
  })
})

describe('clip', () => {
  it('leaves a short comment alone', () => {
    expect(clip('Kite up early.', 48)).toBe('Kite up early.')
  })

  it('ends on a word, because a mid-word cut reads as a bug', () => {
    const full = 'The second beat felt slow and we were low the whole way'
    const out = clip(full, 24)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(25)
    // Every word kept is a whole word: the clipped text, with the ellipsis
    // taken off, is a prefix of the original that stops at a space.
    const kept = out.slice(0, -1)
    expect(full.startsWith(kept)).toBe(true)
    expect(full[kept.length]).toBe(' ')
  })

  it('still cuts when one word is longer than the whole budget', () => {
    expect(clip('Antidisestablishmentarianism', 10)).toBe('Antidisest…')
  })

  it('flattens the newlines a textarea produces', () => {
    expect(clip('two\n\nlines')).toBe('two lines')
  })

  it('survives nothing at all', () => {
    expect(clip('')).toBe('')
  })
})

describe('commentLine', () => {
  it('is a name and what they said', () => {
    const c = toComment(tag({ note: 'Kite hourglassed at the hoist.' }), nameOf)
    expect(commentLine(c)).toBe('Sam: Kite hourglassed at the hoist.')
  })
})

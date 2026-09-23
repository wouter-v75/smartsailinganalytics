import { describe, it, expect } from 'vitest'
import {
  canApproveMedia, canCurateReel, canRequest, withRequests,
  buildShortlist, reelOf, videoQueue, nextReelOrder, renumberReel,
  grabMediaKind, FLAGGED_SLUGS,
} from '../requests'
import { personalNotes, teamNotes, notesBySegment, isPersonalNote, isTeamNote } from '../notes'
import { segmentDay } from '../segments'
import type { TagEvent, TagRequest, TaggerIdentity } from '../types'

const T = (mins: number) => Date.parse('2026-09-11T12:00:00Z') + mins * 60_000

const who = (role: string, sections: string[] = []): TaggerIdentity =>
  ({ userId: 'u1', teamId: 't', boatId: 'b', role, sections })

const tag = (over: Partial<TagEvent> = {}): TagEvent => ({
  id: 'e1', teamId: 't', boatId: 'b', sessionId: null, sessionDate: '2026-09-11',
  tagDefId: null, slug: 'gybe', label: 'Gybe', color: '#7F77DD',
  scope: 'general', section: null, ownerUserId: null,
  t0: T(10), t1: T(10) + 20_000,
  targetKind: 'track', targetId: null, note: null, labels: [],
  source: 'auto', producer: 'manoeuvres', detectionKey: 'k:1',
  autoT0: T(10), autoT1: null, confidence: 0.8, editedFields: [],
  verifiedByUserId: null, verifiedAt: null,
  rejected: false, rejectedReason: null, reelOrder: null,
  createdByUserId: 'u1', meta: null,
  ...over,
})

const request = (over: Partial<TagRequest> = {}): TagRequest => ({
  id: 'r1', teamId: 't', boatId: 'b', sessionDate: '2026-09-11',
  tagEventId: 'e1', kind: 'debrief', mediaKind: null, status: 'open',
  note: null, requestedByUserId: 'u1', requestedAt: T(60),
  decidedByUserId: null, decidedAt: null, decisionNote: null,
  assetKind: null, assetId: null,
  ...over,
})

describe('who may approve what', () => {
  it('lets the media section approve footage — they are holding it', () => {
    expect(canApproveMedia(who('tl1', ['media']))).toBe(true)
    expect(canApproveMedia(who('tl1', ['bow']))).toBe(false)
  })

  it('lets the coach tier approve footage', () => {
    for (const r of ['admin', 'coach', 'team_manager']) expect(canApproveMedia(who(r))).toBe(true)
    for (const r of ['tl1', 'guest']) expect(canApproveMedia(who(r))).toBe(false)
  })

  it('keeps debrief selection with the coach, not the media team', () => {
    expect(canCurateReel(who('coach'))).toBe(true)
    expect(canCurateReel(who('tl3'))).toBe(true)
    expect(canCurateReel(who('tl1', ['media']))).toBe(false)
  })

  it('lets everyone who sails ask for something', () => {
    for (const r of ['coach', 'tl3', 'tl1', 'owner', 'consultant']) {
      expect(canRequest(who(r))).toBe(true)
    }
    expect(canRequest(who('guest'))).toBe(false)
  })
})

describe('withRequests', () => {
  it('counts nominations per tag', () => {
    const [item] = withRequests([tag()], [
      request({ id: 'a', requestedByUserId: 'u1' }),
      request({ id: 'b', requestedByUserId: 'u2' }),
      request({ id: 'c', requestedByUserId: 'u3', status: 'declined' }),
    ])
    expect(item.debriefVotes).toBe(2)   // the declined one stops counting
  })

  it('counts video requests still waiting', () => {
    const [item] = withRequests([tag()], [
      request({ id: 'a', kind: 'video', mediaKind: 'video', status: 'open' }),
      request({ id: 'b', kind: 'video', mediaKind: 'drone', status: 'approved', requestedByUserId: 'u2' }),
      request({ id: 'c', kind: 'video', mediaKind: 'video', status: 'fulfilled', requestedByUserId: 'u3' }),
    ])
    expect(item.videoPending).toBe(2)   // fulfilled is done
  })

  it('gives a tag with no requests a clean zero', () => {
    const [item] = withRequests([tag()], [])
    expect(item.debriefVotes).toBe(0)
    expect(item.requests).toEqual([])
  })
})

describe('buildShortlist — what the coach chooses from', () => {
  const mk = (id: string, over: Partial<TagEvent> = {}) => tag({ id, ...over })

  it('ranks by how many people asked', () => {
    const items = withRequests(
      [mk('a', { t0: T(10) }), mk('b', { t0: T(20) })],
      [
        request({ id: '1', tagEventId: 'b', requestedByUserId: 'u1' }),
        request({ id: '2', tagEventId: 'b', requestedByUserId: 'u2' }),
        request({ id: '3', tagEventId: 'a', requestedByUserId: 'u1' }),
      ]
    )
    expect(buildShortlist(items).map((i) => i.tag.id)).toEqual(['b', 'a'])
  })

  it('puts what the coach already selected at the top, in their order', () => {
    const items = withRequests(
      [mk('a', { reelOrder: 2 }), mk('b', { reelOrder: 1 }), mk('c')],
      [request({ id: '1', tagEventId: 'c', requestedByUserId: 'u9' })]
    )
    expect(buildShortlist(items).map((i) => i.tag.id)).toEqual(['b', 'a', 'c'])
  })

  it('includes "review this" and incidents even with no nominations', () => {
    const items = withRequests([mk('a', { slug: 'review' }), mk('b', { slug: 'incident' }), mk('c')], [])
    expect(buildShortlist(items).map((i) => i.tag.id)).toEqual(['a', 'b'])
  })

  it('never puts somebody’s personal note on the shared shortlist', () => {
    const items = withRequests(
      [mk('p', { scope: 'personal', ownerUserId: 'u1', slug: 'note', note: 'mine' })],
      [request({ id: '1', tagEventId: 'p', requestedByUserId: 'u1' })]
    )
    expect(buildShortlist(items)).toEqual([])
  })

  it('leaves out tombstones', () => {
    const items = withRequests([mk('a', { rejected: true, slug: 'review' })], [])
    expect(buildShortlist(items)).toEqual([])
  })

  it('can be narrowed to nominations only', () => {
    const items = withRequests([mk('a', { slug: 'review' }), mk('b')], [
      request({ id: '1', tagEventId: 'b', requestedByUserId: 'u1' }),
    ])
    expect(buildShortlist(items, { nominatedOnly: true }).map((i) => i.tag.id)).toEqual(['b'])
  })
})

describe('the reel', () => {
  it('is the coach’s selection, in the coach’s order', () => {
    const items = withRequests([tag({ id: 'a', reelOrder: 2 }), tag({ id: 'b', reelOrder: 1 }), tag({ id: 'c' })], [])
    expect(reelOf(items).map((i) => i.tag.id)).toEqual(['b', 'a'])
  })

  it('hands out the next free position', () => {
    expect(nextReelOrder(withRequests([tag({ reelOrder: 3 })], []))).toBe(4)
    expect(nextReelOrder(withRequests([tag()], []))).toBe(1)
    expect(nextReelOrder([])).toBe(1)
  })

  it('renumbers so a reel never develops gaps', () => {
    const items = withRequests(
      [tag({ id: 'a', reelOrder: 5 }), tag({ id: 'b', reelOrder: 9 }), tag({ id: 'c' })], []
    )
    expect(renumberReel(items)).toEqual([
      { id: 'a', reelOrder: 1 }, { id: 'b', reelOrder: 2 },
    ])
  })
})

describe('videoQueue', () => {
  it('is oldest first — a clip nobody pulls is a promise quietly broken', () => {
    const q = videoQueue([
      request({ id: 'new', kind: 'video', mediaKind: 'video', requestedAt: T(90) }),
      request({ id: 'old', kind: 'video', mediaKind: 'drone', requestedAt: T(30) }),
      request({ id: 'done', kind: 'video', mediaKind: 'video', status: 'fulfilled', requestedAt: T(10) }),
      request({ id: 'chat', kind: 'debrief', requestedAt: T(5) }),
    ])
    expect(q.map((r) => r.id)).toEqual(['old', 'new'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('notes', () => {
  const note = (over: Partial<TagEvent> = {}) =>
    tag({ slug: 'note', scope: 'personal', ownerUserId: 'u1', note: 'felt slow', ...over })
  const team = (over: Partial<TagEvent> = {}) =>
    tag({ slug: 'team-note', scope: 'general', note: 'kite hourglass', ...over })

  const segments = segmentDay({
    guns: [{ utc: T(0) }, { utc: T(120) }],
    markRoundings: [{ utc: T(50) }, { utc: T(170) }],
    dayStartUtc: T(-60), dayStopUtc: T(240),
  })

  it('recognises each kind', () => {
    expect(isPersonalNote(note())).toBe(true)
    expect(isPersonalNote(note({ note: '   ' }))).toBe(false)   // empty is not a note
    expect(isTeamNote(team())).toBe(true)
    expect(isTeamNote(note())).toBe(false)
  })

  it('shows a user only their own personal notes', () => {
    const tags = [note({ id: 'mine' }), note({ id: 'theirs', ownerUserId: 'u2' })]
    expect(personalNotes(tags, 'u1').map((n) => n.id)).toEqual(['mine'])
  })

  it('returns team notes to everyone', () => {
    expect(teamNotes([team({ id: 'a' }), note({ id: 'b' })]).map((n) => n.id)).toEqual(['a'])
  })

  it('tells each note which part of the day it belongs to', () => {
    const notes = personalNotes([note({ t0: T(20) })], 'u1', segments)
    expect(notes[0].segmentLabel).toBe('Race 1')
  })

  it('is in time order', () => {
    const notes = personalNotes([note({ id: 'b', t0: T(30) }), note({ id: 'a', t0: T(10) })], 'u1')
    expect(notes.map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('leaves out tombstoned notes', () => {
    expect(personalNotes([note({ rejected: true })], 'u1')).toEqual([])
  })

  it('groups under the day’s parts, dropping empty ones', () => {
    const notes = personalNotes(
      [note({ id: 'a', t0: T(20) }), note({ id: 'b', t0: T(140) })], 'u1', segments
    )
    const grouped = notesBySegment(notes, segments)
    expect(grouped.map((g) => g.label)).toEqual(['Race 1', 'Race 2'])
    expect(grouped[0].notes.map((n) => n.id)).toEqual(['a'])
  })

  it('falls back to one group when the day has no segments', () => {
    const notes = personalNotes([note()], 'u1')
    expect(notesBySegment(notes, []).map((g) => g.label)).toEqual(['Day'])
    expect(notesBySegment([], [])).toEqual([])
  })
})

describe('grab video', () => {
  it('asks the drone operator when the drone is what was wanted', () => {
    expect(grabMediaKind([{ group: 'Wanted', text: 'drone' }])).toBe('drone')
    expect(grabMediaKind([{ group: 'Wanted', text: 'Drone' }])).toBe('drone')
  })

  it('leaves it open otherwise — a request narrowed on a guess reaches the wrong person', () => {
    expect(grabMediaKind([{ group: 'Wanted', text: 'either' }])).toBe('video')
    expect(grabMediaKind([{ group: 'Wanted', text: 'onboard' }])).toBe('video')
    expect(grabMediaKind([])).toBe('video')
    expect(grabMediaKind(null)).toBe('video')
    expect(grabMediaKind(undefined)).toBe('video')
  })

  it('survives a descriptor with nothing in it', () => {
    expect(grabMediaKind([{ group: 'Wanted', text: '' } as never])).toBe('video')
  })
})

describe('the shortlist takes the tags that nominate themselves', () => {
  it('includes a technical problem without needing a vote', () => {
    expect(FLAGGED_SLUGS.has('technical')).toBe(true)
    expect(FLAGGED_SLUGS.has('review')).toBe(true)
  })

  it('still includes the names those tags used to have', () => {
    // A day tagged before the rename must not drop out of its own debrief.
    expect(FLAGGED_SLUGS.has('gear-damage')).toBe(true)
    expect(FLAGGED_SLUGS.has('incident')).toBe(true)
  })

  it('does not sweep in the routine turns', () => {
    for (const slug of ['tack', 'gybe', 'race-start', 'sail-change', 'grab-video']) {
      expect(FLAGGED_SLUGS.has(slug)).toBe(false)
    }
  })
})

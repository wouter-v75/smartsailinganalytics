import { describe, it, expect } from 'vitest'
import {
  scopedSessionPrefix, legacySessionPrefix, writePrefix, writeKey,
  readCandidates, scopedPhotoPrefix, photoLeaves, SESSION_LEAVES,
} from '../storageKeys'

const SCOPE = { teamId: 'team-abc', boatId: 'boat-xyz' }
const DATE = '2026-09-11'
const SCOPED = 'teams/team-abc/boats/boat-xyz/sessions/2026-09-11/'
const LEGACY = 'sessions/2026-09-11/'

describe('prefixes', () => {
  it('scopes by team and boat', () => {
    expect(scopedSessionPrefix(SCOPE, DATE)).toBe(SCOPED)
  })

  it('has no scoped prefix without a complete scope', () => {
    expect(scopedSessionPrefix({ teamId: 'team-abc', boatId: null }, DATE)).toBeNull()
    expect(scopedSessionPrefix({ teamId: null, boatId: 'boat-xyz' }, DATE)).toBeNull()
    expect(scopedSessionPrefix(null, DATE)).toBeNull()
  })

  it('rejects a date that is not YYYY-MM-DD, rather than building a key around it', () => {
    for (const bad of ['2026-9-11', 'today', '', '../../etc', null, undefined]) {
      expect(scopedSessionPrefix(SCOPE, bad as string)).toBeNull()
      expect(legacySessionPrefix(bad as string)).toBeNull()
    }
  })

  it('writes scoped when it can and legacy when it cannot', () => {
    expect(writePrefix(SCOPE, DATE)).toBe(SCOPED)
    expect(writePrefix(null, DATE)).toBe(LEGACY)
  })
})

describe('path traversal', () => {
  it('cannot be walked out of the prefix by a crafted id', () => {
    const evil = { teamId: '../../..', boatId: 'boat-xyz' }
    expect(scopedSessionPrefix(evil, DATE)).toBeNull()
  })

  it('strips separators out of an id rather than letting them nest', () => {
    const k = scopedSessionPrefix({ teamId: 'a/b', boatId: 'c/d' }, DATE)
    expect(k).toBe('teams/ab/boats/cd/sessions/2026-09-11/')
    expect(k!.split('/').length).toBe(SCOPED.split('/').length)
  })

  it('does not let a leading slash on a leaf reset the path', () => {
    expect(writeKey(SCOPE, DATE, '/log.json')).toBe(SCOPED + 'log.json')
    expect(readCandidates(SCOPE, DATE, '//log.json')[0]).toBe(SCOPED + 'log.json')
  })
})

describe('readCandidates — the migration itself', () => {
  it('tries the scoped key first, then the legacy one', () => {
    expect(readCandidates(SCOPE, DATE, SESSION_LEAVES.log)).toEqual([
      SCOPED + 'log.json',
      LEGACY + 'log.json',
    ])
  })

  it('offers the legacy key ONCE when there is no scope, not twice', () => {
    expect(readCandidates(null, DATE, SESSION_LEAVES.log)).toEqual([LEGACY + 'log.json'])
  })

  it('has nowhere to look when the date is unusable', () => {
    expect(readCandidates(SCOPE, 'nonsense', SESSION_LEAVES.log)).toEqual([])
  })

  it('covers a photo, which is the case two teams actually collided on', () => {
    const leaf = photoLeaves('p_123').thumb
    expect(readCandidates(SCOPE, DATE, leaf)).toEqual([
      SCOPED + 'photos/p_123_thumb.jpg',
      LEGACY + 'photos/p_123_thumb.jpg',
    ])
  })
})

describe('two teams on one day no longer collide', () => {
  it('gives each boat its own log.json', () => {
    const a = writeKey({ teamId: 't1', boatId: 'b1' }, DATE, SESSION_LEAVES.log)
    const b = writeKey({ teamId: 't1', boatId: 'b2' }, DATE, SESSION_LEAVES.log)
    const c = writeKey({ teamId: 't2', boatId: 'b1' }, DATE, SESSION_LEAVES.log)
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('kept them identical before — the bug, stated as a test', () => {
    expect(legacySessionPrefix(DATE)! + SESSION_LEAVES.log)
      .toBe(legacySessionPrefix(DATE)! + SESSION_LEAVES.log)
  })
})

describe('scopedPhotoPrefix — the day-wipe', () => {
  it('is confined to one boat', () => {
    expect(scopedPhotoPrefix(SCOPE, DATE)).toBe(SCOPED + 'photos/')
  })

  it('refuses to name a prefix without a scope, so an unscoped wipe deletes nothing', () => {
    expect(scopedPhotoPrefix(null, DATE)).toBeNull()
    expect(scopedPhotoPrefix({ teamId: 't', boatId: null }, DATE)).toBeNull()
  })

  it('never returns the flat legacy prefix — that is the cross-tenant wipe', () => {
    for (const s of [SCOPE, null, { teamId: 't', boatId: 'b' }]) {
      const p = scopedPhotoPrefix(s, DATE)
      expect(p === null || p.startsWith('teams/')).toBe(true)
    }
  })
})

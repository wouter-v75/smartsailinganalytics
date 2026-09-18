import { describe, it, expect } from 'vitest'
import {
  classifyDate, canClaim, isMigratable, summarise,
  type SessionClaim, type DateAudit,
} from '../storageAudit'

const A = { teamId: 't1', boatId: 'b1' }
const B = { teamId: 't1', boatId: 'b2' }
const DATE = '2026-09-11'

const claim = (date: string, s: { teamId: string; boatId: string }): SessionClaim =>
  ({ date, team_id: s.teamId, boat_id: s.boatId })

describe('classifyDate', () => {
  it('one claimant is unambiguous', () => {
    expect(classifyDate(DATE, [claim(DATE, A)])).toEqual({ kind: 'unambiguous', ...A })
  })

  it('two boats on one day is the collision this is looking for', () => {
    const v = classifyDate(DATE, [claim(DATE, A), claim(DATE, B)])
    expect(v.kind).toBe('collision')
    if (v.kind === 'collision') expect(v.claimants).toHaveLength(2)
  })

  it('counts a boat once however many rows it has for the day', () => {
    expect(classifyDate(DATE, [claim(DATE, A), claim(DATE, A), claim(DATE, A)]))
      .toEqual({ kind: 'unambiguous', ...A })
  })

  it('ignores other dates entirely', () => {
    expect(classifyDate(DATE, [claim('2026-09-10', A), claim('2026-09-12', B)]))
      .toEqual({ kind: 'unclaimed' })
  })

  it('is unclaimed with no rows', () => {
    expect(classifyDate(DATE, [])).toEqual({ kind: 'unclaimed' })
  })

  it('does not treat a half-tagged row as a claimant — it cannot say whose the bytes are', () => {
    const rows: SessionClaim[] = [
      { date: DATE, team_id: 't1', boat_id: null },
      { date: DATE, team_id: null, boat_id: 'b1' },
    ]
    expect(classifyDate(DATE, rows)).toEqual({ kind: 'unclaimed' })
  })

  it('a half-tagged row does not turn one real claimant into a collision', () => {
    const rows: SessionClaim[] = [claim(DATE, A), { date: DATE, team_id: 't1', boat_id: null }]
    expect(classifyDate(DATE, rows)).toEqual({ kind: 'unambiguous', ...A })
  })
})

describe('canClaim', () => {
  it('lets the single claimant claim', () => {
    expect(canClaim(classifyDate(DATE, [claim(DATE, A)]), A)).toBe(true)
  })

  it('refuses a boat that is not the claimant', () => {
    expect(canClaim(classifyDate(DATE, [claim(DATE, A)]), B)).toBe(false)
  })

  it('NEVER auto-resolves a collision, even for a genuine claimant', () => {
    const v = classifyDate(DATE, [claim(DATE, A), claim(DATE, B)])
    expect(canClaim(v, A)).toBe(false)
    expect(canClaim(v, B)).toBe(false)
  })

  it('refuses an unclaimed day', () => {
    expect(canClaim({ kind: 'unclaimed' }, A)).toBe(false)
  })
})

describe('isMigratable', () => {
  it('takes the five session JSON files', () => {
    for (const f of ['log.json', 'events.json', 'meta.json', 'photos.json', 'sync-manifest.json']) {
      expect(isMigratable(f)).toBe(true)
    }
  })

  it('leaves everything whose key is stored in the database', () => {
    // These are read back verbatim from bunny_storage_path / bunny_proxy_path /
    // bunny_original_path, so moving them would break the rows pointing at them.
    for (const f of ['p_123.jpg', 'p_123_thumb.jpg', 'v_abc.mp4', 'original', 'photos', 'proxies']) {
      expect(isMigratable(f)).toBe(false)
    }
  })
})

describe('summarise', () => {
  it('counts what a reader needs: which days lost data, and how many can be claimed', () => {
    const audits: DateAudit[] = [
      { date: 'd1', verdict: { kind: 'unambiguous', ...A }, sessionFiles: [], directories: [] },
      { date: 'd2', verdict: { kind: 'collision', claimants: [A, B] }, sessionFiles: [], directories: [] },
      { date: 'd3', verdict: { kind: 'unclaimed' }, sessionFiles: [], directories: [] },
      { date: 'd4', verdict: { kind: 'unambiguous', ...B }, sessionFiles: [], directories: [] },
    ]
    expect(summarise(audits)).toEqual({
      dates: 4, collisions: ['d2'], unclaimed: ['d3'], claimable: 2,
    })
  })
})

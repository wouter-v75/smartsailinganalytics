import { describe, it, expect } from 'vitest'
import { codeState, isLive, codeNote, type SquadCode } from '../squadCodes'

const NOW = Date.parse('2026-09-22T12:00:00Z')
const c = (o: Partial<SquadCode> = {}): SquadCode => ({
  id: 'c1', token: 'PALMA-ABC123', max_uses: 5, used_count: 0,
  expires_at: '2026-10-22T12:00:00Z', revoked_at: null, ...o,
})

describe('codeState — must agree with redeem_squad_code()', () => {
  it('is live when unwithdrawn, unexpired and unspent', () => {
    expect(codeState(c(), NOW)).toBe('live')
    expect(isLive(c(), NOW)).toBe(true)
  })

  it('distinguishes the three ways a code stops working', () => {
    // The verdict is the same; the REASON decides whether the manager mints
    // another or asks what happened.
    expect(codeState(c({ revoked_at: '2026-09-20T00:00:00Z' }), NOW)).toBe('withdrawn')
    expect(codeState(c({ expires_at: '2026-09-21T00:00:00Z' }), NOW)).toBe('expired')
    expect(codeState(c({ used_count: 5, max_uses: 5 }), NOW)).toBe('used-up')
  })

  it('ranks withdrawn above expired — a decision outranks the clock', () => {
    const both = c({ revoked_at: '2026-09-19T00:00:00Z', expires_at: '2026-09-20T00:00:00Z' })
    expect(codeState(both, NOW)).toBe('withdrawn')
  })

  it('treats an unparseable expiry as expired, never as live', () => {
    // Failing closed is the only safe direction for a capability.
    expect(codeState(c({ expires_at: 'not a date' }), NOW)).toBe('expired')
    expect(isLive(c({ expires_at: '' }), NOW)).toBe(false)
  })

  it('expires exactly ON the boundary rather than a moment after', () => {
    expect(codeState(c({ expires_at: '2026-09-22T12:00:00Z' }), NOW)).toBe('expired')
  })

  it('counts over-use as used up, not merely equal', () => {
    expect(codeState(c({ used_count: 9, max_uses: 5 }), NOW)).toBe('used-up')
  })
})

describe('codeNote', () => {
  it('says nothing for a live code — it needs no label', () => {
    expect(codeNote(c(), NOW)).toBe('')
  })
  it('names the reason otherwise', () => {
    expect(codeNote(c({ revoked_at: 'x' }), NOW)).toBe('withdrawn')
    expect(codeNote(c({ used_count: 5 }), NOW)).toBe('used up')
  })
})

import { describe, it, expect } from 'vitest'
import { nearMiss, describeNearMisses } from '../inviteNearMiss'

// ─────────────────────────────────────────────────────────────────────────────
// 21 October 2026: Chris Taylor had no invitation to the address he gave, and
// one had definitely been sent. Both can be true at once only if the address
// invited is not the address asked about — and one mistyped character is
// invisible in a form, in a sent mail, and in a verdict that says "no row".
// ─────────────────────────────────────────────────────────────────────────────

const ASKED = 'chris.taylor@doylesails.com'

describe('nearMiss', () => {
  it('catches a misspelt name at the right domain', () => {
    expect(nearMiss(ASKED, 'chris.tailor@doylesails.com')?.near).toBe(true)
    expect(nearMiss(ASKED, 'chris.taylr@doylesails.com')?.near).toBe(true)
    // Four characters of edit distance, so only the surviving surname catches it.
    expect(nearMiss(ASKED, 'c.taylor@doylesails.com')?.why).toMatch(/contain "taylor"/)
    expect(nearMiss(ASKED, 'ctaylor@doylesails.com')?.near).toBe(true)
  })

  it('catches the right name at a misspelt domain', () => {
    expect(nearMiss(ASKED, 'chris.taylor@doylesail.com')?.near).toBe(true)
    expect(nearMiss(ASKED, 'chris.taylor@doylesails.co')?.why).toMatch(/same name/)
  })

  it('does not flag a DIFFERENT colleague at the same company', () => {
    // The whole value of this is that it points at one row. Flagging every
    // address at the sailmaker would point at none.
    expect(nearMiss(ASKED, 'jane.wilkinson@doylesails.com')).toBeNull()
    expect(nearMiss(ASKED, 'svea@doylesails.com')).toBeNull()
  })

  it('does not flag an unrelated address', () => {
    expect(nearMiss(ASKED, 'wouterv@runbox.com')).toBeNull()
    expect(nearMiss(ASKED, 'gwenael.leguen@gmail.com')).toBeNull()
  })

  it('says nothing about the address itself', () => {
    // It is only reached when THIS address has no invitation, so finding it
    // would be a contradiction; either way it is not a near miss.
    expect(nearMiss(ASKED, ASKED)).toBeNull()
  })

  it('survives a malformed address rather than throwing', () => {
    expect(nearMiss(ASKED, 'not-an-address')).toBeNull()
    expect(nearMiss('no-at-sign', ASKED)).toBeNull()
    expect(nearMiss(ASKED, '')).toBeNull()
  })
})

describe('describeNearMisses', () => {
  const rows = [
    { email: 'chris.tailor@doylesails.com', role: 'consultant', created_at: '2026-10-14T09:00:00Z' },
    { email: 'wijbren@example.invalid', role: 'tl1', created_at: '2026-10-09T09:00:00Z' },
  ]

  it('marks the near miss and leaves the rest alone', () => {
    const lines = describeNearMisses(ASKED, rows).join('\n')
    expect(lines).toMatch(/⚠ chris\.tailor@doylesails\.com/)
    expect(lines).not.toMatch(/⚠ wijbren/)
  })

  it('says what to do about it, once', () => {
    const lines = describeNearMisses(ASKED, rows).join('\n')
    expect(lines).toMatch(/inviting the RIGHT address/)
    expect(lines).toMatch(/Nothing was sent to him/)
  })

  it('keeps quiet about the remedy when nothing is close', () => {
    const far = [{ email: 'someone.else@elsewhere.com', role: 'tl1', created_at: '2026-10-14T09:00:00Z' }]
    const lines = describeNearMisses(ASKED, far).join('\n')
    expect(lines).not.toMatch(/inviting the RIGHT address/)
    expect(lines).toMatch(/someone\.else@elsewhere\.com/)
  })

  it('distinguishes "no invite for him" from "no invite at all"', () => {
    // Two different conversations: one is a typo to find, the other is an
    // invitation somebody believes they sent and did not.
    expect(describeNearMisses(ASKED, []).join('\n')).toMatch(/none was ever made/)
  })

  it('tolerates a row with nulls in it', () => {
    const odd = [{ email: null, role: null, created_at: null }]
    expect(() => describeNearMisses(ASKED, odd)).not.toThrow()
  })
})

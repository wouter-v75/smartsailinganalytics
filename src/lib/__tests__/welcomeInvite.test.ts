import { describe, it, expect } from 'vitest'
import { classifyInvite } from '../welcome-invite'
import { authEventLevel, describeAuthEvent, isAuthProblem } from '../authEvents'

const NOW = Date.parse('2026-10-06T10:00:00Z')
const inv = (over: Record<string, unknown> = {}) => ({
  used_count: 0, max_uses: 1,
  expires_at: '2026-10-20T10:00:00Z', revoked_at: null,
  ...over,
})

describe('classifyInvite', () => {
  it('is valid while it is unused, unexpired and not revoked', () => {
    expect(classifyInvite(inv(), NOW)).toBe('valid')
  })

  it('knows the three ways it can be dead, and says which', () => {
    // Each one gets a different sentence on the page, so they must not collapse
    // into one "invalid".
    expect(classifyInvite(inv({ used_count: 1 }), NOW)).toBe('used')
    expect(classifyInvite(inv({ expires_at: '2026-10-05T10:00:00Z' }), NOW)).toBe('expired')
    expect(classifyInvite(inv({ revoked_at: '2026-10-05T10:00:00Z' }), NOW)).toBe('revoked')
    expect(classifyInvite(null, NOW)).toBe('missing')
  })

  it('puts revoked above expired above used', () => {
    // A withdrawn invitation is "ask your manager" whatever else is true of it.
    const dead = inv({ used_count: 9, expires_at: '2026-01-01T00:00:00Z', revoked_at: '2026-01-02T00:00:00Z' })
    expect(classifyInvite(dead, NOW)).toBe('revoked')
    expect(classifyInvite(inv({ used_count: 9, expires_at: '2026-01-01T00:00:00Z' }), NOW)).toBe('expired')
  })

  it('treats a multi-use link as live until its last use', () => {
    expect(classifyInvite(inv({ max_uses: 20, used_count: 19 }), NOW)).toBe('valid')
    expect(classifyInvite(inv({ max_uses: 20, used_count: 20 }), NOW)).toBe('used')
  })

  it('does not call a row dead because a field is missing', () => {
    // An older row with no expiry is not an expired row.
    expect(classifyInvite({ used_count: 0, max_uses: 1 }, NOW)).toBe('valid')
    expect(classifyInvite({ expires_at: 'not-a-date' }, NOW)).toBe('valid')
  })
})

describe('auth events', () => {
  it('separates what a manager must act on from what is routine', () => {
    expect(isAuthProblem('invitation.create')).toBe(false)
    expect(isAuthProblem('welcome.password_set')).toBe(false)
    expect(isAuthProblem('invitation.email_failed')).toBe(true)
    expect(isAuthProblem('user.approve_email_failed')).toBe(true)
    expect(authEventLevel('invitation.provision_refused')).toBe('warn')
  })

  it('says what happened in one sentence, with the reason when there is one', () => {
    expect(describeAuthEvent('invitation.email_failed', { to: 'gwen@example.com', error: 'domain not verified' }))
      .toBe('The invitation email to gwen@example.com was refused — domain not verified')
    expect(describeAuthEvent('welcome.link_dead', { to: 'gwen@example.com', state: 'expired' }))
      .toBe('gwen@example.com opened an invitation link that was expired.')
    expect(describeAuthEvent('join.requested', { to: 'new@example.com' }))
      .toBe('new@example.com asked to join from the QR code and is waiting for approval.')
  })

  it('distinguishes a provisioned invite whose email failed from one that landed', () => {
    expect(describeAuthEvent('invitation.provisioned', { to: 'a@b.c', email_sent: false, error: 'rate limited' }))
      .toContain('the email did not send')
    expect(describeAuthEvent('invitation.provisioned', { to: 'a@b.c', email_sent: true }))
      .toBe('a@b.c was set up and emailed.')
  })

  it('falls back to the action name rather than dropping an event it has no words for', () => {
    expect(describeAuthEvent('something.new', { error: 'boom' })).toBe('something.new — boom')
  })
})

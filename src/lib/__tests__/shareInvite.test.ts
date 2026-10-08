import { describe, it, expect } from 'vitest'
import {
  inviteMessage, inviteSubject, mailtoHref, qrFileName, whatsappHref,
} from '../shareInvite'

const open = {
  teamName: 'Northstar Racing',
  url: 'https://ssa.wvsailing.co.uk/join/abc123',
  inviterName: 'Wouter',
}
const personal = { ...open, url: 'https://ssa.wvsailing.co.uk/welcome/xyz789', personal: true }

describe('inviteMessage', () => {
  it('says who, what and what happens next', () => {
    const m = inviteMessage(open)
    expect(m).toContain('Wouter has invited you')
    expect(m).toContain('Northstar Racing')
    expect(m).toContain('choose a password')
    expect(m).toContain('approves you')
    expect(m.endsWith(open.url)).toBe(true)
  })

  it('warns, and does NOT invite forwarding, for a personal link', () => {
    // /welcome sets that person's password. A message that reads like a group
    // invitation is how it ends up in a group.
    const m = inviteMessage(personal)
    expect(m).toContain('yours alone')
    expect(m).toContain('do not forward')
    expect(m).not.toContain('approves you')
  })

  it('works without an inviter name', () => {
    expect(inviteMessage({ ...open, inviterName: null })).toContain('You have been invited')
  })
})

describe('inviteSubject', () => {
  it('differs for the two kinds', () => {
    expect(inviteSubject(open)).toBe('Join Northstar Racing on SSA')
    expect(inviteSubject(personal)).toBe('Your SSA access to Northstar Racing')
  })
})

describe('whatsappHref', () => {
  it('uses wa.me with no number, so the app asks who', () => {
    const h = whatsappHref('hello there')
    expect(h.startsWith('https://wa.me/?text=')).toBe(true)
    expect(h).toContain('hello%20there')
  })

  it('survives a message with newlines and an ampersand', () => {
    const h = whatsappHref('one\ntwo & three')
    expect(h).toContain('%0A')
    expect(h).toContain('%26')
    expect(h).not.toContain('\n')
  })
})

describe('mailtoHref', () => {
  it('percent-encodes spaces rather than leaving a + in the subject', () => {
    // URLSearchParams gives '+', which several mail clients render literally.
    const h = mailtoHref('Join Northstar on SSA', 'line one\nline two')
    expect(h).toContain('subject=Join%20Northstar%20on%20SSA')
    expect(h).not.toContain('+')
    expect(h).toContain('%0A')
  })

  it('has no recipient unless one is given', () => {
    expect(mailtoHref('s', 'b').startsWith('mailto:?')).toBe(true)
    expect(mailtoHref('s', 'b', 'crew@example.com')).toContain('mailto:crew%40example.com?')
  })
})

describe('qrFileName', () => {
  it('is recognisable in a downloads folder a week later', () => {
    expect(qrFileName('Northstar Racing')).toBe('northstar-racing-ssa-join.png')
    expect(qrFileName('Baraka GP')).toBe('baraka-gp-ssa-join.png')
  })
  it('copes with a name that is all punctuation', () => {
    expect(qrFileName('—')).toBe('team-ssa-join.png')
    expect(qrFileName('')).toBe('team-ssa-join.png')
  })
})

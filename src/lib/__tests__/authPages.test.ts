import { describe, it, expect } from 'vitest'
import { checkPassword, esc, messagePage, passwordFormPage, MIN_PASSWORD } from '../auth-pages'

describe('passwordFormPage', () => {
  const page = passwordFormPage({
    hidden: { token: 'tok-123', nothing: null },
    email: 'gwen@example.com',
    heading: 'Welcome to SSA',
    intro: 'Northstar 76 is already set up for you.',
  })

  it('carries the token and drops empty hidden fields', () => {
    expect(page).toContain('name="token" value="tok-123"')
    expect(page).not.toContain('name="nothing"')
  })

  it('shows the address but does not submit it', () => {
    // The account that gets the password is whichever one the TOKEN resolves
    // to. A submitted address could be edited in the link and point the form
    // at somebody else on screen.
    expect(page).toContain('value="gwen@example.com" readonly')
    expect(page).not.toMatch(/name="email"/)
  })

  it('asks for the password twice, with the floor on both', () => {
    expect(page).toContain('name="password"')
    expect(page).toContain('name="confirm"')
    expect(page.match(new RegExp(`minlength="${MIN_PASSWORD}"`, 'g'))).toHaveLength(2)
  })

  it('keeps itself out of search engines and out of caches', () => {
    expect(page).toContain('noindex')
  })

  it('escapes what it is given rather than rendering it', () => {
    const nasty = passwordFormPage({
      hidden: { token: '"><script>alert(1)</script>' },
      email: '<img src=x onerror=alert(1)>',
      error: '</form><script>alert(2)</script>',
    })
    expect(nasty).not.toContain('<script>')
    expect(nasty).toContain('&lt;script&gt;')
  })

  it('shows an error without losing the token', () => {
    const withErr = passwordFormPage({ hidden: { token: 'tok-9' }, error: 'The two passwords do not match.' })
    expect(withErr).toContain('The two passwords do not match.')
    expect(withErr).toContain('value="tok-9"')
  })
})

describe('messagePage', () => {
  it('always offers a way onward', () => {
    const p = messagePage({
      heading: 'This link cannot be used',
      body: 'That invitation has expired.',
      linkHref: 'https://ssa.example/login',
      linkText: 'Go to the sign-in page',
    })
    expect(p).toContain('This link cannot be used')
    expect(p).toContain('href="https://ssa.example/login"')
    expect(p).toContain('Go to the sign-in page')
  })
})

describe('checkPassword', () => {
  it('accepts a long enough pair that matches', () => {
    expect(checkPassword('longenough', 'longenough')).toBeNull()
  })
  it('names the actual problem, because "invalid" tells nobody anything', () => {
    expect(checkPassword('short', 'short')).toContain('at least 8')
    expect(checkPassword('longenough', 'longenoug')).toContain('do not match')
    expect(checkPassword(null, null)).toContain('at least 8')
  })
  it('does not treat a missing confirmation as a match', () => {
    expect(checkPassword('longenough', null)).toContain('do not match')
  })
})

describe('esc', () => {
  it('covers the four characters that break an attribute', () => {
    expect(esc('<&">')).toBe('&lt;&amp;&quot;&gt;')
  })
})

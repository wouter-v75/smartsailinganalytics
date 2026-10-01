import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// The point of every test here is the SAME SENTENCE: a GET must not spend the
// token. Gwenael's link was minted at 18:49:50 and signed somebody in at
// 18:51:39 — an iPhone link preview, fetching the URL to draw the little card
// under the message. verifyOtp is single-use, so by the time he tapped it there
// was nothing left, and the page told him a two-minute-old link had expired.
// ─────────────────────────────────────────────────────────────────────────────

const verifyOtp = vi.fn()
const exchangeCodeForSession = vi.fn()
const updateUser = vi.fn()
const redeemInvitation = vi.fn()

vi.mock('../../../../lib/supabase/server', () => ({
  getServerSupabase: () => ({ auth: { verifyOtp, exchangeCodeForSession, updateUser } }),
}))
vi.mock('../../../../lib/invitation-redeem', () => ({
  redeemInvitation: (...a: unknown[]) => redeemInvitation(...a),
}))

const { GET, POST } = await import('../route')

const ORIGIN = 'https://ssa.wvsailing.co.uk'
const LINK = `${ORIGIN}/auth/callback?token_hash=abc123&type=recovery&next=%2Fauth%2Freset-password`

const get = (url: string) => GET(new Request(url) as never)
// An HTML form with no enctype posts urlencoded, which is what the page sends.
const post = (fields: Record<string, string>) =>
  POST(new Request(`${ORIGIN}/auth/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  }) as never)

beforeEach(() => {
  verifyOtp.mockReset().mockResolvedValue({ data: { user: { id: 'u1', email: 'g@x.com' } }, error: null })
  exchangeCodeForSession.mockReset().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null })
  updateUser.mockReset().mockResolvedValue({ data: {}, error: null })
  redeemInvitation.mockReset().mockResolvedValue(undefined)
})

describe('GET with an emailed token — the preview-bot case', () => {
  it('spends nothing', async () => {
    await get(LINK)
    expect(verifyOtp).not.toHaveBeenCalled()
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
  })

  it('serves the password form rather than redirecting', async () => {
    const res = await get(LINK)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/text\/html/)
    const html = await res.text()
    expect(html).toMatch(/<form[^>]+method="POST"/i)
    expect(html).toMatch(/Choose a password/)
    expect(html).toContain('name="password"')
    expect(html).toContain('name="confirm"')
  })

  it('fills the address in, read-only, and does not submit it', async () => {
    // One screen: their address is already known, so they type a password and
    // nothing else. It is readonly and has no `name`, because the account that
    // gets the password is whichever the TOKEN resolves to — trusting a query
    // string here would point a valid token at a different address on screen.
    const html = await (await get(`${LINK}&email=g%40x.com`)).text()
    expect(html).toContain('value="g@x.com" readonly')
    expect(html).not.toMatch(/<input[^>]+id="email"[^>]+name=/)
  })

  it('carries the token, the type and the destination into the form', async () => {
    const html = await (await get(`${LINK}&invite=inv9`)).text()
    expect(html).toContain('name="token_hash" value="abc123"')
    expect(html).toContain('name="type" value="recovery"')
    expect(html).toContain('name="next" value="/auth/reset-password"')
    expect(html).toContain('name="invite" value="inv9"')
  })

  it('is never cached — the page carries somebody’s token', async () => {
    const res = await get(LINK)
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/)
  })

  it('escapes what it puts in the form', async () => {
    // A token is hex in practice, but nothing downstream guarantees that and an
    // unescaped value in an attribute is an injection.
    const html = await (await get(
      `${ORIGIN}/auth/callback?token_hash=a"><script>x</script>&type=recovery&next=%2F`
    )).text()
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
  })

  it('does not interstitial a type it does not recognise', async () => {
    // Falls through to the ordinary path, which reports that there was nothing
    // usable in the link rather than rendering a button that cannot work.
    const res = await get(`${ORIGIN}/auth/callback?token_hash=abc&type=banana&next=%2F`)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toMatch(/authError=/)
  })
})

describe('POST — where the token is spent and the password set', () => {
  const good = { token_hash: 'abc123', type: 'recovery', next: '/', password: 'correcthorse', confirm: 'correcthorse' }

  it('verifies, sets the password, and lands them in the app signed in', async () => {
    const res = await post(good)
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: 'abc123' })
    expect(updateUser).toHaveBeenCalledWith({ password: 'correcthorse' })
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`)
  })

  it('sets the password on the SAME client that verified', async () => {
    // A second getServerSupabase() would not carry the cookies verifyOtp just
    // wrote, so updateUser would have no session to act on.
    await post(good)
    expect(updateUser).toHaveBeenCalledTimes(1)
    expect(verifyOtp.mock.invocationCallOrder[0]).toBeLessThan(updateUser.mock.invocationCallOrder[0])
  })

  it('does NOT spend the token when the passwords do not match', async () => {
    // A typo must cost a re-type, not the link. There is no second link coming:
    // that is the whole reason this flow exists.
    const res = await post({ ...good, confirm: 'something else' })
    expect(verifyOtp).not.toHaveBeenCalled()
    expect(res.status).toBe(200)
    expect(await res.text()).toMatch(/do not match/)
  })

  it('does NOT spend the token on a too-short password', async () => {
    const res = await post({ ...good, password: 'short', confirm: 'short' })
    expect(verifyOtp).not.toHaveBeenCalled()
    expect(await res.text()).toMatch(/at least 8 characters/i)
  })

  it('keeps the token in the re-rendered form, so one typo is not fatal', async () => {
    const html = await (await post({ ...good, confirm: 'x', shown_email: 'g@x.com' })).text()
    expect(html).toContain('name="token_hash" value="abc123"')
    expect(html).toContain('value="g@x.com" readonly')
  })

  it('does not try to set a password when the token was already spent', async () => {
    verifyOtp.mockResolvedValue({ data: null, error: { message: 'Email link is invalid or has expired' } })
    const res = await post(good)
    expect(updateUser).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toContain('authError=')
  })

  it('redeems an invite that rode along', async () => {
    await post({ ...good, invite: 'inv9' })
    expect(redeemInvitation).toHaveBeenCalledWith({ token: 'inv9', user: { id: 'u1', email: 'g@x.com' } })
  })

  it('does not redeem an invite when the sign-in failed', async () => {
    verifyOtp.mockResolvedValue({ data: null, error: { message: 'nope' } })
    await post({ ...good, invite: 'inv9' })
    expect(redeemInvitation).not.toHaveBeenCalled()
  })
})

describe('GET with ?code= — PKCE, which was never exposed to this', () => {
  // A code arrives as a redirect from the provider, in the browser that began
  // the flow. It is not a link anybody shares and not one a scanner sees, so it
  // keeps working on GET and costs the user no extra press.
  it('still exchanges on GET', async () => {
    const res = await get(`${ORIGIN}/auth/callback?code=xyz&next=%2F`)
    expect(exchangeCodeForSession).toHaveBeenCalledWith('xyz')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`)
  })

  it('says which failure happened', async () => {
    exchangeCodeForSession.mockResolvedValue({ data: null, error: { message: 'bad verifier' } })
    const res = await get(`${ORIGIN}/auth/callback?code=xyz&next=%2F`)
    expect(res.headers.get('location')).toContain('authError=bad+verifier')
  })

  it('reports a link with nothing in it', async () => {
    const res = await get(`${ORIGIN}/auth/callback?next=%2F`)
    expect(res.headers.get('location')).toContain('authError=')
  })
})

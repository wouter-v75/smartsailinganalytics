import { describe, it, expect, vi, beforeEach } from 'vitest'

// The route exists because Supabase's built-in SMTP delivered nothing twice in
// three days and reported success both times. So the two things worth pinning
// are: the mail actually goes through Resend, and the endpoint — which has to
// be unauthenticated — says nothing about who has an account.

const firstLoginLink = vi.fn()
const sendPasswordResetEmail = vi.fn()

vi.mock('../../../../../lib/provision-member', () => ({
  firstLoginLink: (...a: unknown[]) => firstLoginLink(...a),
  normaliseEmail: (e: string) => String(e || '').trim().toLowerCase(),
}))
vi.mock('../../../../../lib/email', () => ({
  sendPasswordResetEmail: (...a: unknown[]) => sendPasswordResetEmail(...a),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }))

const { POST } = await import('../route')

const ORIGIN = 'https://ssa.wvsailing.co.uk'
let n = 0
/** A fresh address per call, so the per-address throttle does not bleed. */
const fresh = () => `p${++n}@example.com`

const ask = (email: string) =>
  POST(new Request(`${ORIGIN}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }) as never)

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://x.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
  firstLoginLink.mockReset().mockResolvedValue(`${ORIGIN}/auth/callback?token_hash=abc&type=recovery`)
  sendPasswordResetEmail.mockReset().mockResolvedValue({ ok: true, id: 'e1' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('the mail goes through Resend, not Supabase', () => {
  it('mints a link and sends it', async () => {
    const email = fresh()
    const res = await ask(email)
    expect(res.status).toBe(200)
    expect(firstLoginLink).toHaveBeenCalledWith({}, email, ORIGIN)
    expect(sendPasswordResetEmail).toHaveBeenCalledWith({
      to: email,
      reset_url: `${ORIGIN}/auth/callback?token_hash=abc&type=recovery`,
      site_url: ORIGIN,
    })
  })

  it('complains loudly in the log when Resend refuses', async () => {
    // Silent to the caller, because saying so would leak that the account
    // exists — but a reset that vanishes is the exact failure this route was
    // written to end, so it must not vanish on our side either.
    sendPasswordResetEmail.mockResolvedValue({ ok: false, error: 'domain not verified' })
    const res = await ask(fresh())
    expect(res.status).toBe(200)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('domain not verified'))
  })
})

describe('it says nothing about who has an account', () => {
  // Unauthenticated by necessity: anybody can post to it. A reply that differed
  // for a known address would enumerate the team's membership.
  it('answers an unknown address exactly as it answers a known one', async () => {
    const known = await (await ask(fresh())).json()
    firstLoginLink.mockResolvedValue(null)        // generateLink fails: no account
    const unknown = await (await ask(fresh())).json()
    expect(unknown).toEqual(known)
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1)
  })

  it('answers a blank or malformed address the same way', async () => {
    const good = await (await ask(fresh())).json()
    expect(await (await ask('')).json()).toEqual(good)
    expect(await (await ask('not-an-address')).json()).toEqual(good)
  })

  it('answers the same when the server is not configured at all', async () => {
    const good = await (await ask(fresh())).json()
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    const res = await ask(fresh())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(good)
  })
})

describe('one mailbox cannot be flooded', () => {
  it('sends once per address per minute', async () => {
    const email = fresh()
    await ask(email)
    await ask(email)
    await ask(email)
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1)
  })

  it('throttles per address, not globally', async () => {
    await ask(fresh())
    await ask(fresh())
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(2)
  })

  it('still answers the same while throttled', async () => {
    const email = fresh()
    const first = await (await ask(email)).json()
    expect(await (await ask(email)).json()).toEqual(first)
  })
})

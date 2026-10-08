import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// Wijbren, 8 October: a coach in the Warp team scanned Baraka GP's QR code and
// was told "that address already has an SSA account. Sign in first, then open
// this link again" — a loop, because the sign-in page has never sent anybody
// back to a join link, and his manager had only ever sent him a QR code.
//
// A user may hold SEVERAL memberships; the schema has always said so. These
// tests pin down what that means here: his own password gets him into the
// queue for the second team, somebody else's password gets nobody anywhere,
// and in neither case is a password written or a membership granted.
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

interface Store {
  users: Row[]
  memberships: Row[]
  invitations: Row[]
  teams: Row[]
}

const createUser = vi.fn()
const updateUserById = vi.fn()
const signInWithPassword = vi.fn()
const redeemInvitation = vi.fn()
const sendAccessRequestEmail = vi.fn()
const recordAuthEvent = vi.fn()

let store: Store

/**
 * Just enough of a PostgREST builder to run this route: the handful of
 * chains it actually uses, over plain arrays. `ilike` is an equality here
 * because the route only ever passes a whole address, no wildcards.
 */
function from(table: keyof Store) {
  const filters: Array<[string, string, unknown]> = []
  let op: 'select' | 'update' | 'insert' = 'select'
  let payload: Row = {}

  const matches = (r: Row) =>
    filters.every(([kind, col, v]) => {
      if (kind === 'eq') return r[col] === v
      if (kind === 'ilike') return String(r[col] ?? '').toLowerCase() === String(v).toLowerCase()
      if (kind === 'lt') return Number(r[col]) < Number(v)
      return true
    })

  const run = async () => {
    const hit = store[table].filter(matches)
    if (op === 'update') {
      for (const r of hit) Object.assign(r, payload)
      return { data: hit, error: null }
    }
    if (op === 'insert') {
      store[table].push({ ...payload })
      return { data: [payload], error: null }
    }
    return { data: hit, error: null }
  }

  const api: Record<string, unknown> = {
    select: () => api,
    order: () => api,
    limit: () => api,
    eq: (c: string, v: unknown) => { filters.push(['eq', c, v]); return api },
    ilike: (c: string, v: unknown) => { filters.push(['ilike', c, v]); return api },
    lt: (c: string, v: unknown) => { filters.push(['lt', c, v]); return api },
    update: (p: Row) => { op = 'update'; payload = p; return api },
    insert: (p: Row) => { op = 'insert'; payload = p; return api },
    maybeSingle: async () => {
      const { data } = await run()
      return { data: (data as Row[])[0] ?? null, error: null }
    },
    single: async () => {
      const { data } = await run()
      return { data: (data as Row[])[0] ?? null, error: null }
    },
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
  }
  return api
}

vi.mock('../../../../../../lib/supabase/server', () => ({
  getServiceSupabase: () => ({
    from: (t: keyof Store) => from(t),
    auth: { admin: { createUser, updateUserById } },
  }),
  getServerSupabase: () => ({ auth: { signInWithPassword } }),
}))
vi.mock('../../../../../../lib/invitation-redeem', () => ({
  redeemInvitation: (...a: unknown[]) => redeemInvitation(...a),
}))
vi.mock('../../../../../../lib/email', () => ({
  sendAccessRequestEmail: (...a: unknown[]) => sendAccessRequestEmail(...a),
}))
vi.mock('../../../../../../lib/authEvents', () => ({
  recordAuthEvent: (...a: unknown[]) => recordAuthEvent(...a),
}))

const { POST } = await import('../route')

const TOKEN = 'ssa-join-code'
const PW = 'a-long-enough-one'
const good = {
  name: 'Wijbren Taconis',
  password: PW,
  confirm: PW,
  privacy_accepted: true,
  recording_consent: true,
}

const post = (body: Record<string, unknown>, token = TOKEN) =>
  POST(
    {
      nextUrl: new URL(`https://ssa.wvsailing.co.uk/api/join/${token}/request`),
      json: async () => body,
    } as never,
    { params: { token } }
  )

beforeEach(() => {
  store = {
    users: [
      { id: 'u-wijbren', email: 'wijbren@example.invalid', name: 'Wijbren Taconis', status: 'active' },
    ],
    memberships: [
      { id: 'm-warp', user_id: 'u-wijbren', team_id: 't-warp', role: 'coach' },
      // The embedded `users:users(email, name)` the route selects — the fake
      // ignores select lists, so the row simply carries it.
      { id: 'm-mgr', user_id: 'u-manager', team_id: 't-baraka', role: 'team_manager',
        users: { email: 'manager@example.invalid', name: 'Team Manager' } },
    ],
    invitations: [
      {
        id: 'inv1', token: TOKEN, team_id: 't-baraka', email: null, role: 'tl1', boat_id: null,
        used_count: 0, max_uses: 5,
        expires_at: new Date(Date.now() + 3600_000).toISOString(), revoked_at: null,
      },
    ],
    teams: [
      { id: 't-baraka', name: 'Baraka GP' },
      { id: 't-warp', name: 'Warp' },
    ],
  }
  createUser.mockReset().mockResolvedValue({ data: { user: { id: 'u-new' } }, error: null })
  updateUserById.mockReset().mockResolvedValue({ data: {}, error: null })
  signInWithPassword.mockReset().mockResolvedValue({ data: {}, error: null })
  redeemInvitation.mockReset().mockResolvedValue({ ok: true, auto_approved: false, team_id: 't-baraka' })
  sendAccessRequestEmail.mockReset().mockResolvedValue({ ok: true })
  recordAuthEvent.mockReset().mockResolvedValue(undefined)
})

describe('an address that already has an account', () => {
  it('is let into the queue for a SECOND team, with its own password', async () => {
    const res = await post({ ...good, email: 'wijbren@example.invalid' })
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(j.existing_account).toBe(true)
    // The words matter as much as the status: he is being told that the team
    // lands on the login he has, so he does not go looking for a new one.
    expect(j.message).toMatch(/Baraka GP/)
    expect(j.message).toMatch(/already have/i)
    expect(redeemInvitation).toHaveBeenCalledWith({
      token: TOKEN,
      user: { id: 'u-wijbren', email: 'wijbren@example.invalid' },
    })
  })

  it('never makes a second account for it, and never writes its password', async () => {
    await post({ ...good, email: 'WIJBREN@example.invalid' })
    expect(createUser).not.toHaveBeenCalled()
    // updateUserById is the only call that could set a password. The one use
    // this route has for it is email_confirm, and that address is confirmed.
    expect(updateUserById).not.toHaveBeenCalled()
    expect(store.users).toHaveLength(1)
  })

  it('tells the new team’s managers, so nobody waits on a queue nobody looks at', async () => {
    await post({ ...good, email: 'wijbren@example.invalid' })
    expect(sendAccessRequestEmail).toHaveBeenCalledTimes(1)
    const arg = sendAccessRequestEmail.mock.calls[0][0] as { team_name: string; applicant_email: string }
    expect(arg.team_name).toBe('Baraka GP')
    expect(arg.applicant_email).toBe('wijbren@example.invalid')
  })

  it('refuses a password that is not theirs, and spends nothing', async () => {
    signInWithPassword.mockResolvedValue({ data: {}, error: { message: 'Invalid login credentials' } })
    const res = await post({ ...good, email: 'wijbren@example.invalid' })
    const j = await res.json()
    expect(res.status).toBe(401)
    expect(j.error).toMatch(/not its password/i)
    expect(j.sign_in).toBe(true)
    expect(redeemInvitation).not.toHaveBeenCalled()
    expect(store.invitations[0].used_count).toBe(0)
  })

  it('confirms an address Supabase would never be able to confirm, then re-checks the password', async () => {
    // An account created by the old /signup road can sit unconfirmed for ever:
    // Supabase will not deliver its confirmation mail to an outside address.
    // Confirming grants nothing on its own — the password is still the gate,
    // and it is checked again straight after.
    signInWithPassword
      .mockResolvedValueOnce({ data: {}, error: { message: 'Email not confirmed' } })
      .mockResolvedValueOnce({ data: {}, error: null })
    const res = await post({ ...good, email: 'wijbren@example.invalid' })
    expect(res.status).toBe(200)
    expect(updateUserById).toHaveBeenCalledWith('u-wijbren', { email_confirm: true })
    expect(signInWithPassword).toHaveBeenCalledTimes(2)
  })

  it('says so plainly when they are in that team already', async () => {
    store.memberships.push({ id: 'm-already', user_id: 'u-wijbren', team_id: 't-baraka', role: 'tl1' })
    const res = await post({ ...good, email: 'wijbren@example.invalid' })
    const j = await res.json()
    expect(res.status).toBe(409)
    expect(j.error).toMatch(/already in Baraka GP/i)
    expect(j.sign_in).toBe(true)
    expect(signInWithPassword).not.toHaveBeenCalled()
    expect(redeemInvitation).not.toHaveBeenCalled()
  })

  it('does not admit a switched-off account, and does not test its password', async () => {
    store.users[0].status = 'disabled'
    const res = await post({ ...good, email: 'wijbren@example.invalid' })
    const j = await res.json()
    expect(res.status).toBe(403)
    expect(j.error).toMatch(/switched off/i)
    expect(signInWithPassword).not.toHaveBeenCalled()
  })

  it('reports an auto-approved targeted invite as joined, not as pending', async () => {
    redeemInvitation.mockResolvedValue({ ok: true, auto_approved: true, team_id: 't-baraka' })
    const res = await post({ ...good, email: 'wijbren@example.invalid' })
    const j = await res.json()
    expect(j.joined).toBe(true)
    expect(j.message).toMatch(/You are in Baraka GP/)
    // Nothing to tell the managers: it is already done.
    expect(sendAccessRequestEmail).not.toHaveBeenCalled()
  })

  it('passes a dead code’s own words on, rather than its code name', async () => {
    redeemInvitation.mockResolvedValue({ ok: false, error: 'exhausted', status: 410 })
    const res = await post({ ...good, email: 'wijbren@example.invalid' })
    const j = await res.json()
    expect(res.status).toBe(410)
    expect(j.error).toMatch(/as many times/i)
  })
})

describe('an address with no account — unchanged', () => {
  it('still gets a pending account of its own', async () => {
    const res = await post({ ...good, email: 'newcomer@example.invalid' })
    const j = await res.json()
    expect(res.status).toBe(200)
    expect(j.ok).toBe(true)
    expect(createUser).toHaveBeenCalledTimes(1)
    // It is the password-verifying branch that must not run for a newcomer:
    // there is nothing to verify against.
    expect(signInWithPassword).not.toHaveBeenCalled()
    expect(redeemInvitation).not.toHaveBeenCalled()
    expect(store.invitations[0].used_count).toBe(1)
  })

  it('refuses without the recording consent, whatever the form sent', async () => {
    const res = await post({ ...good, email: 'newcomer@example.invalid', recording_consent: false })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/voice-recorded/)
    expect(createUser).not.toHaveBeenCalled()
  })
})

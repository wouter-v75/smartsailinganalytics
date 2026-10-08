import { describe, it, expect, vi } from 'vitest'
import { provisionTeamMember, normaliseEmail, nameFromEmail } from '../provision-member'

// A fake of the bits of the Supabase client this uses: chainable builders that
// record what was asked, so the test asserts on the writes rather than on mocks
// of our own code.
function fakeService({ existingUser = null as null | { id: string; status?: string }, createError = '' } = {}) {
  const calls: { table: string; op: string; payload?: unknown; match?: unknown }[] = []
  const createUser = vi.fn(async (body: Record<string, unknown>) => {
    calls.push({ table: 'auth', op: 'createUser', payload: body })
    if (createError) return { data: { user: null }, error: { message: createError } }
    return { data: { user: { id: 'new-user-id' } }, error: null }
  })
  const updateUserById = vi.fn(async (id: string, body: Record<string, unknown>) => {
    calls.push({ table: 'auth', op: 'updateUserById', payload: body, match: id })
    return { data: { user: { id } }, error: null }
  })
  const service = {
    auth: { admin: { createUser, updateUserById } },
    from(table: string) {
      return {
        select() {
          return {
            ilike(_col: string, _v: string) {
              return { maybeSingle: async () => ({ data: existingUser }) }
            },
          }
        },
        update(payload: Record<string, unknown>) {
          return {
            eq(_c: string, v: string) {
              calls.push({ table, op: 'update', payload, match: v })
              return Promise.resolve({ error: null })
            },
          }
        },
        async insert(payload: Record<string, unknown>) {
          calls.push({ table, op: 'insert', payload })
          return { error: null }
        },
      }
    },
  }
  return { service, calls, createUser, updateUserById }
}

const args = {
  email: ' Crew@Example.com ',
  teamId: 'team-1',
  role: 'tl3',
  boatId: 'boat-1',
  approvedBy: 'manager-1',
}

describe('provisionTeamMember', () => {
  it('creates the account with the address already confirmed — no confirmation email', async () => {
    const { service, createUser } = fakeService()
    const res = await provisionTeamMember(service, args)
    expect(res).toMatchObject({ ok: true, userId: 'new-user-id', created: true })
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'crew@example.com', email_confirm: true }),
    )
  })

  it('makes them active and approved, so nothing lands in the approval queue', async () => {
    const { service, calls } = fakeService()
    await provisionTeamMember(service, args)
    const upd = calls.find((c) => c.table === 'users' && c.op === 'update')!
    expect(upd.payload).toMatchObject({
      status: 'active',
      approved_by: 'manager-1',
      requested_team_id: null,
      requested_role: null,
    })
  })

  it('creates the membership the first login needs', async () => {
    const { service, calls } = fakeService()
    await provisionTeamMember(service, args)
    expect(calls.find((c) => c.table === 'memberships')!.payload).toMatchObject({
      user_id: 'new-user-id', team_id: 'team-1', boat_id: 'boat-1', role: 'tl3',
    })
  })

  it('reuses an existing account rather than creating a second one', async () => {
    const { service, createUser, calls } = fakeService({ existingUser: { id: 'old-user-id' } })
    const res = await provisionTeamMember(service, args)
    expect(createUser).not.toHaveBeenCalled()
    expect(res).toMatchObject({ ok: true, userId: 'old-user-id', created: false })
    expect(calls.find((c) => c.table === 'memberships')!.payload).toMatchObject({ user_id: 'old-user-id' })
  })

  it('survives an address that exists in auth but not yet in the users table', async () => {
    const { service } = fakeService({ createError: 'User already registered' })
    const res = await provisionTeamMember(service, args)
    expect(res.ok).toBe(false)      // nothing to attach to; the caller falls back to the invite link
    expect(res.error).toMatch(/could not be found/)
  })

  it('refuses to reactivate an account a global admin disabled', async () => {
    const { service, calls } = fakeService({ existingUser: { id: 'old-user-id', status: 'disabled' } })
    const res = await provisionTeamMember(service, args)
    expect(res).toMatchObject({ ok: false, disabled: true })
    expect(res.error).toMatch(/disabled/)
    expect(calls.some((c) => c.table === 'memberships')).toBe(false)
  })

  it('refuses an empty address', async () => {
    const { service } = fakeService()
    expect(await provisionTeamMember(service, { ...args, email: '  ' })).toMatchObject({ ok: false })
  })
})

describe('email helpers', () => {
  it('normalises and derives a display name', () => {
    expect(normaliseEmail('  Foo@Bar.COM ')).toBe('foo@bar.com')
    expect(nameFromEmail('Jan.Smit@example.com')).toBe('jan.smit')
  })
})

describe('an account that already existed', () => {
  it('gets its address CONFIRMED, or it can never sign in', async () => {
    // Gwenael, 1 October: the account came from the old self-signup, whose
    // confirmation went over Supabase's mailer and was refused for being
    // outside the project's team. Unconfirmed, signInWithPassword answers
    // "Email not confirmed" for ever — password set, membership in place,
    // welcome link working, and still locked out.
    const { service, updateUserById, createUser } = fakeService({
      existingUser: { id: 'existing-id', status: 'active' },
    })
    const res = await provisionTeamMember(service, args)
    expect(res).toMatchObject({ ok: true, userId: 'existing-id', created: false })
    expect(createUser).not.toHaveBeenCalled()
    expect(updateUserById).toHaveBeenCalledWith('existing-id', { email_confirm: true })
  })

  it('does not confirm twice when it just created the account', async () => {
    // The create path already passes email_confirm; a second call would be a
    // round trip for nothing.
    const { service, updateUserById } = fakeService()
    await provisionTeamMember(service, args)
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('stops rather than reporting success it did not achieve', async () => {
    const { service } = fakeService({ existingUser: { id: 'existing-id' } })
    service.auth.admin.updateUserById = vi.fn(async () => ({
      data: { user: null }, error: { message: 'user not found' },
    })) as never
    const res = await provisionTeamMember(service, args)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('could not confirm the address')
  })
})

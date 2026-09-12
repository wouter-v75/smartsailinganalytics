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
  const service = {
    auth: { admin: { createUser } },
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
  return { service, calls, createUser }
}

const args = {
  email: ' Crew@Example.com ',
  teamId: 'team-1',
  role: 'tl2',
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
      user_id: 'new-user-id', team_id: 'team-1', boat_id: 'boat-1', role: 'tl2',
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

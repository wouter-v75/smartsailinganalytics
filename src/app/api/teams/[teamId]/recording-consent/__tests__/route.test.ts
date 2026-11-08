import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// The debrief recorder's consent gate, at the route.
//
// Wouter, 8 Nov 2026: a team he had just created, of which he was the only
// member, with his own profile box already ticked, refused to record — "Not all
// of your team have agreed to team recording. They can do so in their profile" —
// and named nobody, because there was nobody. `team_recording_consent()` counted
// only the sailing roles, and `POST /api/admin/teams` gives the creator
// `team_manager`, so the team came out total = 0 and the route read that as "not
// all consented".
//
// What is pinned here is the ROUTE's half of that: total 0 is still a refusal
// (it is the honest answer for a team with nobody in it), the caller's own flag
// comes through separately so the UI can offer them the box, and the POST that
// writes that flag refuses anything that is not an explicit boolean — consent
// read out of a missing or malformed field is not consent.
// ─────────────────────────────────────────────────────────────────────────────

type Rpc = { total: number; consented: number; pending_names: string[] | null; you_consented?: boolean | null }

let rpcRow: Rpc | null
let rpcError: { message: string } | null
let user: { id: string } | null
let updates: Array<{ table: string; payload: Record<string, unknown>; eq: [string, unknown][] }>
let updateError: { message: string } | null

const supabase = {
  auth: { getUser: async () => ({ data: { user } }) },
  rpc: (_fn: string, _args: unknown) => ({
    maybeSingle: async () => ({ data: rpcRow, error: rpcError }),
  }),
  from: (table: string) => ({
    update: (payload: Record<string, unknown>) => {
      const eq: [string, unknown][] = []
      const chain = {
        eq: (col: string, v: unknown) => {
          eq.push([col, v])
          updates.push({ table, payload, eq })
          return Promise.resolve({ error: updateError }) as unknown as typeof chain
        },
      }
      return chain
    },
  }),
}

vi.mock('../../../../../../lib/supabase/server', () => ({
  getServerSupabase: () => supabase,
}))

beforeEach(() => {
  rpcRow = { total: 1, consented: 1, pending_names: [], you_consented: true }
  rpcError = null
  user = { id: 'me' }
  updates = []
  updateError = null
})

const params = { params: { teamId: 'team-1' } }
const req = (body?: unknown) =>
  ({ json: async () => { if (body === undefined) throw new Error('no body'); return body } }) as never

describe('GET /api/teams/[teamId]/recording-consent', () => {
  it('passes a one-person consenting team', async () => {
    const { GET } = await import('../route')
    const res = await GET({} as never, params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      total: 1, consented: 1, pending: [], youConsented: true, allConsented: true,
    })
  })

  it('separates "you have not agreed" from "they have not"', async () => {
    rpcRow = { total: 3, consented: 1, pending_names: ['Ada Byron'], you_consented: false }
    const { GET } = await import('../route')
    const body = await (await GET({} as never, params)).json()
    // The caller's own name is NOT in the list — it has its own control.
    expect(body.pending).toEqual(['Ada Byron'])
    expect(body.youConsented).toBe(false)
    expect(body.allConsented).toBe(false)
  })

  it('refuses a team with nobody in it rather than calling it consented', async () => {
    rpcRow = { total: 0, consented: 0, pending_names: [], you_consented: true }
    const { GET } = await import('../route')
    const body = await (await GET({} as never, params)).json()
    expect(body.allConsented).toBe(false)
  })

  it('reads a null you_consented as NOT agreed', async () => {
    rpcRow = { total: 2, consented: 2, pending_names: [], you_consented: null }
    const { GET } = await import('../route')
    expect((await (await GET({} as never, params)).json()).youConsented).toBe(false)
  })

  it('says UNKNOWN, not false, when the database has not got 0105 yet', async () => {
    // The old function declares three columns, so the key is simply absent.
    // Reading that as false would have the recorder offer the only member of a
    // team a tick box that writes a consent they already had, then refuse them
    // again on the same screen — a worse dead end than the one being fixed.
    rpcRow = { total: 0, consented: 0, pending_names: [] }
    const { GET } = await import('../route')
    const body = await (await GET({} as never, params)).json()
    expect(body.youConsented).toBeNull()
    expect(body.allConsented).toBe(false)
  })

  it('turns the function\'s membership check into a 403, not a 500', async () => {
    rpcRow = null
    rpcError = { message: 'not a member of this team' }
    const { GET } = await import('../route')
    const res = await GET({} as never, params)
    expect(res.status).toBe(403)
  })

  it('401s an anonymous caller without touching the database', async () => {
    user = null
    const { GET } = await import('../route')
    expect((await GET({} as never, params)).status).toBe(401)
  })
})

describe('POST /api/teams/[teamId]/recording-consent', () => {
  it('writes my own flag and answers with the recomputed gate', async () => {
    rpcRow = { total: 1, consented: 1, pending_names: [], you_consented: true }
    const { POST } = await import('../route')
    const res = await POST(req({ consent: true }), params)

    expect(updates).toEqual([
      { table: 'users', payload: { recording_consent: true }, eq: [['id', 'me']] },
    ])
    // No timestamp is sent — migration 0078's trigger owns recording_consent_at,
    // which is what stops a client back-dating its own consent.
    expect(Object.keys(updates[0].payload)).toEqual(['recording_consent'])
    expect((await res.json()).allConsented).toBe(true)
  })

  it('writes the withdrawal too', async () => {
    rpcRow = { total: 1, consented: 0, pending_names: [], you_consented: false }
    const { POST } = await import('../route')
    const body = await (await POST(req({ consent: false }), params)).json()
    expect(updates[0].payload).toEqual({ recording_consent: false })
    expect(body.allConsented).toBe(false)
  })

  it.each([
    ['nothing at all', undefined],
    ['an empty body', {}],
    ['a string', { consent: 'yes' }],
    ['null', { consent: null }],
  ])('refuses %s rather than reading it as agreement', async (_label, body) => {
    const { POST } = await import('../route')
    const res = await POST(req(body), params)
    expect(res.status).toBe(400)
    expect(updates).toEqual([])
  })

  it('401s an anonymous caller before writing anything', async () => {
    user = null
    const { POST } = await import('../route')
    expect((await POST(req({ consent: true }), params)).status).toBe(401)
    expect(updates).toEqual([])
  })

  it('reports a refused write instead of claiming consent was saved', async () => {
    updateError = { message: 'new row violates row-level security policy' }
    const { POST } = await import('../route')
    const res = await POST(req({ consent: true }), params)
    expect(res.status).toBe(500)
  })
})

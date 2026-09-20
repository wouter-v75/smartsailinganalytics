import { describe, it, expect } from 'vitest'
import { fetchPhaseSets } from '../phaseUpload'

const ACTIVE = {
  id: 'set-1', date: '2026-02-08', phase_count: 142, created_at: '2026-09-20T08:00:00Z',
  created_by_user_id: 'u1', note: 'after the debrief', settings: null, runs: [],
  phases: [{ utc: 1, endUtc: 2, mode: -1, src: 'ssa', kind: 'steady', quality: 1 }],
}

const ok = (body: any) => (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch

describe('fetchPhaseSets', () => {
  it('returns the set in force and the ones stood down', async () => {
    const r = await fetchPhaseSets('t', 'b', '2026-02-08',
      ok({ active: ACTIVE, history: [{ id: 'old', phase_count: 90, created_at: 'x', created_by_user_id: null, note: null }] }))
    expect(r.active!.phase_count).toBe(142)
    expect(r.active!.phases).toHaveLength(1)
    expect(r.history).toHaveLength(1)
  })

  it('is calm about a team with no uploaded set', async () => {
    const r = await fetchPhaseSets('t', 'b', '2026-02-08', ok({ active: null, history: [] }))
    expect(r.active).toBeNull()
    expect(r.history).toEqual([])
  })

  it('reports needsMigration rather than throwing', async () => {
    const f = (async () => ({ ok: false, json: async () => ({ needsMigration: true, error: 'no table' }) })) as unknown as typeof fetch
    const r = await fetchPhaseSets('t', 'b', '2026-02-08', f)
    expect(r.needsMigration).toBe(true)
    expect(r.active).toBeNull()
  })

  it('survives an unauthorised or offline read', async () => {
    const unauth = (async () => ({ ok: false, json: async () => ({ error: 'unauth' }) })) as unknown as typeof fetch
    expect((await fetchPhaseSets('t', 'b', 'd', unauth)).active).toBeNull()
    const boom = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await fetchPhaseSets('t', 'b', 'd', boom)).toEqual({ active: null, history: [] })
  })

  it('tolerates a malformed body', async () => {
    const r = await fetchPhaseSets('t', 'b', 'd', ok({}))
    expect(r.active).toBeNull()
    expect(r.history).toEqual([])
  })

  it('asks the route the POST already writes to', async () => {
    let seen = ''
    const spy = (async (url: string) => { seen = url; return { ok: true, json: async () => ({ active: null, history: [] }) } }) as unknown as typeof fetch
    await fetchPhaseSets('team-1', 'boat-2', '2026-02-08', spy)
    expect(seen).toBe('/api/teams/team-1/boats/boat-2/phases/2026-02-08')
  })
})

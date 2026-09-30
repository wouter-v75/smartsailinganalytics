// src/lib/__tests__/deleteVideosCloud.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// The call that decides whether a deleted clip stays deleted.
//
// It used to funnel every outcome into `{deleted: 0}` — a 403 from RLS, a 500
// from an IDB key sent where a UUID belongs, no active boat, and a genuine "no
// such row" were indistinguishable, and the button said "✓ Deleted" to all
// four. The clip then came back on the next sync, because its row never went.
//
// So the test is not really about deleting. It is about being able to TELL.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest'

const getActiveMembership = vi.fn()
vi.mock('../active-membership', () => ({ getActiveMembership: (...a: unknown[]) => getActiveMembership(...a) }))

import { deleteVideosCloud } from '../cloud-videos'

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const fail = (status: number, body: unknown) => ({ ok: false, status, json: async () => body })
const urlOf = (call: number) => String((global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[call][0])

beforeEach(() => {
  getActiveMembership.mockReset().mockReturnValue({ team_id: 't1', boat_id: 'b1' })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ deleted: 1, videos: [], purged: { ok: [], failed: [], skipped: [] } })))
})

describe('deleteVideosCloud — naming the row', () => {
  it('sends a UUID as id', async () => {
    await deleteVideosCloud({ userId: 'u1', id: '11111111-2222-3333-4444-555555555555' })
    expect(urlOf(0)).toContain('/api/teams/t1/boats/b1/videos?id=11111111-2222-3333-4444-555555555555')
  })

  it('sends a local IDB key as external_id, never as id', async () => {
    // `id: v.cloudId || v.id` put `v_1779…` in a UUID comparison: Postgres
    // errored, the route 500'd, and the failure came back looking like success.
    await deleteVideosCloud({ userId: 'u1', externalId: 'v_1779206586594_abc' })
    const u = urlOf(0)
    expect(u).toContain('external_id=v_1779206586594_abc')
    expect(u).not.toContain('?id=')   // `external_id=` contains `id=`, so anchor on the ?
  })

  it('prefers the UUID when it has both', async () => {
    await deleteVideosCloud({ userId: 'u1', id: '11111111-2222-3333-4444-555555555555', externalId: 'v_1' })
    expect(urlOf(0)).not.toContain('external_id')
  })

  it('still supports the whole-day delete', async () => {
    await deleteVideosCloud({ userId: 'u1', date: '2026-09-29' })
    expect(urlOf(0)).toContain('date=2026-09-29')
  })
})

describe('deleteVideosCloud — telling failure from success', () => {
  it('reports a refusal instead of an empty delete', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(403, { error: 'row-level security' })))
    const res = await deleteVideosCloud({ userId: 'u1', id: '11111111-2222-3333-4444-555555555555' })
    expect(res.deleted).toBe(0)
    expect(res.error).toMatch(/row-level security/)
  })

  it('reports an HTTP failure that carries no body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('no body') } }))
    const res = await deleteVideosCloud({ userId: 'u1', id: '11111111-2222-3333-4444-555555555555' })
    expect(res.error).toMatch(/HTTP 500/)
  })

  it('reports a thrown fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const res = await deleteVideosCloud({ userId: 'u1', id: '11111111-2222-3333-4444-555555555555' })
    expect(res.error).toBe('offline')
  })

  it('reports no active boat rather than silently doing nothing', async () => {
    getActiveMembership.mockReturnValue(null)
    const res = await deleteVideosCloud({ userId: 'u1', id: '11111111-2222-3333-4444-555555555555' })
    expect(res.error).toMatch(/no active boat/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports being given nothing to look for', async () => {
    const res = await deleteVideosCloud({ userId: 'u1' })
    expect(res.error).toMatch(/nothing to delete/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('leaves error null when the row simply was not there', async () => {
    // Not a failure: a clip that was never uploaded has no row, and the caller
    // must go on to delete the local copy rather than stopping.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ deleted: 0, videos: [] })))
    const res = await deleteVideosCloud({ userId: 'u1', externalId: 'v_never_uploaded' })
    expect(res).toMatchObject({ deleted: 0, error: null })
  })

  it('passes the purge report through', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({
      deleted: 1, videos: [], purged: { ok: ['clips/a.mp4'], failed: ['clips/b.mp4'], skipped: [] },
    })))
    const res = await deleteVideosCloud({ userId: 'u1', id: '11111111-2222-3333-4444-555555555555' })
    expect(res.purged?.failed).toEqual(['clips/b.mp4'])
  })
})

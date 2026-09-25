// src/lib/__tests__/savePhotoSailTrim.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Writing a measurement onto a photo from the timeline, where PhotosTab's local
// state does not exist.
//
// The trap worth a test: the photos route writes the WHOLE row, so any column
// left out of the POST is nulled. A save that adds sail geometry and quietly
// erases the capture time or the EXIF would be worse than no save at all.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { savePhotoSailTrim } from '../savePhotoSailTrim'

const annotation = {
  version: 'v', imageSize: { w: 6000, h: 4000 }, defn: 'boat' as const,
  axis: { low: { x: 1, y: 2 }, high: { x: 3, y: 4 } },
  targets: [{ key: 'clew', label: 'Jib clew', point: { x: 1, y: 1 }, foot: { x: 2, y: 2 }, mm: -1103, sigmaMm: 17, colour: '#FB923C' }],
  psiDeg: 0.42, psiMeasured: true, heelDeg: 22.7, measuredAt: 1,
}
const payload = { annotation, overlay: true, headline: 'clew 1103 mm' }

const row = {
  id: 'p1',
  taken_utc: '2026-09-12T10:46:00.000Z',
  exif_data: { Model: 'Canon EOS R6m2' },
  thumbnail_url: 'https://cdn/thumb.jpg',
  bunny_storage_path: 'sessions/2026-09-12/photos/p_1790328226840_rqkezf6hhvi.jpg',
  bytes: 2_700_000,
  analysis_data: { inst: { tws: 14.2 }, sails: ['J2'] },
  sessions: { date: '2026-09-12' },
}

let calls: { url: string; body: Record<string, unknown> }[] = []
const okFetch = vi.fn(async (url: string, init: RequestInit) => {
  calls.push({ url, body: JSON.parse(String(init.body)) })
  return { ok: true, json: async () => ({ photo: { id: 'p1' }, action: 'updated' }) } as Response
})

beforeEach(() => { calls = []; vi.clearAllMocks(); vi.stubGlobal('fetch', okFetch) })

describe('savePhotoSailTrim', () => {
  it('posts to the team+boat photos route', async () => {
    await savePhotoSailTrim({ teamId: 't1', boatId: 'b1', row, payload })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/teams/t1/boats/b1/photos')
  })

  it('sends every other column back unchanged — the route nulls what it is not given', async () => {
    await savePhotoSailTrim({ teamId: 't1', boatId: 'b1', row, payload })
    const b = calls[0].body
    expect(b.taken_utc).toBe(row.taken_utc)
    expect(b.exif_data).toEqual(row.exif_data)
    expect(b.bytes).toBe(row.bytes)
    expect(b.bunny_storage_path).toBe(row.bunny_storage_path)
    expect(b.session_date).toBe('2026-09-12')
  })

  it('MERGES the geometry into analysis_data rather than replacing it', async () => {
    // The instruments and the sail names live in the same column. Replacing it
    // would blank the overlay for everyone, which is the failure this codebase
    // has already had once.
    await savePhotoSailTrim({ teamId: 't1', boatId: 'b1', row, payload })
    const a = calls[0].body.analysis_data as Record<string, unknown>
    expect(a.inst).toEqual({ tws: 14.2 })
    expect(a.sails).toEqual(['J2'])
    expect(a.sailTrim).toEqual(payload)
  })

  it('takes an explicit session date over the row’s own', async () => {
    await savePhotoSailTrim({ teamId: 't1', boatId: 'b1', row, payload, sessionDate: '2026-09-11' })
    expect(calls[0].body.session_date).toBe('2026-09-11')
  })

  it('refuses a photo with no cloud path, instead of creating a row pointing nowhere', async () => {
    await expect(savePhotoSailTrim({
      teamId: 't1', boatId: 'b1', payload,
      row: { ...row, bunny_storage_path: null },
    })).rejects.toThrow(/not in the cloud/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a photo with no day to attach to', async () => {
    await expect(savePhotoSailTrim({
      teamId: 't1', boatId: 'b1', payload,
      row: { ...row, sessions: null },
    })).rejects.toThrow(/no session date/)
    expect(calls).toHaveLength(0)
  })

  it('reports the server’s own refusal rather than a bare status', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false, status: 403, json: async () => ({ error: 'not a member of this team' }),
    } as Response))
    await expect(savePhotoSailTrim({ teamId: 't1', boatId: 'b1', row, payload }))
      .rejects.toThrow(/not a member of this team/)
  })

  it('still says something useful when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false, status: 502, json: async () => { throw new Error('not json') },
    } as unknown as Response))
    await expect(savePhotoSailTrim({ teamId: 't1', boatId: 'b1', row, payload }))
      .rejects.toThrow(/502/)
  })
})

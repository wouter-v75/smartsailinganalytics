import { describe, it, expect, vi, beforeEach } from 'vitest'

// Push to Cloud (syncSessionToCloud) used to skip only clips marked
// cloudSynced + streamId — the legacy direct-to-Stream upload. The watch folder
// and the Videos tab upload storage-first and never set those, so pushing the
// session sent every one of their clips a second time.

vi.mock('../localStore', () => ({
  getVideoBlob: vi.fn(async () => new Blob(['x'])),
  markVideoCloudSynced: vi.fn(async () => {}),
  markCloudSynced: vi.fn(async () => {}),
}))
vi.mock('../syncManifest', () => ({
  readSyncManifest: vi.fn(async () => null),
  updateSyncManifest: vi.fn(async () => {}),
}))

import { alreadyInCloud, syncSessionToCloud } from '../bunny'

describe('alreadyInCloud', () => {
  it('is false for a clip nothing has uploaded', () => {
    expect(alreadyInCloud({ id: 'a' })).toBe(false)
  })
  it('recognises the legacy direct-to-Stream upload', () => {
    expect(alreadyInCloud({ cloudSynced: true, streamId: 's1' })).toBe(true)
    expect(alreadyInCloud({ cloudSynced: true, streamId: null })).toBe(false)
  })
  it('recognises a storage-first upload, even when the Stream fetch failed', () => {
    expect(alreadyInCloud({ originalUploadedAt: 1, originalStreamId: null })).toBe(true)
  })
  it("recognises the library's own flag from the cloud row", () => {
    expect(alreadyInCloud({ hasOriginal: true })).toBe(true)
  })
})

describe('syncSessionToCloud', () => {
  let calls: string[]
  beforeEach(() => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response
    }))
  })

  it('never re-sends a clip the watch folder already uploaded', async () => {
    const msgs: string[] = []
    const res = await syncSessionToCloud('2026-09-11', null, null, [
      { id: 'up', name: 'start.mp4', size: 10, originalUploadedAt: 1 },
      { id: 'new', name: 'gybe.mp4', size: 10 },
    ], (m: string) => msgs.push(m))

    // Only the unmarked clip reaches Stream.
    expect(calls.filter((u) => u.includes('/api/stream/create'))).toHaveLength(1)
    expect(msgs).toContain('↩ start.mp4 already in cloud — skipping')
    expect(msgs.some((m) => m.startsWith('Creating Bunny Stream video for start.mp4'))).toBe(false)
    expect(msgs.some((m) => m.startsWith('Creating Bunny Stream video for gybe.mp4'))).toBe(true)
    // …and the caller is told, so its progress row closes.
    expect(res.skipped).toEqual(['up'])
  })
})

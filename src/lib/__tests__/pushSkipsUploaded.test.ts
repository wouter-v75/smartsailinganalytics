import { describe, it, expect, vi, beforeEach } from 'vitest'

// `alreadyInCloud` is the guard every upload path asks before sending a clip.
// It used to recognise only the legacy direct-to-Stream upload (cloudSynced +
// streamId) and the original; the watch folder and the Videos tab upload
// PROXIES and set neither, so pushing the session sent every one of their clips
// a second time.
//
// And the session sync itself no longer sends clip bytes at all — see the second
// block, and src/lib/uploadFlows.ts for the two flows that do.

vi.mock('../localStore', () => ({
  markCloudSynced: vi.fn(async () => {}),
}))
vi.mock('../syncManifest', () => ({
  readSyncManifest: vi.fn(async () => null),
  updateSyncManifest: vi.fn(async () => {}),
}))

import { alreadyInCloud, syncSessionDataToCloud } from '../bunny'

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
  it('recognises the PROXY — the copy the team actually watches', () => {
    // The watch folder stopped sending originals and started sending proxies,
    // which left a day of racing looking un-uploaded to Push to Cloud.
    expect(alreadyInCloud({ proxyUploadedAt: '2026-11-26T10:00:00.000Z' })).toBe(true)
    expect(alreadyInCloud({ hasProxy: true })).toBe(true)
  })
})

describe('syncSessionDataToCloud', () => {
  let calls: string[]
  beforeEach(() => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
    }))
  })

  it('never sends clip bytes, whatever state the clips are in', async () => {
    const msgs: string[] = []
    const res = await syncSessionDataToCloud('2026-09-11', null, null, [
      { id: 'up', name: 'start.mp4', size: 10, originalUploadedAt: 1 },
      { id: 'prox', name: 'mark.mp4', size: 10, hasProxy: true },
      // The one that would have gone: no proxy, no original, no legacy guid.
      { id: 'new', name: 'gybe.mp4', size: 10 },
    ], (m: string) => msgs.push(m))

    expect(res.success).toBe(true)
    // Nothing touches Bunny Stream. These three are the whole legacy flow:
    // create a video object, sign the TUS upload, poll it to readiness.
    for (const route of ['/api/stream/create', '/api/stream/upload', '/api/stream/status']) {
      expect(calls.filter((u) => u.includes(route))).toHaveLength(0)
    }
    expect(msgs.some((m) => m.includes('Bunny Stream'))).toBe(false)
  })

  it('lists every clip in meta.json, including ones with no cloud copy', async () => {
    const puts: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/storage/credentials')) {
        return { ok: true, json: async () => ({ accessKey: 'k', zone: 'z', host: 'https://h' }) } as unknown as Response
      }
      if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)))
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
    }))

    await syncSessionDataToCloud('2026-09-11', null, null, [
      { id: 'a', name: 'start.mp4', proxyStreamId: 'p1' },
      { id: 'b', name: 'gybe.mp4' },
    ], () => {})

    // meta.json is the only thing written with no log and no events, and the
    // clip list is what other devices read the day's library from — a clip
    // missing from it is a clip they cannot see.
    const meta = puts.find((p) => Array.isArray((p as { videos?: unknown }).videos)) as
      { videoCount: number; videos: { id: string; streamId: string | null }[] } | undefined
    expect(meta?.videoCount).toBe(2)
    expect(meta?.videos.map((v) => v.id)).toEqual(['a', 'b'])
    // The guid it carries is whichever rendition exists, newest flow first —
    // never one minted here, because nothing is uploaded here.
    expect(meta?.videos[0].streamId).toBe('p1')
    expect(meta?.videos[1].streamId).toBe(null)
  })
})

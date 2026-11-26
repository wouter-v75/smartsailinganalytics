// Which COLUMN an untouched upload lands in.
//
// `syncProxyForVideo` skips the transcode when the source is already
// proxy-sized, and then the blob it uploads IS the source. It used to conclude
// from that alone that the file was the clip's ORIGINAL — reasonable for a clip
// imported raw off a card, and wrong for the watch folder, which is fed by
// scripts/day-clips.ts and therefore receives 720p cuts whose full-resolution
// original is still on the card. 154 clips:day rows carry an original and not
// one carries a proxy, which is that inference.
//
// So the caller declares it. These tests pin both directions, because getting
// `registerAs` backwards is silent: the bytes upload fine either way and only
// the column, the Storage key and has_original/has_proxy differ.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../bunny-storage-upload', () => ({
  uploadBlobToStorage: vi.fn(async ({ key, blob }: { key: string; blob: Blob }) => ({
    key, bytes: blob.size,
  })),
  storageObjectSize: vi.fn(async () => null),
}))

import { syncProxyForVideo } from '../video-rendition-sync'

const json = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as Response

/** The source is handed in as the proxy too, which is exactly what a skipped
 *  transcode produces (proxyBlob === source) without needing a DOM to probe. */
const args = () => {
  const source = new Blob([new Uint8Array(2048)], { type: 'video/mp4' })
  return {
    videoId: 'vid-1',
    sessionDate: '2026-09-08',
    source,
    proxyBlobIfAvailable: source,
    retryBaseMs: 1,
  }
}

function recorder() {
  const patches: unknown[] = []
  const paths: string[] = []
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/renditions')) {
      patches.push(JSON.parse(init!.body as string))
      return json({ ok: true })
    }
    if (u.includes('/api/stream/fetch')) {
      paths.push(JSON.parse(init!.body as string).path)
      return json({ streamId: 'guid-1' })
    }
    return json({ ok: true })
  }) as unknown as typeof fetch
  return { patches, paths }
}

describe('syncProxyForVideo — registerAs', () => {
  beforeEach(() => vi.clearAllMocks())

  it("defaults to 'auto', where an untouched source is still the ORIGINAL", async () => {
    const { patches, paths } = recorder()
    const r = await syncProxyForVideo(args())

    expect(r.ok).toBe(true)
    expect(paths[0]).toBe('sessions/2026-09-08/originals/vid-1.mp4')
    // `original`, both for the Storage path and for the Stream guid
    expect(patches[0]).toHaveProperty('original')
    expect(patches[1]).toHaveProperty('original')
    expect(patches[0]).not.toHaveProperty('proxy')
  })

  it("registerAs 'proxy' files the same bytes as the team's copy instead", async () => {
    const { patches, paths } = recorder()
    const r = await syncProxyForVideo({ ...args(), registerAs: 'proxy' })

    expect(r.ok).toBe(true)
    expect(paths[0]).toBe('sessions/2026-09-08/proxies/vid-1.mp4')
    expect(r.proxyPath).toBe('sessions/2026-09-08/proxies/vid-1.mp4')
    expect(patches[0]).toHaveProperty('proxy')
    expect(patches[1]).toHaveProperty('proxyStream')
    expect(patches[0]).not.toHaveProperty('original')
    // and the bytes are reported, which is what the proxy row records
    expect(r.proxyBytes).toBe(2048)
  })

  it('a TRANSCODED blob is a proxy whatever registerAs says — it cannot be the original', async () => {
    const { patches, paths } = recorder()
    const source = new Blob([new Uint8Array(9999)], { type: 'video/mp4' })
    const transcoded = new Blob([new Uint8Array(2048)], { type: 'video/mp4' })
    const r = await syncProxyForVideo({
      videoId: 'vid-2', sessionDate: '2026-09-08', source,
      proxyBlobIfAvailable: transcoded, retryBaseMs: 1,
      // deliberately the default: 'auto' must NOT promote a transcode
    })

    expect(r.ok).toBe(true)
    expect(paths[0]).toBe('sessions/2026-09-08/proxies/vid-2.mp4')
    expect(patches[0]).toHaveProperty('proxy')
    expect(patches[0]).not.toHaveProperty('original')
  })

  it('surfaces proxyPath and streamError so the caller can record and warn', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/api/stream/fetch')) return json({ error: 'queue full' }, false, 503)
      return json({ ok: true })
    }) as unknown as typeof fetch

    const r = await syncProxyForVideo({ ...args(), registerAs: 'proxy' })
    // Uploaded and playable from Storage; only the ladder is missing.
    expect(r.ok).toBe(true)
    expect(r.proxyPath).toBe('sessions/2026-09-08/proxies/vid-1.mp4')
    expect(r.streamError).toBe('queue full')
    expect(r.proxyStreamId).toBeUndefined()
  })
})

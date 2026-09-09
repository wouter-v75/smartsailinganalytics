import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Storage PUT is an XHR against Bunny; stub it at the module edge.
vi.mock('../bunny-storage-upload', () => ({
  uploadBlobToStorage: vi.fn(async ({ key, blob }: { key: string; blob: Blob }) => ({
    key,
    bytes: blob.size,
  })),
}))

import { uploadOriginalStorageFirst } from '../video-rendition-sync'
import { uploadBlobToStorage } from '../bunny-storage-upload'

const args = () => ({
  videoId: 'vid-1',
  sessionDate: '2026-09-08',
  source: new Blob([new Uint8Array(1024)], { type: 'video/mp4' }),
  title: '20260908121330_race-start_day7_drone',
})

const json = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as Response

describe('uploadOriginalStorageFirst', () => {
  beforeEach(() => vi.clearAllMocks())

  it('puts the clip in Storage before anything else, so it is watchable first', async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url); calls.push(u)
      if (u.includes('/api/stream/fetch')) return json({ streamId: 'guid-1' })
      return json({ ok: true })
    }) as unknown as typeof fetch

    const r = await uploadOriginalStorageFirst(args())
    expect(r.ok).toBe(true)
    expect(uploadBlobToStorage).toHaveBeenCalledOnce()
    expect(r.originalPath).toBe('sessions/2026-09-08/originals/vid-1.mp4')
    // renditions PATCH (path) must land BEFORE the stream fetch is even asked for
    expect(calls[0]).toContain('/renditions')
    expect(calls[1]).toContain('/api/stream/fetch')
    expect(r.streamId).toBe('guid-1')
    expect(r.streamError).toBeUndefined()
  })

  it('uploads the bytes ONCE — Bunny is asked to fetch, not sent the file again', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/api/stream/fetch') ? json({ streamId: 'g' }) : json({ ok: true })
    ) as unknown as typeof fetch

    await uploadOriginalStorageFirst(args())
    // one Storage PUT, and the Stream hop carries a path, not a body of bytes
    expect(uploadBlobToStorage).toHaveBeenCalledOnce()
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => String(c[0]).includes('/api/stream/fetch'))!
    const body = JSON.parse((call[1] as RequestInit).body as string)
    expect(body).toEqual({ path: 'sessions/2026-09-08/originals/vid-1.mp4', title: args().title })
  })

  it('still reports OK when the adaptive encode cannot be queued', async () => {
    // The clip is already in Storage and plays. Calling this a failed upload
    // would send the user re-uploading something the team can already watch.
    globalThis.fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/api/stream/fetch')
        ? json({ error: 'Bunny fetch HTTP 502' }, false, 502)
        : json({ ok: true })
    ) as unknown as typeof fetch

    const r = await uploadOriginalStorageFirst(args())
    expect(r.ok).toBe(true)
    expect(r.originalPath).toBeTruthy()
    expect(r.streamId).toBeUndefined()
    expect(r.streamError).toContain('502')
  })

  it('still reports OK when the stream id cannot be recorded', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/api/stream/fetch')) return json({ streamId: 'guid-2' })
      // the second renditions PATCH (the one carrying streamId) fails
      if (u.includes('/renditions') && String(init?.body).includes('streamId')) {
        return json({ error: 'nope' }, false, 500)
      }
      return json({ ok: true })
    }) as unknown as typeof fetch

    const r = await uploadOriginalStorageFirst(args())
    expect(r.ok).toBe(true)
    expect(r.streamId).toBe('guid-2')
    expect(r.streamError).toContain('renditions')
  })

  it('DOES fail when the Storage upload itself fails — nothing is watchable then', async () => {
    ;(uploadBlobToStorage as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('storage credentials: HTTP 503')
    )
    globalThis.fetch = vi.fn(async () => json({ ok: true })) as unknown as typeof fetch

    const r = await uploadOriginalStorageFirst(args())
    expect(r.ok).toBe(false)
    expect(r.error).toContain('storage credentials')
  })
})

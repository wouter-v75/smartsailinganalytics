import { describe, it, expect, vi, beforeEach } from 'vitest'
import { uploadBlobToStorage } from '../bunny-storage-upload'

// Bunny Storage has no resumable upload, so a dropped connection means sending
// the object again. Retrying in the uploader is what stops a blip from quietly
// costing a clip. These pin WHICH failures are worth retrying.
class FakeXHR {
  static script: Array<'net' | number> = []
  static sent = 0
  upload = { onprogress: null as null | ((e: ProgressEvent) => void) }
  status = 0
  statusText = ''
  onerror: null | (() => void) = null
  onabort: null | (() => void) = null
  onload: null | (() => void) = null
  open() {}
  setRequestHeader() {}
  abort() {}
  send() {
    const step = FakeXHR.script[FakeXHR.sent++] ?? 201
    setTimeout(() => {
      if (step === 'net') this.onerror?.()
      else { this.status = step; this.statusText = 'x'; this.onload?.() }
    }, 0)
  }
}

const blob = () => new Blob([new Uint8Array(64)], { type: 'video/mp4' })

beforeEach(() => {
  FakeXHR.script = []; FakeXHR.sent = 0
  vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest)
  globalThis.fetch = vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ accessKey: 'k', zone: 'z', host: 'https://storage.example' }),
  })) as unknown as typeof fetch
})

describe('uploadBlobToStorage retries', () => {
  it('rides out a transient network drop and still lands the clip', async () => {
    FakeXHR.script = ['net', 'net', 201]
    const r = await uploadBlobToStorage({ key: 'a/b.mp4', blob: blob(), retryBaseMs: 1 })
    expect(r.bytes).toBe(64)
    expect(FakeXHR.sent).toBe(3)
  })

  it('gives up after the configured number of attempts', async () => {
    FakeXHR.script = ['net', 'net', 'net', 'net', 'net']
    await expect(uploadBlobToStorage({ key: 'a/b.mp4', blob: blob(), retries: 2, retryBaseMs: 1 }))
      .rejects.toThrow(/network/)
    expect(FakeXHR.sent).toBe(3)   // first attempt + 2 retries
  })

  it('does NOT retry a 4xx — a bad key or a bug will not fix itself', async () => {
    FakeXHR.script = [401, 201]
    await expect(uploadBlobToStorage({ key: 'a/b.mp4', blob: blob(), retryBaseMs: 1 }))
      .rejects.toThrow(/HTTP 401/)
    expect(FakeXHR.sent).toBe(1)
  })

  it('DOES retry a 5xx — Bunny having a moment is exactly the retryable case', async () => {
    FakeXHR.script = [503, 201]
    await uploadBlobToStorage({ key: 'a/b.mp4', blob: blob(), retryBaseMs: 1 })
    expect(FakeXHR.sent).toBe(2)
  })
})

import { describe, it, expect } from 'vitest'
import { uploadIsGone } from '../tusUploadError'

/** What tus-js-client hands to onError for an HTTP failure. */
const httpErr = (status: number) => ({
  message: `tus: unexpected response while uploading chunk`,
  originalResponse: { getStatus: () => status },
})

describe('uploadIsGone', () => {
  it('is true for the 404 Bunny returns once an upload has expired', () => {
    expect(uploadIsGone(httpErr(404))).toBe(true)
  })

  it('is true for 410 Gone', () => {
    expect(uploadIsGone(httpErr(410))).toBe(true)
  })

  it('is FALSE for a bare network error — the marina-wifi case', () => {
    // No HTTP response at all. This is the one that must keep resuming: a
    // multi-GB original restarted on every blip is worse than the stall.
    expect(uploadIsGone({ message: 'tus: failed to upload chunk', originalResponse: null })).toBe(false)
    expect(uploadIsGone(new Error('network down'))).toBe(false)
    expect(uploadIsGone(undefined)).toBe(false)
    expect(uploadIsGone(null)).toBe(false)
  })

  it('is FALSE for every other HTTP status, including ones worth retrying', () => {
    for (const s of [0, 400, 401, 403, 408, 409, 429, 500, 502, 503, 504]) {
      expect(uploadIsGone(httpErr(s))).toBe(false)
    }
  })

  it('tolerates the status as a plain property rather than a method', () => {
    expect(uploadIsGone({ originalResponse: { status: 404 } })).toBe(true)
    expect(uploadIsGone({ originalResponse: { status: 500 } })).toBe(false)
  })

  it('does not read a status out of the message text', () => {
    // A 404 in prose, or in a URL, is not a 404 from Bunny.
    expect(uploadIsGone({ message: 'tus: error for https://x/404/abc' })).toBe(false)
  })
})

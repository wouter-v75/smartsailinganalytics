import { describe, it, expect } from 'vitest'

// Mirror of the readiness rule in the videos list route. Whether a clip is
// PLAYABLE used to live only in the uploading browser's React state — lost on
// reload, absent on every other device — so a clip Bunny was still encoding showed
// a CLOUD badge on every phone and only revealed itself when someone tapped it.
const encoding = (v: { original_stream_status?: number | null; proxy_stream_status?: number | null; has_original?: boolean; has_proxy?: boolean }) => {
  const st = v.has_original ? v.original_stream_status : v.has_proxy ? v.proxy_stream_status : null
  return st == null ? null : st !== 4
}

describe('is this clip actually playable', () => {
  it('reports a finished encode as ready', () => {
    expect(encoding({ has_original: true, original_stream_status: 4 })).toBe(false)
  })

  it('reports the 7 Sept case — queued, not ready', () => {
    expect(encoding({ has_original: true, original_stream_status: 2 })).toBe(true)
    expect(encoding({ has_original: true, original_stream_status: 3 })).toBe(true)
  })

  it('does NOT claim an unchecked clip is encoding', () => {
    // null means nobody has asked Bunny yet. Every clip uploaded before this column
    // existed reads null, and calling those "still encoding" would put a processing
    // badge on the entire back catalogue.
    expect(encoding({ has_original: true, original_stream_status: null })).toBeNull()
    expect(encoding({ has_original: true })).toBeNull()
  })

  it('reads the tier the clip actually has', () => {
    // Originals-only uploads — which is what the drone segments are.
    expect(encoding({ has_original: true, original_stream_status: 2, proxy_stream_status: 4 })).toBe(true)
    // Proxy-only.
    expect(encoding({ has_proxy: true, proxy_stream_status: 4 })).toBe(false)
    expect(encoding({ has_proxy: true, proxy_stream_status: 2 })).toBe(true)
  })

  it('says nothing about a clip with no cloud rendition at all', () => {
    expect(encoding({})).toBeNull()
  })

  it('treats a FAILED encode as not ready rather than as ready', () => {
    // status 5 is a Bunny rejection; it will never reach 4.
    expect(encoding({ has_original: true, original_stream_status: 5 })).toBe(true)
  })
})

// src/lib/__tests__/photoOriginalUrl.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Where the viewer fetches a photo's full-resolution original from.
//
// This has been wrong twice, and both times it failed the same way: a photo that
// looked soft with a confident explanation printed over it. First the viewer was
// simply handed the 480 px thumbnail. Then it was handed a key RECONSTRUCTED
// from sessionDate + photo.id, which is right only for a photo the browser
// itself uploaded — so every photo put up by `npm run media:upload` showed
// "Thumbnail only — the full-resolution original has not reached the cloud yet"
// about a file that had been in Bunny for weeks.
//
// The rule, in one line: the path the ROW RECORDS beats any path we derive.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
// @ts-expect-error photoStore is plain JS with no types
import { photoOriginalUrl, keysForPhoto, cloudImageUrl } from '../photoStore'

const keyOf = (url: string | null) =>
  url ? decodeURIComponent(new URL(url, 'http://x').searchParams.get('key') || '') : null

/** What `media:upload` writes: its own key, and a Supabase UUID for the row. */
const scriptUploaded = {
  id: 'e3f1c2a4-55aa-4bbb-9ccc-0123456789ab',
  sessionDate: '2026-09-12',
  cloudSynced: true,
  bunnyPath: 'sessions/2026-09-12/photos/p_1790328226840_rqkezf6hhvi.jpg',
  url: 'sessions/2026-09-12/photos/p_1790328226840_rqkezf6hhvi.jpg',
}

/** What the browser import writes: a key derived from the id it just made. */
const browserUploaded = {
  id: 'p_1790328226840_abc',
  sessionDate: '2026-09-12',
  cloudSynced: true,
}

describe('photoOriginalUrl', () => {
  it('uses the path the row records, not one rebuilt from the id', () => {
    const url = photoOriginalUrl(scriptUploaded, '2026-09-12')
    expect(keyOf(url)).toBe('sessions/2026-09-12/photos/p_1790328226840_rqkezf6hhvi.jpg')
  })

  it('and that is NOT what the reconstruction would have given', () => {
    // The regression itself: if these two ever agree for a script-uploaded
    // photo, this test is no longer testing anything.
    const rebuilt = keysForPhoto(scriptUploaded, '2026-09-12').original
    expect(rebuilt).not.toBe(scriptUploaded.bunnyPath)
    expect(keyOf(photoOriginalUrl(scriptUploaded, '2026-09-12'))).not.toBe(rebuilt)
  })

  it('falls back to the reconstruction for a record with no path — the browser import', () => {
    const url = photoOriginalUrl(browserUploaded, '2026-09-12')
    expect(keyOf(url)).toBe(keysForPhoto(browserUploaded, '2026-09-12').original)
    expect(url).toBe(cloudImageUrl(keysForPhoto(browserUploaded, '2026-09-12').original))
  })

  it('takes `url` when `bunnyPath` is absent — toLegacyPhotoShape sets both', () => {
    const { bunnyPath, ...noPath } = scriptUploaded
    expect(keyOf(photoOriginalUrl(noPath, '2026-09-12'))).toBe(scriptUploaded.url)
  })

  it('returns null for a photo that is not in the cloud at all', () => {
    expect(photoOriginalUrl({ id: 'x', sessionDate: '2026-09-12', cloudSynced: false })).toBeNull()
    expect(photoOriginalUrl(null)).toBeNull()
    expect(photoOriginalUrl(undefined)).toBeNull()
  })

  it('still answers for a record whose sessionDate was never filled in', () => {
    // The tab passes the open day as the fallback; without it the key would
    // carry "null" where the date belongs.
    const url = photoOriginalUrl({ id: 'p_1', cloudSynced: true }, '2026-09-12')
    expect(keyOf(url)).toContain('2026-09-12')
  })
})

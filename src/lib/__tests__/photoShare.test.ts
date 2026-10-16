// src/lib/__tests__/photoShare.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Who may share a photograph with the data burned into it.
//
// The picture is a picture. The same frame with the overlay on it carries the
// day's TWS, TWA, boat speed, heel, the mast settings and any sail-geometry
// millimetres measured on it — the programme's own analysis. So the plain share
// is for everyone and the overlay share is Sailor Gold and up, on the same
// ladder as putting a clip on the open internet.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { canShareWithData, shareModeFor, shareFileName, SHARE_DATA_DENIED } from '../photoShare'

describe('canShareWithData', () => {
  it('allows Sailor Gold and up, and the boat owner', () => {
    for (const r of ['admin', 'team_manager', 'coach', 'tl3', 'owner']) {
      expect(canShareWithData(r)).toBe(true)
    }
  })

  it('refuses Sailor Silver, and anyone with no role at all', () => {
    // tl1 is Silver: sees the day, the map and the media, and may share the
    // PICTURE — just not the analysis burned onto it.
    expect(canShareWithData('tl1')).toBe(false)
    expect(canShareWithData(null)).toBe(false)
    expect(canShareWithData(undefined)).toBe(false)
    expect(canShareWithData('')).toBe(false)
  })

  it('tracks the video ladder rather than keeping its own list', () => {
    // The one way a role ends up called two different things in two places is
    // two lists. This one imports SHARE_ROLES.
    expect(canShareWithData('tl3')).toBe(true)
    expect(canShareWithData('tl2')).toBe(false)
  })
})

describe('shareModeFor', () => {
  it('gives a Gold what they asked for', () => {
    expect(shareModeFor('coach', 'with-data')).toBe('with-data')
    expect(shareModeFor('coach', 'plain')).toBe('plain')
  })

  it('DOWNGRADES a Silver rather than refusing', () => {
    // They can still share the photograph, and quietly getting the picture is
    // better than a button that does nothing. The caller says which it got.
    expect(shareModeFor('tl1', 'with-data')).toBe('plain')
    expect(shareModeFor(null, 'with-data')).toBe('plain')
  })

  it('is the decision, so stale UI state cannot ask its way past it', () => {
    // The gate lives here and not in the component: a button left enabled by a
    // role that changed mid-session still cannot produce the data file.
    expect(shareModeFor('tl1', 'with-data')).not.toBe('with-data')
  })
})

describe('shareFileName', () => {
  it('puts the mode in the name, since the two files look identical later', () => {
    expect(shareFileName('IMG_0042.JPG', 'plain')).toBe('IMG_0042.jpg')
    expect(shareFileName('IMG_0042.JPG', 'with-data')).toBe('IMG_0042_data.jpg')
  })

  it('survives a name that is missing, odd, or all punctuation', () => {
    expect(shareFileName(null, 'plain')).toBe('photo.jpg')
    expect(shareFileName('', 'with-data')).toBe('photo_data.jpg')
    expect(shareFileName('a b/c:d.png', 'plain')).toBe('a_b_c_d.jpg')
    expect(shareFileName('???.jpg', 'plain')).toBe('photo.jpg')
  })
})

describe('the denial message', () => {
  it('names the tier the way the rest of the app does', () => {
    expect(SHARE_DATA_DENIED).toMatch(/Sailor Gold and up/)
  })
})

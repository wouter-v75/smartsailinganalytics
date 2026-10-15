// src/lib/__tests__/tackFromAwa.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// The tack comes from AWA (Wouter, 15 Oct: "keep AWA to identify a tack").
//
// AWA is read straight off the masthead vane — the angle the wind makes with the
// boat, which is what "tack" means. TWA is CALCULATED from it: apparent wind
// plus boat speed, with a heel correction and the calibration tables on top. So
// every error in any of those reaches TWA and none of them reach AWA. Strictly
// more ways to be wrong, for a question AWA already answers.
//
// What this does NOT fix is a blanked feed. Both come off the same masthead, so
// on 11 Oct awa froze at −25.84 for the same 328 seconds that twa froze at
// −53.65. Heel is the independent witness for that — see tackFromHeel.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { tackFromAwa, tackFor, tackFromTwa } from '../sailTrim'

describe('tackFromAwa', () => {
  it('reads the sign the same way TWA does', () => {
    // Baraka's own rows: twa −53.6 with awa −25.8, and twa +46.7 with awa +20.6.
    // The two never disagree in sign, which is what makes AWA a safe swap.
    expect(tackFromAwa(-25.8)).toBe('port')
    expect(tackFromAwa(20.6)).toBe('stbd')
    expect(tackFromAwa(-25.8)).toBe(tackFromTwa(-53.6))
    expect(tackFromAwa(20.6)).toBe(tackFromTwa(46.7))
  })

  it('treats dead head as starboard, as TWA does, rather than returning null', () => {
    // Head to wind has no tack, but the convention has to be SOMETHING and it
    // must match tackFromTwa or the two would disagree at the boundary.
    expect(tackFromAwa(0)).toBe('stbd')
    expect(tackFromAwa(0)).toBe(tackFromTwa(0))
  })

  it('has no opinion with no reading', () => {
    expect(tackFromAwa(null)).toBeNull()
    expect(tackFromAwa(undefined)).toBeNull()
    expect(tackFromAwa(Number.NaN)).toBeNull()
  })

  it('works downwind, where heel could not', () => {
    // The reason this is the right source and heel is not: a boat can heel to
    // WINDWARD downwind, so heel implies nothing there, while AWA still says
    // which side the wind is on.
    expect(tackFromAwa(165)).toBe('stbd')
    expect(tackFromAwa(-165)).toBe('port')
  })
})

describe('tackFor', () => {
  it('prefers AWA and says so', () => {
    expect(tackFor({ awaDeg: -25.8, twaDeg: -53.6 })).toEqual({ tack: 'port', from: 'awa' })
  })

  it('falls back to TWA when AWA was never stored', () => {
    // A frame whose AWA is missing still needs a tack: without one, a
    // measurement's sign says only which way round the photograph is.
    expect(tackFor({ awaDeg: null, twaDeg: -53.6 })).toEqual({ tack: 'port', from: 'twa' })
  })

  it('believes AWA over TWA when they disagree', () => {
    // Not seen in this data, but TWA is the derived one, so if the two ever
    // part company AWA is the witness to keep.
    expect(tackFor({ awaDeg: 12, twaDeg: -40 })).toEqual({ tack: 'stbd', from: 'awa' })
  })

  it('reports no tack rather than guessing one', () => {
    expect(tackFor({ awaDeg: null, twaDeg: null })).toEqual({ tack: null, from: 'none' })
    expect(tackFor({})).toEqual({ tack: null, from: 'none' })
  })
})

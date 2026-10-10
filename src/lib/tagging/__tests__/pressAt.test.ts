import { describe, it, expect } from 'vitest'
import { pressAt } from '../pressAt'

// ─────────────────────────────────────────────────────────────────────────────
// The tab opens on today, which is right for tagging from the rail and wrong
// for tagging from the dock: a press on a day whose log is not the one on
// screen lands at the moment it was pressed, `t0` and `session_date` agree with
// each other, both are the wrong moment, and no check can see it. Clamping to
// the day's own data window turns that from unrecoverable into obvious.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MIN = Date.UTC(2026, 9, 9, 9, 12)
const DAY_MAX = Date.UTC(2026, 9, 9, 16, 40)
const bounds = { min: DAY_MIN, max: DAY_MAX }
const SAILING = Date.UTC(2026, 9, 9, 13, 30)        // mid-afternoon, on the water
const TOMORROW = Date.UTC(2026, 9, 10, 18, 5)       // the kitchen

describe('what a press means', () => {
  it('is the moment held on the track, before anything else', () => {
    const r = pressAt({ picked: SAILING, playhead: DAY_MIN, now: TOMORROW, bounds })
    expect(r).toEqual({ at: SAILING, source: 'picked', atWallClock: false })
  })

  it('then the card being reviewed, then the playhead', () => {
    expect(pressAt({ review: SAILING, playhead: DAY_MIN, now: TOMORROW, bounds }).source).toBe('review')
    expect(pressAt({ playhead: SAILING, now: TOMORROW, bounds }).source).toBe('playhead')
  })

  it('is the clock while the boat is sailing', () => {
    const r = pressAt({ now: SAILING, bounds })
    expect(r).toEqual({ at: SAILING, source: 'clock', atWallClock: false })
  })
})

describe('the clock, outside the day it is being pressed on', () => {
  it('CANNOT land after the log stops', () => {
    // The bug, in one assertion: pressed the day after sailing, on a day that
    // has a log, the tag used to land 25 hours past the last row.
    const r = pressAt({ now: TOMORROW, bounds })
    expect(r.at).toBe(DAY_MAX)
    expect(r.source).toBe('clamped')
    expect(r.atWallClock).toBe(false)
  })

  it('cannot land before the boat left the dock either', () => {
    const r = pressAt({ now: DAY_MIN - 3 * 3600_000, bounds })
    expect(r.at).toBe(DAY_MIN)
    expect(r.source).toBe('clamped')
  })

  it('lands somewhere wrong but RECOVERABLE — on the day, on the track', () => {
    // Which is the whole trade: a tag at the end of the right day's data is
    // visibly wrong and can be dragged. A tag on a day nobody sailed cannot be
    // found, let alone dragged.
    const r = pressAt({ now: TOMORROW, bounds })
    expect(r.at).toBeGreaterThanOrEqual(DAY_MIN)
    expect(r.at).toBeLessThanOrEqual(DAY_MAX)
  })
})

describe('a day with nothing to place a tag against', () => {
  it('takes the press, and says it cannot be checked', () => {
    // Not refused: somebody pressing a button means something by it, and on a
    // day being sailed right now with the log not yet imported the clock is
    // exactly right. It is reported so the tab can say so BEFORE the press.
    const r = pressAt({ now: TOMORROW })
    expect(r).toEqual({ at: TOMORROW, source: 'clock', atWallClock: true })
  })

  it('counts a half-known window as no window', () => {
    // One end missing cannot clamp anything, and pretending otherwise would
    // put every press at the one end that is known.
    expect(pressAt({ now: TOMORROW, bounds: { min: DAY_MIN, max: null } }).atWallClock).toBe(true)
    expect(pressAt({ now: TOMORROW, bounds: { min: null, max: DAY_MAX } }).atWallClock).toBe(true)
  })

  it('does not warn when there IS something to point at', () => {
    // A video playing with no log imported yet: the playhead is a real instant
    // in the sailing, so nothing is being guessed.
    expect(pressAt({ playhead: SAILING, now: TOMORROW }).atWallClock).toBe(false)
  })

  it('ignores a window whose ends are the wrong way round', () => {
    expect(pressAt({ now: TOMORROW, bounds: { min: DAY_MAX, max: DAY_MIN } }).atWallClock).toBe(true)
  })

  it('ignores a nonsense pick rather than tagging NaN', () => {
    expect(pressAt({ picked: NaN, now: SAILING, bounds }).source).toBe('clock')
    expect(pressAt({ picked: Infinity, review: null, now: SAILING, bounds }).at).toBe(SAILING)
  })
})

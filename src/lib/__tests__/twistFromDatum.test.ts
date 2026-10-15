// src/lib/__tests__/twistFromDatum.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Twist measured from the boom, and never above the highest mark.
//
// Two separate requirements, both from Wouter, 14 Oct:
//
//  1. twist "can only be calculated between points that were added to the leech
//     (plus boom/clew), not extended above";
//  2. "Twist is always positive, also when the boom is above the centre line
//     (negative). So, for both sails, take the clew/boom as the starting (0)
//     point and calculate from there."
//
// (2) is also the textbook definition — twist is the chord angle compared with
// the BOOM's, and the sailmakers' worked examples read 5/10/20 deg bottom to
// top, cumulative and positive. (1) is a guarantee the pipeline already keeps by
// construction, which is exactly why it is worth a test: nothing else would
// notice if an interpolation crept in.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { stationAngles, twistFromDatum, twistBetween, type SailWidths } from '../sailTwist'

/** Northstar 76's main, off the certificate. */
const MAIN: SailWidths = { foot: 10.33, half: 7.04, threeQuarter: 4.93, upper: 3.63 }

const at = (tag: string, mm: number) => ({ tag: tag as never, mm, sigmaMm: 20 })

describe('twist is measured from the clew/boom', () => {
  it('gives one cumulative figure per station, all from the clew', () => {
    const angles = stationAngles('main', MAIN, [
      at('clew', 1000), at('stripe25', 1200), at('stripe50', 1400), at('stripe75', 1500),
    ])
    const { datum, rows } = twistFromDatum(angles, true)
    expect(datum?.tag).toBe('clew')
    expect(rows.map((r) => r.to)).toEqual(['stripe25', 'stripe50', 'stripe75'])
    // Every row is measured FROM the clew, not from the station below it.
    expect(rows.every((r) => r.from === 'clew')).toBe(true)
    // And it opens with height, which is what twist is.
    expect(rows[0].twistDeg).toBeLessThan(rows[1].twistDeg)
    expect(rows[1].twistDeg).toBeLessThan(rows[2].twistDeg)
  })

  it('is POSITIVE with the boom to windward, which is the case that was wrong', () => {
    // Light air: the boom and the 25 % point sit to WINDWARD of the centreline
    // (negative, leeward-positive convention) while the head falls away to
    // leeward. The absolute chord angle at the clew is negative; the twist is
    // not, because it is measured from that clew.
    const angles = stationAngles('main', MAIN, [
      at('clew', -400), at('stripe25', -150), at('stripe50', 600), at('stripe75', 1100),
    ])
    const { datum, rows } = twistFromDatum(angles, true)
    expect(datum!.angle.deg).toBeLessThan(0)          // the boom really is to windward
    expect(rows.every((r) => r.twistDeg > 0)).toBe(true)
    // The twist across a crossing leech ADDS the two sides rather than
    // subtracting them: 1.5 deg to windward under 6 deg to leeward is 7.5, and
    // a magnitude-based reading would have called it 4.5.
    const top = rows.find((r) => r.to === 'stripe75')!
    expect(top.twistDeg).toBeCloseTo(top.toDeg - top.fromDeg, 9)
    expect(top.twistDeg).toBeGreaterThan(Math.abs(top.toDeg))
  })

  it('does NOT force the sign positive, because a closing leech is real', () => {
    // A hooked top — the leech closing as it rises — is a trim fault worth
    // seeing. Math.abs here would report the worst leech on the boat as the
    // best, so the sign survives and the caller can say so.
    const angles = stationAngles('main', MAIN, [at('clew', 1400), at('stripe75', 500)])
    const { rows } = twistFromDatum(angles, true)
    expect(rows[0].twistDeg).toBeLessThan(0)
  })

  it('falls back to the lowest mark when there is no clew, and SAYS so', () => {
    const angles = stationAngles('main', MAIN, [at('stripe25', 1200), at('stripe50', 1400)])
    const { datum, datumNote, rows } = twistFromDatum(angles, true)
    expect(datum?.tag).toBe('stripe25')
    expect(datumNote).toMatch(/no clew mark/)
    expect(datumNote).toMatch(/too SMALL/)
    expect(rows).toHaveLength(1)
  })

  it('reads the same on both tacks without a tack to go on', () => {
    const port = stationAngles('main', MAIN, [at('clew', 400), at('stripe50', 1400)])
    const stbd = stationAngles('main', MAIN, [at('clew', -400), at('stripe50', -1400)])
    expect(twistFromDatum(port, false).rows[0].twistDeg)
      .toBeCloseTo(twistFromDatum(stbd, false).rows[0].twistDeg, 9)
  })

  it('agrees with the adjacent-pair twists summed, which is the other convention', () => {
    // The two are the same quantity presented differently, so the top
    // cumulative figure must equal the sum of the steps. If they ever disagree
    // one of them is wrong.
    const angles = stationAngles('main', MAIN, [
      at('clew', 1000), at('stripe25', 1200), at('stripe50', 1400), at('stripe75', 1500),
    ])
    const steps = twistBetween(angles, true).reduce((t, r) => t + r.twistDeg, 0)
    const cumulative = twistFromDatum(angles, true).rows.at(-1)!.twistDeg
    expect(cumulative).toBeCloseTo(steps, 9)
  })
})

describe('nothing above the highest mark', () => {
  it('produces no station for a height that was never marked', () => {
    const angles = stationAngles('main', MAIN, [at('clew', 1000), at('stripe25', 1200)])
    expect(angles.map((a) => a.tag)).toEqual(['clew', 'stripe25'])
    // One mark above the datum is ONE twist figure. Not four, and nothing
    // extrapolated to 50/75/87 because the sail has widths up there.
    expect(twistFromDatum(angles, true).rows).toHaveLength(1)
  })

  it('never makes a twist station out of a spreader', () => {
    // A spreader has no honest fraction of the hoist — where spreader 2 sits
    // depends on the rig — so it cannot carry a chord angle, and a spreader
    // crossing is found by intersecting the leech polyline rather than marked
    // on it. Both reasons to keep it out.
    const angles = stationAngles('main', MAIN, [at('clew', 1000), at('spr2', 1300), at('stripe50', 1400)])
    expect(angles.map((a) => a.tag)).toEqual(['clew', 'stripe50'])
  })

  it('refuses a station whose width is off the end of the certificate', () => {
    // stripe87 against a sail with no upper width: 0.875 is outside the
    // bracket, widthAt returns null, and the station is dropped rather than
    // extrapolated off the top of the planform.
    const noUpper: SailWidths = { foot: 10.33, half: 7.04, threeQuarter: 4.93, upper: null }
    const angles = stationAngles('main', noUpper, [at('clew', 1000), at('stripe87', 1600)])
    expect(angles.map((a) => a.tag)).toEqual(['clew'])
    expect(twistFromDatum(angles, true).rows).toHaveLength(0)
  })

  it('gives nothing at all rather than something, with no stations', () => {
    const { datum, rows } = twistFromDatum([], true)
    expect(datum).toBeNull()
    expect(rows).toEqual([])
  })
})

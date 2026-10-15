// src/lib/__tests__/twistRelative.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Twist between adjacent stripes, and the sign it comes out with.
//
// Wouter, 14/15 Oct, in two parts:
//
//  1. twist "can only be calculated between points that were added to the leech
//     (plus boom/clew), not extended above";
//  2. "Twist is always positive, also when the boom is above the centre line
//     (negative). So, for both sails, take the clew/boom as the starting (0)
//     point"  — and then, explicitly: "twist should be relative between the
//     trim stripes, not cumulative from the clew".
//
// So the rows are STEPS, stripe to stripe. The clew's job is to be the bottom of
// that chain and to fix which direction counts as opening — not to be subtracted
// from everything.
//
// Note the step figures are indifferent to the datum arithmetically: subtracting
// a common angle from both ends of a difference cancels. What the clew actually
// changes is the SIGN FRAME when the tack is unknown, which is the case that was
// broken — see the windward-boom test.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { stationAngles, twistBetween, type SailWidths } from '../sailTwist'

/** Northstar 76's main, off the certificate. */
const MAIN: SailWidths = { foot: 10.33, half: 7.04, threeQuarter: 4.93, upper: 3.63 }

const at = (tag: string, mm: number) => ({ tag: tag as never, mm, sigmaMm: 20 })

describe('twist is relative, stripe to stripe', () => {
  it('reports one step per adjacent pair, lowest first, starting at the clew', () => {
    const angles = stationAngles('main', MAIN, [
      at('clew', 1000), at('stripe25', 1200), at('stripe50', 1400), at('stripe75', 1500),
    ])
    const rows = twistBetween(angles, true)
    expect(rows.map((r) => `${r.from}->${r.to}`))
      .toEqual(['clew->stripe25', 'stripe25->stripe50', 'stripe50->stripe75'])
  })

  it('is a STEP, not a running total from the foot', () => {
    // The cumulative reading would make the top row the whole sail's twist. It
    // is not: each row is only the opening across its own pair, so the last row
    // can be the smallest even though it is highest.
    const angles = stationAngles('main', MAIN, [
      at('clew', 0), at('stripe25', 900), at('stripe50', 1000),
    ])
    const rows = twistBetween(angles, true)
    expect(rows[1].twistDeg).toBeLessThan(rows[0].twistDeg)
    // Each row is exactly its own pair's difference and nothing else.
    for (const r of rows) expect(r.twistDeg).toBeCloseTo(r.toDeg - r.fromDeg, 9)
  })

  it('is POSITIVE with the boom to WINDWARD and no tack known', () => {
    // The case that was wrong. Light air: the boom and the 25 % point sit to
    // windward of the centreline while the head falls away to leeward, so the
    // CLEW is the station furthest from the centreplane. The old frame was
    // picked off that furthest station, which meant it came off the bottom of
    // the sail and every step read negative on a sail twisting normally.
    const angles = stationAngles('main', MAIN, [
      at('clew', -2000), at('stripe25', -200), at('stripe50', 500), at('stripe75', 800),
    ])
    const far = angles.reduce((m, a) => (Math.abs(a.angle.deg) > Math.abs(m.angle.deg) ? a : m), angles[0])
    expect(far.tag).toBe('clew')                       // the trap is live in this fixture
    expect(twistBetween(angles, false).every((r) => r.twistDeg > 0)).toBe(true)
    expect(twistBetween(angles, true).every((r) => r.twistDeg > 0)).toBe(true)
  })

  it('adds the two sides where the leech crosses the centreplane', () => {
    // 1.3 deg to windward under 2.8 deg to leeward is 4.1 deg of twist.
    // Magnitudes would call it 1.5 and understate the opening by nearly three.
    const angles = stationAngles('main', MAIN, [at('clew', -250), at('stripe50', 350)])
    const r = twistBetween(angles, true)[0]
    expect(r.fromDeg).toBeLessThan(0)
    expect(r.toDeg).toBeGreaterThan(0)
    expect(r.twistDeg).toBeCloseTo(r.toDeg - r.fromDeg, 9)
    expect(r.twistDeg).toBeGreaterThan(Math.abs(r.toDeg))
    expect(r.twistDeg).toBeGreaterThan(Math.abs(r.fromDeg))
  })

  it('does NOT force the sign positive, because a closing leech is real', () => {
    // A hooked section — closing as it rises — is a trim fault worth seeing.
    // Math.abs would report the worst part of the sail as though it were the
    // best. Only the overall frame is anchored; individual steps keep their sign.
    const angles = stationAngles('main', MAIN, [
      at('clew', 0), at('stripe25', 1200), at('stripe50', 900), at('stripe75', 1600),
    ])
    const rows = twistBetween(angles, true)
    expect(rows[1].twistDeg).toBeLessThan(0)
    expect(rows[0].twistDeg).toBeGreaterThan(0)
  })

  it('reads the same on both tacks with no tack to go on', () => {
    const port = stationAngles('main', MAIN, [at('clew', 400), at('stripe50', 1400)])
    const stbd = stationAngles('main', MAIN, [at('clew', -400), at('stripe50', -1400)])
    expect(twistBetween(port, false)[0].twistDeg)
      .toBeCloseTo(twistBetween(stbd, false)[0].twistDeg, 9)
  })
})

describe('nothing above the highest mark', () => {
  it('produces no step for a height that was never marked', () => {
    const angles = stationAngles('main', MAIN, [at('clew', 1000), at('stripe25', 1200)])
    expect(angles.map((a) => a.tag)).toEqual(['clew', 'stripe25'])
    // One mark above the clew is ONE step. Nothing extrapolated to 50/75/87
    // because the sail happens to have certificate widths up there.
    expect(twistBetween(angles, true)).toHaveLength(1)
  })

  it('never makes a twist station out of a spreader', () => {
    // A spreader has no honest fraction of the hoist — where spreader 2 sits
    // depends on the rig — so it cannot carry a chord angle.
    const angles = stationAngles('main', MAIN, [at('clew', 1000), at('spr2', 1300), at('stripe50', 1400)])
    expect(angles.map((a) => a.tag)).toEqual(['clew', 'stripe50'])
  })

  it('refuses a station whose width is off the end of the certificate', () => {
    // stripe87 against a sail with no upper width: 0.875 is outside the
    // bracket, so the station is dropped rather than extrapolated off the top
    // of the planform.
    const noUpper: SailWidths = { foot: 10.33, half: 7.04, threeQuarter: 4.93, upper: null }
    const angles = stationAngles('main', noUpper, [at('clew', 1000), at('stripe87', 1600)])
    expect(angles.map((a) => a.tag)).toEqual(['clew'])
    expect(twistBetween(angles, true)).toHaveLength(0)
  })

  it('gives nothing from one station, since a step needs two', () => {
    expect(twistBetween(stationAngles('main', MAIN, [at('clew', 1000)]), true)).toEqual([])
    expect(twistBetween([], true)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// When ONE frame is enough. Wouter, 15 Oct: single shot when square astern
// (ψ = 0 ± 1°), three frames minimum off the centreline.
//
// The reason is a derivative, not a convention. Y = (Δu·s + d·sinψ·cosφ)/cosψ,
// so ∂Y/∂d = tanψ·cosφ — which is ZERO at ψ = 0. The station depth is the one
// thing a single photograph cannot give, and at ψ = 0 it cannot affect the
// answer either, however bad the guess.
// ─────────────────────────────────────────────────────────────────────────────

import { depthTwistErrorDeg, twistEligibility } from '../sailTwist'

/** The 50 % stripe on Northstar's main, on an unmeasured depth. */
const ST = { depthSigmaMm: 2500, widthM: 7.04, leechMm: 1400 }

describe('whether one frame can carry a twist number', () => {
  it('makes the depth guess IRRELEVANT at ψ = 0, however bad it is', () => {
    expect(depthTwistErrorDeg({ psiDeg: 0, heelDeg: 20, ...ST })).toBe(0)
    // Ten metres of depth error, still exactly zero. This is the whole argument
    // for trusting a single square-astern frame.
    expect(depthTwistErrorDeg({ psiDeg: 0, heelDeg: 20, ...ST, depthSigmaMm: 10_000 })).toBe(0)
  })

  it('grows with ψ, which is what sets the 1° bar', () => {
    const at = (psiDeg: number) => depthTwistErrorDeg({ psiDeg, heelDeg: 20, ...ST })
    // ~0.35° at 1°: just under the 0.3-0.9° the rest of the pipeline carries.
    expect(at(1)).toBeGreaterThan(0.2)
    expect(at(1)).toBeLessThan(0.5)
    // ~1.8° at 5°: larger than the twist differences anyone is reading.
    expect(at(5)).toBeGreaterThan(1.4)
    // Very nearly linear in ψ over this range, since tan ψ ≈ ψ.
    expect(at(5) / at(1)).toBeGreaterThan(4.8)
    expect(at(5) / at(1)).toBeLessThan(5.2)
  })

  it('passes a square-astern frame on its own', () => {
    const e = twistEligibility({ psiDeg: 0.4, psiMeasured: true, stations: [ST], heelDeg: 18 })
    expect(e.ok).toBe(true)
    expect(e.code).toBe('astern')
    expect(e.note).toMatch(/one frame is exact/)
  })

  it('refuses an off-centreline frame measured on guessed depths', () => {
    const e = twistEligibility({ psiDeg: 5, psiMeasured: true, stations: [ST], heelDeg: 18 })
    expect(e.ok).toBe(false)
    expect(e.code).toBe('needs-frames')
    expect(e.note).toMatch(/three-frame set/)
    expect(e.worstDeg!).toBeGreaterThan(1)
  })

  it('allows an off-centreline frame once the depths HAVE been solved', () => {
    // sailtrim-triangulate stores a depth on its own sigma, capped at ±250 mm.
    // That is 10x better than the guess, and it is what buys back the angle.
    const solved = { ...ST, depthSigmaMm: 250 }
    const e = twistEligibility({ psiDeg: 5, psiMeasured: true, stations: [solved], heelDeg: 18, depthsFromSet: true })
    expect(e.ok).toBe(true)
    expect(e.code).toBe('depths-measured')
    expect(e.worstDeg!).toBeLessThan(0.5)
  })

  it('will not call an INFERRED ψ square astern', () => {
    // psiFromHeelShortening documents itself as indicative only and has no
    // side, so a reading near zero is not evidence of being square astern.
    const e = twistEligibility({ psiDeg: 0.2, psiMeasured: false, stations: [ST] })
    expect(e.ok).toBe(false)
    expect(e.code).toBe('no-psi')
  })

  it('judges on the WORST station, not an average', () => {
    // The narrow stations aloft are the sensitive ones: the same millimetres of
    // depth error divide by a smaller width, so an upper stripe can fail while
    // the foot passes.
    const narrow = { depthSigmaMm: 2500, widthM: 3.63, leechMm: 900 }
    const e = twistEligibility({ psiDeg: 2, psiMeasured: true, stations: [ST, narrow], heelDeg: 18 })
    expect(e.worstDeg).toBeCloseTo(depthTwistErrorDeg({ psiDeg: 2, heelDeg: 18, ...narrow }), 9)
    expect(e.worstDeg!).toBeGreaterThan(depthTwistErrorDeg({ psiDeg: 2, heelDeg: 18, ...ST }))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A STRIPE's twist: the North / Sail Vision definition.
//
// Referenced to the sail's own FOOT — the clew-to-tack plane — not to the
// boat's midline. North's SailScan lists "TWIST — how the top opens relative to
// the boom" and tells the photographer to get the boom's centre in frame
// because it is needed for the twist profile; Sail Vision's reports accumulate
// pairwise twists from the foot stripe, which is 0 by definition. Only VSPARS
// reports an angle to the boat centreline, and that is a SHEETING angle.
//
// The midline is the wrong datum because it is not the sail's: ease the
// traveller three degrees and every centreline-referenced angle moves three
// degrees while the sail's shape is untouched.
// ─────────────────────────────────────────────────────────────────────────────

import { stripeTwists } from '../sailTwist'

describe('stripeTwists', () => {
  const angles = stationAngles('main', MAIN, [
    at('clew', 1000), at('stripe25', 1200), at('stripe50', 1400), at('stripe75', 1500),
  ])

  it('reads ZERO at the foot, which is the datum everything else is against', () => {
    const foot = stripeTwists(angles, true).find((s) => s.tag === 'clew')!
    expect(foot.twistDeg).toBe(0)
    // And it carries no error, because it is zero by definition rather than
    // by measurement.
    expect(foot.sigmaDeg).toBe(0)
    expect(foot.datumIsFoot).toBe(true)
  })

  it('opens positive with height', () => {
    const st = stripeTwists(angles, true)
    const by = (t: string) => st.find((s) => s.tag === t)!.twistDeg
    expect(by('stripe25')).toBeGreaterThan(0)
    expect(by('stripe50')).toBeGreaterThan(by('stripe25'))
    expect(by('stripe75')).toBeGreaterThan(by('stripe50'))
  })

  it('is the chord angle MINUS the foot’s, not the raw angle to the midline', () => {
    const st = stripeTwists(angles, true)
    const foot = angles.find((a) => a.tag === 'clew')!
    for (const s of st) {
      const a = angles.find((x) => x.tag === s.tag)!
      expect(s.twistDeg).toBeCloseTo(a.angle.deg - foot.angle.deg, 9)
      // The distinction that matters: the stripe's own angle to the boat's
      // midline is a DIFFERENT number, and bigger.
      if (s.tag !== 'clew') expect(Math.abs(a.angle.deg)).toBeGreaterThan(Math.abs(s.twistDeg))
    }
  })

  it('is EXACTLY unmoved by sheeting the whole sail out, which the midline angle is not', () => {
    // The argument for the foot datum, as arithmetic — and it has to model
    // sheeting correctly to make the point. Easing the traveller ROTATES the
    // sail about the mast, so every chord's angle shifts by the same delta; it
    // does not add the same millimetres to every station (a rotation moves a
    // station by its DEPTH times delta, and the stations are at very different
    // depths). So rotate each station's chord by 4 deg and rebuild its offset.
    const DELTA = 4
    const g = { clew: 10.33, stripe25: (10.33 + 7.04) / 2, stripe50: 7.04, stripe75: 4.93 }
    const rotate = (tag: keyof typeof g, mm: number) => {
      const width = g[tag] * 1000
      return Math.sin(Math.asin(mm / width) + (DELTA * Math.PI) / 180) * width
    }
    const eased = stationAngles('main', MAIN, [
      at('clew', rotate('clew', 1000)), at('stripe25', rotate('stripe25', 1200)),
      at('stripe50', rotate('stripe50', 1400)), at('stripe75', rotate('stripe75', 1500)),
    ])
    // Every raw angle to the midline has moved by the full 4 deg...
    for (const b of angles) {
      const a = eased.find((x) => x.tag === b.tag)!
      expect(a.angle.deg - b.angle.deg).toBeCloseTo(DELTA, 6)
    }
    // ...and not one twist figure has moved at all. The shape did not change,
    // and the foot-referenced twist is the only column that says so.
    const before = stripeTwists(angles, true), after = stripeTwists(eased, true)
    for (const b of before) {
      expect(after.find((x) => x.tag === b.tag)!.twistDeg).toBeCloseTo(b.twistDeg, 6)
    }
  })

  it('flags a stand-in datum when no clew was marked', () => {
    const noClew = stationAngles('main', MAIN, [at('stripe25', 1200), at('stripe50', 1400)])
    const st = stripeTwists(noClew, true)
    expect(st.every((s) => s.datumIsFoot)).toBe(false)
    expect(st.find((s) => s.tag === 'stripe25')!.twistDeg).toBe(0)
  })

  it('agrees with the pairwise rows, since both are differences of the same angles', () => {
    const st = stripeTwists(angles, true)
    const rows = twistBetween(angles, true)
    for (const r of rows) {
      const lo = st.find((s) => s.tag === r.from)!, hi = st.find((s) => s.tag === r.to)!
      expect(hi.twistDeg - lo.twistDeg).toBeCloseTo(r.twistDeg, 9)
    }
  })

  it('reads the same on both tacks with no tack known', () => {
    const port = stationAngles('main', MAIN, [at('clew', 400), at('stripe50', 1400)])
    const stbd = stationAngles('main', MAIN, [at('clew', -400), at('stripe50', -1400)])
    expect(stripeTwists(port, false).find((s) => s.tag === 'stripe50')!.twistDeg)
      .toBeCloseTo(stripeTwists(stbd, false).find((s) => s.tag === 'stripe50')!.twistDeg, 9)
  })
})

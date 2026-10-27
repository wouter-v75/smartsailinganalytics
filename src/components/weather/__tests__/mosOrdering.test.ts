// The order of the correction and the vertical lift.
//
// A spec is a handful of coefficients and a `type`; nothing in the JSON says
// at which height they were fitted, so nothing stops a 10 m-fitted correction
// being applied to a 30 m wind. The slope survives that mistake and the
// INTERCEPT does not — it comes out wrong by the lift ratio, which is ~1.08-1.12
// in near-neutral marine air and larger on a stable fjord morning, i.e. wrong
// by most where the lift matters most.
//
// These tests pin three things: that the existing 30 m specs keep their
// current behaviour exactly, that a 10 m spec takes the other order, and that
// the two orders really do differ — because a test that passed either way
// would be worthless.

import { describe, expect, it } from 'vitest'
import { fitHeightM, needsPreLift, correctedWind30, mosSeries, applyMOS, wind30, specFor, calibratedVenues } from '../mos'
import { applyMosToField } from '../windField'

const KMH = 1 / 0.539957   // knots -> km/h, the payload's unit

/** An hourly payload with a single 10 m level, as metno_nordic serves. */
function payload(speedsKn: number[], dirs: number[] = []) {
  return {
    time: speedsKn.map((_, i) => `2026-06-0${1 + Math.floor(i / 24)}T${String(i % 24).padStart(2, '0')}:00`),
    wind_speed_10m: speedsKn.map((s) => s * KMH),
    wind_direction_10m: speedsKn.map((_, i) => dirs[i] ?? 225),
  } as Record<string, unknown>
}

const SPEC10 = {
  venue: 'oslofjord',
  fit_height_m: 10,
  bands: [],
  models: { metno_nordic: { type: 'bias_scale', a: 1.1, b: 1.5 } },
}
const SPEC30 = {
  venue: 'porto-cervo',
  target_height_m: 30,
  bands: [],
  models: { metno_nordic: { type: 'bias_scale', a: 1.1, b: 1.5 } },
}

describe('fitHeightM', () => {
  it('prefers fit_height_m', () => {
    expect(fitHeightM({ fit_height_m: 10, target_height_m: 30 })).toBe(10)
  })

  it('falls back to target_height_m, so an older spec keeps its meaning', () => {
    expect(fitHeightM({ target_height_m: 30 })).toBe(30)
    expect(fitHeightM({ target_height_m: 10 })).toBe(10)
  })

  it('defaults to 30, which is what every existing spec says', () => {
    expect(fitHeightM({})).toBe(30)
    expect(fitHeightM(null)).toBe(30)
    expect(fitHeightM({ fit_height_m: 0 })).toBe(30)
    expect(fitHeightM({ fit_height_m: 'ten' })).toBe(30)
  })
})

describe('a 30 m spec keeps the old behaviour, exactly', () => {
  it('is lift-then-correct, identical to calling wind30 and applyMOS by hand', () => {
    const h = payload([12, 18, 7])
    for (let i = 0; i < 3; i++) {
      const got = correctedWind30(h, [10], i, SPEC30, 'metno_nordic', 'UTC')!
      const w = wind30(h, [10], i, 30, 0.11, null)!
      const want = applyMOS(SPEC30, 'metno_nordic', w.ws30, w.twd, Number(h.time[i].slice(11, 13)))!
      expect(got.ws).toBeCloseTo(want.ws, 10)
      expect(got.lifted).toBe(false)
      expect(got.fitZ).toBe(30)
    }
  })
})

describe('a 10 m spec corrects first, then lifts', () => {
  it('equals applying the correction at 10 m and lifting the result', () => {
    const h = payload([12])
    const got = correctedWind30(h, [10], 0, SPEC10, 'metno_nordic', 'UTC')!
    // The correction at 10 m: 1.1 * 12 + 1.5 = 14.7 kn.
    const corrected10 = 1.1 * 12 + 1.5
    expect(got.fitZ).toBe(10)
    expect(got.lifted).toBe(true)
    // The lift must RAISE it — 30 m is windier than 10 m over water.
    expect(got.ws).toBeGreaterThan(corrected10)
    // and by a plausible marine ratio, not a wild one
    expect(got.ws / corrected10).toBeGreaterThan(1.02)
    expect(got.ws / corrected10).toBeLessThan(1.45)
    expect(got.liftRatio).toBeCloseTo(got.ws / corrected10, 6)
  })

  it('DIFFERS from applying the same coefficients at 30 m', () => {
    // This is the whole point. If the two orders agreed, none of this would
    // matter and the ordering change would be pointless ceremony.
    const h = payload([12])
    const correctFirst = correctedWind30(h, [10], 0, SPEC10, 'metno_nordic', 'UTC')!
    const liftFirst = correctedWind30(h, [10], 0, SPEC30, 'metno_nordic', 'UTC')!
    expect(Math.abs(correctFirst.ws - liftFirst.ws)).toBeGreaterThan(0.05)
  })

  it('the gap is dominated by the intercept times the lift ratio', () => {
    // The report's algebra takes r as a constant, giving a difference of
    // exactly b*(r-1). It is not constant HERE, and that is deliberate: the
    // surface layer is solved from the corrected speed, Charnock roughness
    // depends on friction velocity, so r itself depends on which speed it is
    // applied to. correct-then-lift uses r(a*x+b); lift-then-correct uses
    // r(x). The extra term is a*x*(r(a*x+b) - r(x)).
    //
    // So b*(r-1) is the leading term, not the whole difference. Same sign and
    // right order — which is what the ordering argument actually needs.
    const h = payload([12])
    const b = 1.5
    const correctFirst = correctedWind30(h, [10], 0, SPEC10, 'metno_nordic', 'UTC')!
    const liftFirst = correctedWind30(h, [10], 0, SPEC30, 'metno_nordic', 'UTC')!
    const r = correctFirst.liftRatio!
    const leading = b * (r - 1)
    const actual = correctFirst.ws - liftFirst.ws
    expect(Math.sign(actual)).toBe(Math.sign(leading))
    expect(actual).toBeGreaterThan(leading * 0.5)
    expect(actual).toBeLessThan(leading * 2)
  })

  it('a purely multiplicative correction ALMOST commutes with the lift', () => {
    // With b = 0 the constant-r algebra says the two orders agree exactly.
    // They agree to about 0.1%, and the residue is the speed dependence of
    // Charnock roughness: scaling the wind by 1.1 changes u*, which changes
    // z0, which changes the profile. Physically real and second order — but
    // "commutes" is too strong a word for it, so this pins the size instead.
    const h = payload([12])
    const mul10 = { fit_height_m: 10, bands: [], models: { m: { type: 'bias_scale', a: 1.1, b: 0 } } }
    const mul30 = { target_height_m: 30, bands: [], models: { m: { type: 'bias_scale', a: 1.1, b: 0 } } }
    const cf = correctedWind30(h, [10], 0, mul10, 'm', 'UTC')!
    const lf = correctedWind30(h, [10], 0, mul30, 'm', 'UTC')!
    const rel = Math.abs(cf.ws - lf.ws) / lf.ws
    expect(rel).toBeLessThan(0.005)
    expect(rel).toBeGreaterThan(0)
    // and far smaller than the gap an intercept opens up
    const withB = Math.abs(
      correctedWind30(h, [10], 0, SPEC10, 'metno_nordic', 'UTC')!.ws
      - correctedWind30(h, [10], 0, SPEC30, 'metno_nordic', 'UTC')!.ws,
    )
    expect(Math.abs(cf.ws - lf.ws)).toBeLessThan(withB)
  })

  it('carries the lift uncertainty separately from the correction', () => {
    // Nothing in the data validates a 30 m value, so the lift's own
    // uncertainty must not be folded into the corrected number silently.
    const got = correctedWind30(payload([12]), [10], 0, SPEC10, 'metno_nordic', 'UTC')!
    expect(got.liftUncertainty).toBeGreaterThan(0)
    expect(got.quality).toBeTruthy()
  })

  it('does not lift a zero or calm wind into something', () => {
    const got = correctedWind30(payload([0]), [10], 0, SPEC10, 'metno_nordic', 'UTC')
    // wind30 returns null for a zero level, so there is nothing to correct.
    expect(got).toBeNull()
  })
})

describe('mosSeries routes through the same ordering', () => {
  it('matches correctedWind30 hour by hour for a 10 m spec', () => {
    const h = payload([8, 14, 22, 5])
    const series = mosSeries(h, [10], SPEC10, 'metno_nordic', 'UTC')!
    expect(series).toHaveLength(4)
    series.forEach((v, i) => {
      const r = correctedWind30(h, [10], i, SPEC10, 'metno_nordic', 'UTC')
      expect(v).toBeCloseTo(r!.ws, 10)
    })
  })

  it('still returns null for a raw spec, so nothing is drawn as corrected', () => {
    const raw = { fit_height_m: 10, bands: [], models: { m: { type: 'raw' } } }
    expect(mosSeries(payload([10]), [10], raw, 'm', 'UTC')).toBeNull()
  })

  it('returns null for a model the spec does not cover', () => {
    expect(mosSeries(payload([10]), [10], SPEC10, 'icon_eu', 'UTC')).toBeNull()
  })
})


describe('needsPreLift', () => {
  it('is false for every shipped Mediterranean spec, which must not change', () => {
    // Those were fitted against a boat's 30 m masthead, so the existing
    // lift-then-correct order is right for them and nothing may shift.
    for (const key of calibratedVenues()) {
      expect(needsPreLift(specFor(key)), key).toBe(false)
    }
  })

  it('is true only when the fit height is BELOW the target', () => {
    expect(needsPreLift({ fit_height_m: 10, target_height_m: 30 })).toBe(true)
    expect(needsPreLift({ fit_height_m: 30, target_height_m: 30 })).toBe(false)
    expect(needsPreLift({ target_height_m: 30 })).toBe(false)
    expect(needsPreLift({})).toBe(false)
  })

  it('does not depend on a boat mast being exactly 30 m', () => {
    // The question is about the SPEC, not about where it is being applied. An
    // earlier version compared the fit height with the mast height and broke
    // every existing path for a 28 or 40 m rig.
    expect(needsPreLift({ fit_height_m: 30, target_height_m: 30 })).toBe(false)
  })
})

describe('the 30 m-space paths refuse a spec that needs reordering', () => {
  const field = {
    labels: ['Sat 14:00'],
    times: ['2026-06-01T14:00:00Z'],
    frames: [{ u: [-5, -5], v: [-5, -5] }],
    header: { nx: 2, ny: 1, lo1: 10.5, la1: 59.4, dx: 0.01, dy: 0.01 },
    maxSpeed: 7.1,
  }

  it('leaves the wind field RAW for a 10 m-fitted spec', () => {
    // Absent beats wrong: this path has no 10 m field to correct before
    // lifting, so a 10 m correction here would ship a wrong intercept.
    const out = applyMosToField(field, SPEC10, 'metno_nordic')
    expect(out).toBe(field)
  })

  it('still corrects the field for a 30 m-fitted spec', () => {
    const out = applyMosToField(field, SPEC30, 'metno_nordic')
    expect(out).not.toBe(field)
    expect(Math.hypot(out.frames[0].u[0], out.frames[0].v[0]))
      .not.toBeCloseTo(Math.hypot(field.frames[0].u[0], field.frames[0].v[0]), 6)
  })
})

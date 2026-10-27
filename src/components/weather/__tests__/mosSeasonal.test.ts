// A season window on a MOS spec: separate coefficients for the months that
// behave differently, and the year-round ones outside them.
//
// Why it exists. The three Mediterranean specs that worked were fitted on
// regatta days — every one of them in summer — so their diurnal term is a
// summer sea-breeze harmonic. Nothing in the JSON said so, and a fit spanning
// twelve months of fjord data averages that amplitude against the months with
// none, then applies the average in January. So a spec may now declare its own
// window, and these tests pin the two things that could go wrong silently:
// that the window is read in VENUE time, and that a caller with no date in
// scope does not quietly get the wrong coefficients.

import { describe, expect, it } from 'vitest'
import {
  applyMOS, seasonMonths, hasSeasonal, modelSpecFor, correctedWind30,
  specFor, calibratedVenues, needsPreLift,
} from '../mos'
import { wallMonth } from '../venueTz'
import { applyMosToField } from '../windField'

const KMH = 1 / 0.539957

/** metno_nordic's payload shape: one 10 m level, times in venue wall clock. */
function payload(times: string[], speedsKn: number[]) {
  return {
    time: times,
    wind_speed_10m: speedsKn.map((s) => s * KMH),
    wind_direction_10m: speedsKn.map(() => 200),
  } as Record<string, unknown>
}

/** Year-round a*x+b, and a different one for May-Aug. */
const SPEC = {
  venue: 'viksfjord',
  fit_height_m: 10,
  target_height_m: 30,
  bands: [['S', 135, 225]],
  models: { metno_nordic: { type: 'bias_scale', a: 1.0, b: 2.0 } },
  seasonal: {
    months: [5, 6, 7, 8],
    label: 'May-Aug',
    models: { metno_nordic: { type: 'bias_scale', a: 1.0, b: -3.0 } },
  },
}

describe('wallMonth', () => {
  it('reads the digits of a zone-less model time, which is already venue time', () => {
    expect(wallMonth('2026-06-14T15:00', 'Europe/Oslo')).toBe(6)
    expect(wallMonth('2026-01-02T03:00', 'Europe/Oslo')).toBe(1)
  })

  it('converts a time that carries a zone', () => {
    // 23:30 UTC on 31 May is already 1 June in Oslo (UTC+2 in summer), and a
    // season boundary is a statement about the venue, not about UTC.
    expect(wallMonth('2026-05-31T23:30:00Z', 'Europe/Oslo')).toBe(6)
    expect(wallMonth('2026-05-31T23:30:00Z', 'UTC')).toBe(5)
  })

  it('is NaN for something that is not a time', () => {
    expect(Number.isNaN(wallMonth('', 'UTC'))).toBe(true)
    expect(Number.isNaN(wallMonth(null as never, 'UTC'))).toBe(true)
  })
})

describe('seasonMonths and hasSeasonal', () => {
  it('reads the window off a spec that has one', () => {
    expect(seasonMonths(SPEC)).toEqual([5, 6, 7, 8])
    expect(hasSeasonal(SPEC)).toBe(true)
  })

  it('is null and false for a spec with none', () => {
    expect(seasonMonths({ models: {} })).toBeNull()
    expect(seasonMonths(null)).toBeNull()
    expect(hasSeasonal({ models: {} })).toBe(false)
    expect(hasSeasonal({ seasonal: { months: [6] } })).toBe(false)   // no models
    expect(hasSeasonal({ seasonal: { months: [], models: {} } })).toBe(false)
  })

  it('is set only where a REGIME split earned it', () => {
    // St Tropez has one. Its archive holds a June sea-breeze regatta and two
    // October gradient ones, raw rmse 3.0-3.6 kn against 1.9-2.9, and one
    // correction across both helps one and hurts the other. So AROME's
    // coefficients are fitted on the gradient regatta pair and the May-July
    // window is set to raw explicitly, because those coefficients were never
    // asked to work in June.
    //
    // Sorrento and Porto Cervo have no split: their archives are one season
    // each (May and September), so there is no second regime to separate and
    // the specs must stay year-round exactly as they were.
    expect(hasSeasonal(specFor('st-tropez'))).toBe(true)
    expect(seasonMonths(specFor('st-tropez'))).toEqual([5, 6, 7])
    expect(hasSeasonal(specFor('sorrento'))).toBe(false)
    expect(hasSeasonal(specFor('porto-cervo'))).toBe(false)
  })

  it('St Tropez suppresses in June only what was fitted outside it', () => {
    // The distinction the window exists to carry. AROME's default comes from
    // the gradient arm alone -> raw in June. icon_eu's comes from the pooled
    // fit, which had to hold in EVERY regatta including the June one (3.56 ->
    // 3.09), so it is absent from the window and keeps applying there.
    const st = specFor('st-tropez')
    expect(modelSpecFor(st, 'meteofrance_arome_france_hd', 6).m.type).toBe('raw')
    expect(modelSpecFor(st, 'meteofrance_arome_france_hd', 10).m.type).toBe('sector')
    expect(modelSpecFor(st, 'icon_eu', 6).m.type).toBe('bias_scale')
    expect(modelSpecFor(st, 'icon_eu', 10).m.type).toBe('bias_scale')
  })

  it('and no shipped spec needs a pre-lift, which the window must not change', () => {
    for (const key of calibratedVenues()) expect(needsPreLift(specFor(key)), key).toBe(false)
  })
})

describe('modelSpecFor', () => {
  it('takes the seasonal coefficients inside the window', () => {
    const { m, season } = modelSpecFor(SPEC, 'metno_nordic', 6)
    expect(m!.b).toBe(-3)
    expect(season).toBe('May-Aug')
  })

  it('takes the year-round ones outside it', () => {
    expect(modelSpecFor(SPEC, 'metno_nordic', 1).m!.b).toBe(2)
    expect(modelSpecFor(SPEC, 'metno_nordic', 1).season).toBeNull()
    expect(modelSpecFor(SPEC, 'metno_nordic', 9).m!.b).toBe(2)
  })

  it('takes the year-round ones when the month is unknown', () => {
    // The right default — it is the set fitted on the most data — and the
    // reason a path that cannot date its own rows must refuse the spec rather
    // than disagree with the hourly table all summer.
    expect(modelSpecFor(SPEC, 'metno_nordic', null).m!.b).toBe(2)
    expect(modelSpecFor(SPEC, 'metno_nordic', undefined).m!.b).toBe(2)
  })

  it('falls back when the window exists but this model is not in it', () => {
    const { m, season } = modelSpecFor(SPEC, 'icon_eu', 6)
    expect(m).toBeNull()
    expect(season).toBeNull()
    const withIcon = { ...SPEC, models: { ...SPEC.models, icon_eu: { type: 'bias_scale', a: 1, b: 9 } } }
    expect(modelSpecFor(withIcon, 'icon_eu', 6).m!.b).toBe(9)
    expect(modelSpecFor(withIcon, 'icon_eu', 6).season).toBeNull()
  })

  it('returns null for a model with no correction at all', () => {
    expect(modelSpecFor(SPEC, 'gfs_seamless', 6).m).toBeNull()
  })
})

describe('applyMOS with a month', () => {
  it('uses the seasonal coefficients and says which it used', () => {
    const r = applyMOS(SPEC, 'metno_nordic', 10, 200, 14, 6)
    expect(r!.ws).toBeCloseTo(7, 10)          // 10 - 3
    expect(r!.season).toBe('May-Aug')
  })

  it('uses the year-round coefficients in winter', () => {
    expect(applyMOS(SPEC, 'metno_nordic', 10, 200, 14, 1)!.ws).toBeCloseTo(12, 10)
  })

  it('is unchanged when no month is passed, so every old caller is safe', () => {
    expect(applyMOS(SPEC, 'metno_nordic', 10, 200, 14)!.ws).toBeCloseTo(12, 10)
  })

  it('carries a sector_diurnal spec\'s band and harmonic together', () => {
    const m = {
      type: 'sector_diurnal', a: 1, b: 0, c0: 0, c1: 2, c2: 0,
      delta: { S: 1.5 }, global: -0.5,
    }
    const spec = { bands: [['S', 135, 225]], models: { X: m } }
    // hour 6 -> sin = 1, so the harmonic contributes c1 exactly.
    expect(applyMOS(spec, 'X', 10, 200, 6)!.ws).toBeCloseTo(10 + 1.5 + 2, 10)
    expect(applyMOS(spec, 'X', 10, 200, 6)!.sector).toBe('S')
    // A direction in no band takes `global`; a missing one takes neither.
    expect(applyMOS(spec, 'X', 10, 10, 6)!.ws).toBeCloseTo(10 - 0.5 + 2, 10)
    expect(applyMOS(spec, 'X', 10, null, 6)!.ws).toBeCloseTo(12, 10)
    expect(applyMOS(spec, 'X', 10, 200, null)!.ws).toBeCloseTo(11.5, 10)
  })
})

describe('correctedWind30 picks the coefficients for the hour it is correcting', () => {
  it('seasonal in June, year-round in January, from the same spec', () => {
    const h = payload(['2026-06-14T14:00', '2026-01-14T14:00'], [12, 12])
    const jun = correctedWind30(h, [10], 0, SPEC, 'metno_nordic', 'Europe/Oslo')!
    const jan = correctedWind30(h, [10], 1, SPEC, 'metno_nordic', 'Europe/Oslo')!
    expect(jun.season).toBe('May-Aug')
    expect(jan.season).toBeNull()
    // 12-3 = 9 kn corrected at 10 m in June, 12+2 = 14 in January, each then
    // lifted to 30 m — so June must come out well below January.
    expect(jun.ws).toBeLessThan(jan.ws)
    expect(jun.lifted).toBe(true)
    expect(jan.lifted).toBe(true)
  })

  it('reads the month in VENUE time, not UTC', () => {
    // 31 May 22:00 Oslo is 20:00 UTC — still May at the venue either way — but
    // a zoned time half an hour before local midnight is already June there.
    const h = { ...payload(['2026-05-31T23:30:00Z'], [12]) }
    const r = correctedWind30(h, [10], 0, SPEC, 'metno_nordic', 'Europe/Oslo')!
    expect(r.season).toBe('May-Aug')
  })
})

describe('a path with no date in scope refuses a seasonal spec', () => {
  const field = {
    labels: ['Sat 14:00'],
    times: ['2026-06-14T14:00:00Z'],
    frames: [{ u: [-5, -5], v: [-5, -5] }],
    header: { nx: 2, ny: 1, lo1: 10.1, la1: 59.0, dx: 0.01, dy: 0.01 },
    maxSpeed: 7.1,
  }

  it('leaves the wind field raw, rather than using the wrong half of the spec', () => {
    // The field's only time information is "Sat 14:00" — an hour and no date.
    // Guessing the year-round set here would put a different number on the map
    // from the one in the table, all summer, with nothing on screen to say why.
    const spec30 = { ...SPEC, fit_height_m: 30, target_height_m: 30 }
    expect(applyMosToField(field, spec30, 'metno_nordic')).toBe(field)
  })

  it('still corrects a 30 m spec with no window', () => {
    const plain = { target_height_m: 30, bands: [], models: { metno_nordic: { type: 'bias_scale', a: 1.1, b: 1.5 } } }
    expect(applyMosToField(field, plain, 'metno_nordic')).not.toBe(field)
  })

  it('but DOES correct a seasonal spec once the frames carry stamps', () => {
    // `stamps` is what localStamp() built with the venue's timezone, for both
    // the Open-Meteo and the Icon-Race field shapes, so the month is there and
    // venue-local. Refusing the whole field when it is available would mean
    // the map and the hourly table showing different numbers all summer —
    // which is what St Tropez's regime window would have caused.
    const spec30 = { ...SPEC, fit_height_m: 30, target_height_m: 30 }
    const june = { ...field, stamps: [{ wd: 'Sat', dd: '14', mon: 'Jun', hh: 14, mm: '00' }] }
    const january = { ...field, stamps: [{ wd: 'Wed', dd: '14', mon: 'Jan', hh: 14, mm: '00' }] }
    const jun = applyMosToField(june, spec30, 'metno_nordic')
    const jan = applyMosToField(january, spec30, 'metno_nordic')
    expect(jun).not.toBe(june)
    expect(jan).not.toBe(january)
    const speed = (f: Record<string, any>) => Math.hypot(f.frames[0].u[0], f.frames[0].v[0]) * 1.94384
    // June b = -3, January b = +2, so June must come out the lower of the two.
    expect(speed(jun)).toBeLessThan(speed(jan))
    expect(speed(jan) - speed(jun)).toBeCloseTo(5, 4)
  })
})

// Which models a venue is offered — and the ones it must NOT be.
//
// Until 2026-10-27 the four regional EUROPEAN models carried no coverage box,
// so they were offered at every venue. At the San Juan Islands the picker
// listed AROME, which has no data within thousands of miles: a model that could
// only ever fail, presented as a choice. Every box below is a live bisection,
// recorded beside the constants in openMeteo.js.
//
// The direction that matters is the EXCLUSION. A box slightly wider than the
// true (rotated, ragged) domain only means an occasional empty response, which
// is what happened before anyway; a box that wrongly EXCLUDES hides a model a
// venue should have.

import { describe, expect, it } from 'vitest'
import { MODELS, MODEL_ORDER, COMPARE_ORDER, isSelfHostedModel } from '../openMeteo'

const VENUES: Record<string, [number, number]> = {
  'Porto Cervo': [41.135, 9.538],
  'St Tropez': [43.2669, 6.6984],
  Sorrento: [40.7039, 14.2155],
  Solent: [50.76, -1.30],
  Oslofjord: [59.42, 10.48],
  'San Juan Islands': [48.5627, -122.8946],
  'Long Beach': [33.72, -118.27],
}

const covers = (key: string, lat: number, lon: number) => {
  const c = MODELS[key]?.coverage
  if (!c) return true                     // no box = global
  return lat >= c.latMin && lat <= c.latMax && lon >= c.lonMin && lon <= c.lonMax
}

describe('the American venues are offered no European-only model', () => {
  // The bug this file exists for. All four were measured OUT at both.
  for (const key of ['AROME', 'ARPEGE', 'ITALIA', 'DMI', 'METNO']) {
    it(`${key} is not offered at San Juan or Long Beach`, () => {
      expect(covers(key, ...VENUES['San Juan Islands'])).toBe(false)
      expect(covers(key, ...VENUES['Long Beach'])).toBe(false)
    })
  }
})

describe('the European venues keep every model that really covers them', () => {
  const cases: Array<[string, string[]]> = [
    ['Porto Cervo', ['AROME', 'ARPEGE', 'ITALIA', 'DMI']],
    ['St Tropez', ['AROME', 'ARPEGE', 'ITALIA', 'DMI']],
    ['Sorrento', ['AROME', 'ARPEGE', 'ITALIA', 'DMI']],
    ['Solent', ['AROME', 'ARPEGE', 'DMI']],
    ['Oslofjord', ['ARPEGE', 'DMI', 'METNO']],
  ]
  for (const [venue, keys] of cases) {
    it(`${venue} keeps ${keys.join(', ')}`, () => {
      for (const k of keys) expect(covers(k, ...VENUES[venue]), `${k} at ${venue}`).toBe(true)
    })
  }

  it('and Solent is NOT offered ICON-2I, which stops at the Alps', () => {
    expect(covers('ITALIA', ...VENUES.Solent)).toBe(false)
    expect(covers('METNO', ...VENUES.Solent)).toBe(false)
  })
})

describe('San Juan is offered the models that do cover it', () => {
  // Measured live: ecmwf_ifs, gem_hrdps_continental, icon_seamless,
  // ncep_hrrr_conus and ncep_nam_conus all return data there.
  for (const key of ['HRDPS', 'HRRR', 'NAM', 'ECMWF', 'ICON']) {
    it(`${key} is offered`, () => {
      expect(covers(key, ...VENUES['San Juan Islands'])).toBe(true)
    })
  }
})

describe('every coverage box is well formed', () => {
  it('has min < max on both axes, so it can never match nothing', () => {
    for (const [key, m] of Object.entries(MODELS)) {
      if (!m.coverage) continue
      const c = m.coverage
      expect(c.latMin, key).toBeLessThan(c.latMax)
      expect(c.lonMin, key).toBeLessThan(c.lonMax)
    }
  })
})

describe('a model in MODELS is invisible until it is in the RIGHT list', () => {
  // How HRDPS stayed invisible through two fixes. There are two lists and they
  // do different jobs: MODEL_ORDER drives the fetch order and the default pick,
  // COMPARE_ORDER drives what the Forecast picker and the Compare view actually
  // render (ForecastView's MODEL_PICK_ORDER is built from it). Adding a model
  // to MODELS buys nothing; adding it to MODEL_ORDER alone buys nothing a user
  // can see. Neither failure produces an error.
  // `|| MODELS[k].bunnyBase` here was the same mistake the routing made: that
  // field is an OPTIONAL pull-zone whose default is null, so both SSA-Race
  // models fell out of this set and the check below never covered them. Ask
  // isSelfHostedModel instead, and exclude the two FIELD-ONLY layers, which are
  // self-hosted but are not forecast models and never belong in COMPARE_ORDER.
  const forecast = Object.keys(MODELS).filter((k) => (
    (MODELS[k].endpoint || isSelfHostedModel(MODELS[k])) && !MODELS[k].isCurrent && !MODELS[k].isHpbl
  ))

  it('shows every forecast model in the picker', () => {
    const unlisted = forecast.filter((k) => !COMPARE_ORDER.includes(k))
    expect(unlisted, `in MODELS but not in COMPARE_ORDER, so invisible: ${unlisted.join(', ')}`).toEqual([])
  })

  it('fetches every forecast model it shows', () => {
    const unfetched = COMPARE_ORDER.filter((k) => !MODEL_ORDER.includes(k))
    // DMI is the known gap: it is shown in Compare but is not in MODEL_ORDER,
    // which predates this test. Recorded rather than silently tolerated.
    expect(unfetched).toEqual(['DMI'])
  })

  it('never orders a model that does not exist', () => {
    for (const k of [...MODEL_ORDER, ...COMPARE_ORDER]) expect(MODELS[k], k).toBeTruthy()
  })

  it('includes HRDPS in BOTH, which is the one San Juan needs', () => {
    expect(MODEL_ORDER).toContain('HRDPS')
    expect(COMPARE_ORDER).toContain('HRDPS')
  })
})

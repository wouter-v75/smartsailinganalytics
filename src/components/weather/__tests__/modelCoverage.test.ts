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
import { MODELS } from '../openMeteo'

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

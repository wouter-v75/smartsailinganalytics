import { describe, it, expect } from 'vitest'
import { MODELS, MODEL_ORDER, COMPARE_ORDER, modelCoversPoint, forecastDaysFor } from '../openMeteo'

// MET Norway "MET Nordic" — the forecast behind yr.no. Coverage was established
// by probing the live API on 2026-09-11, not taken from documentation.
describe('MET Norway (METNO) coverage', () => {
  const inside: Array<[string, number, number]> = [
    ['Oslofjord', 59.9, 10.7],
    ['Færder/Hankø', 59.0, 10.3],
    ['Bergen', 60.4, 5.3],
    ['Trondheim', 63.4, 10.4],
    ['Tromsø', 69.6, 18.9],
    ['Nordkapp', 71.2, 25.8],
    ['Øresund', 55.7, 12.6],
  ]
  for (const [name, lat, lon] of inside) {
    it(`is fetched at ${name}`, () => expect(modelCoversPoint('METNO', lat, lon)).toBe(true))
  }

  // Outside its domain the API answers 200 with `"latitude":nan` — not JSON —
  // so the model must never be requested at the venues this team usually sails.
  const outside: Array<[string, number, number]> = [
    ['Porto Cervo', 41.2, 9.5],
    ['La Ciotat', 43.17, 5.61],
    ['Solent', 50.76, -1.3],
  ]
  for (const [name, lat, lon] of outside) {
    it(`is NOT fetched at ${name}`, () => expect(modelCoversPoint('METNO', lat, lon)).toBe(false))
  }

  it('refuses a missing position rather than guessing', () => {
    expect(modelCoversPoint('METNO', null as unknown as number, 10)).toBe(false)
  })
})

describe('METNO configuration', () => {
  const m = MODELS.METNO

  it('asks Open-Meteo for the Nordic model, and reads run times from the _pp store', () => {
    // metno_nordic/static/meta.json is HTTP 500; the run times are under _pp.
    expect(m.modelParam).toBe('metno_nordic')
    expect(m.metaModel).toBe('metno_nordic_pp')
  })

  it('requests only the 10 m wind it actually serves', () => {
    // 80/100/120 m and boundary-layer height come back all-null; asking for them
    // would make empty columns look like data.
    expect(m.heights).toEqual([10])
  })

  it('samples its wind field on a 12 x 12 grid, not 16 x 16', () => {
    // Open-Meteo bills a field per LOCATION against 600/min per IP. In Norway this
    // is the auto-picked model, so its field is fetched on every point-1 change:
    // 256 locations was ~43% of a minute's budget in one request; 144 is ~24%.
    expect(m.fieldGrid).toBe(12)
  })

  it('covers its ~58 h of data', () => {
    expect(forecastDaysFor(m)).toBe(3)
  })

  it('is switched on — ALL_MODELS is built from COMPARE_ORDER', () => {
    expect(COMPARE_ORDER).toContain('METNO')
  })

  it('beats ECMWF for the auto-pick, so Norway shows the 1 km model first', () => {
    expect(MODEL_ORDER.indexOf('METNO')).toBeGreaterThan(-1)
    expect(MODEL_ORDER.indexOf('METNO')).toBeLessThan(MODEL_ORDER.indexOf('ECMWF'))
  })
})

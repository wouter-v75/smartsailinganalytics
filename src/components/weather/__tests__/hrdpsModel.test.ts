// HRDPS, and the one property that makes it the right model for the San Juans.
import { describe, expect, it } from 'vitest'
import { MODELS } from '../openMeteo'

const inBox = (c: { latMin: number; latMax: number; lonMin: number; lonMax: number }, lat: number, lon: number) =>
  lat >= c.latMin && lat <= c.latMax && lon >= c.lonMin && lon <= c.lonMax

describe('the HRDPS model entry', () => {
  const m = MODELS.HRDPS

  it('exists, on the GEM endpoint, as the continental 2.5 km member', () => {
    expect(m).toBeTruthy()
    expect(m.endpoint).toBe('https://api.open-meteo.com/v1/gem')
    expect(m.modelParam).toBe('gem_hrdps_continental')
  })

  it('BRACKETS a 30 m masthead, which nothing else here does', () => {
    // wind30() fits a power law to whatever levels it is handed. With 10/80 the
    // 30 m value is an extrapolation below the lowest pair's span; with a 40 m
    // level it is an interpolation. That is the whole reason for adding it.
    expect(m.heights).toEqual([10, 40, 80, 120])
    const below = m.heights.filter((h) => h <= 30)
    const above = m.heights.filter((h) => h >= 30)
    expect(below.length).toBeGreaterThan(0)
    expect(above.length).toBeGreaterThan(0)
    expect(Math.min(...above)).toBe(40)
  })

  it('covers the San Juans and Seattle, and nothing we sail in Europe', () => {
    const c = m.coverage
    expect(inBox(c, 48.5627, -122.8946)).toBe(true)    // San Juan Islands
    expect(inBox(c, 47.60, -122.33)).toBe(true)        // Seattle
    expect(inBox(c, 41.135, 9.538)).toBe(false)        // Porto Cervo
    expect(inBox(c, 43.2669, 6.6984)).toBe(false)      // St Tropez
    expect(inBox(c, 59.03, 10.15)).toBe(false)         // Viksfjord
    expect(inBox(c, 33.72, -118.27)).toBe(false)       // Long Beach: measured OUT
  })

  it('leaves the venue well clear of the domain edge', () => {
    // The western edge was bisected to between -138 and -134 at lat 49, i.e.
    // some 700 nm from the islands — so the venue is nowhere near the
    // relaxation zone, where a limited-area model is least trustworthy.
    expect(m.coverage.lonMin).toBeLessThanOrEqual(-134)
    expect(-122.8946 - m.coverage.lonMin).toBeGreaterThan(10)
  })

  it('claims no freshness feed, because there is none', () => {
    // api.open-meteo.com/data/gem_hrdps_continental/static/meta.json is 404.
    expect(m.metaModel).toBeUndefined()
  })
})

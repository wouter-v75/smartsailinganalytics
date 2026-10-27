import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain JS module, no types
import { MODELS } from '../openMeteo'

// The pin supplied for the "Seattle" domain. It is actually in the San Juan
// Islands, ~120 km north of Seattle city — the name is the folder, not the place.
const PIN = { lat: 48.5627, lon: -122.8946 }

// How the app resolves a clicked point to a published venue box
// (openMeteo.js iconRaceGridForPoint / fetchIconRaceField use exactly this).
const venueAt = (modelKey: string, lat: number, lon: number) =>
  (MODELS[modelKey].venues || []).find(
    (v: { clat: number; clon: number; half: number }) =>
      Math.abs(lat - v.clat) <= v.half && Math.abs(lon - v.clon) <= v.half,
  )

describe('the San Juan Islands venue', () => {
  it('is registered on BOTH resolutions, pointing at its own domains', () => {
    expect(venueAt('ICONRACE', PIN.lat, PIN.lon)).toMatchObject({ name: 'san_juan_islands', domain: 'san_juan_islands_2km' })
    expect(venueAt('ICONRACE_1KM', PIN.lat, PIN.lon)).toMatchObject({ name: 'san_juan_islands', domain: 'san_juan_islands_1km' })
  })

  it('matches the half-width the box publishes in venues.csv', () => {
    // A mismatch here is silent: the app would request a grid box the publisher
    // never wrote, and the points would grey out with nothing to explain it.
    // Widened 2026-10-27 from 0.30 at both resolutions, and they are no longer
    // equal, because the two are limited by different things:
    //   2 km  0.55 — a product-size choice. Its grid reaches -124.094, so the
    //                box could go wider still; 0.55 reaches Victoria and keeps
    //                the payload near what solent_1km already ships.
    //   1 km  0.35 — the GRID's own limit. That grid stops at -123.350, so once
    //                ~10 cells of relaxation zone are kept clear there is
    //                nothing further west to publish. The revised Zonda request
    //                (ZONDA_ISSUE_..._WEST.md) is what lifts it.
    expect(venueAt('ICONRACE', PIN.lat, PIN.lon).half).toBe(0.55)
    expect(venueAt('ICONRACE_1KM', PIN.lat, PIN.lon).half).toBe(0.35)
  })

  it('now reaches Victoria on the 2 km, and still cannot on the 1 km', () => {
    // The distinction worth keeping: Victoria is outside the 1 km COMPUTED
    // GRID, not merely outside its published box, so no amount of widening
    // reaches it until the new grid lands.
    const VICTORIA = { lat: 48.42, lon: -123.37 }
    expect(venueAt('ICONRACE', VICTORIA.lat, VICTORIA.lon)?.name).toBe('san_juan_islands')
    expect(venueAt('ICONRACE_1KM', VICTORIA.lat, VICTORIA.lon)).toBeUndefined()
  })

  it('does not collide with a European venue', () => {
    // W longitude is negative; a dropped sign would land this on the Solent.
    expect(venueAt('ICONRACE', 50.76, -1.30).name).toBe('solent')
    expect(venueAt('ICONRACE', PIN.lat, -PIN.lon)).toBeUndefined()
  })

  it('does not claim to cover Seattle city, which is outside the model domain', () => {
    // The 2 km domain's southern edge is 47.6627N and the city is at 47.6062N —
    // 6 km outside, before the relaxation zone is even considered. The venue box
    // must not pretend otherwise, or a click there would fetch a grid that has no
    // data for it.
    expect(venueAt('ICONRACE', 47.6062, -122.3321)).toBeUndefined()
  })
})

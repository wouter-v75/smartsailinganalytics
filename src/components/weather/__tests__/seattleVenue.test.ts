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

describe('the Seattle venue', () => {
  it('is registered on BOTH resolutions, pointing at its own domains', () => {
    expect(venueAt('ICONRACE', PIN.lat, PIN.lon)).toMatchObject({ name: 'seattle', domain: 'seattle_2km' })
    expect(venueAt('ICONRACE_1KM', PIN.lat, PIN.lon)).toMatchObject({ name: 'seattle', domain: 'seattle_1km' })
  })

  it('matches the half-width the box publishes in venues.csv', () => {
    // A mismatch here is silent: the app would request a grid box the publisher
    // never wrote, and the points would grey out with nothing to explain it.
    for (const k of ['ICONRACE', 'ICONRACE_1KM']) {
      expect(venueAt(k, PIN.lat, PIN.lon).half).toBe(0.30)
    }
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

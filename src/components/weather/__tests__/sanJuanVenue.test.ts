import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain JS module, no types
import { MODELS, inVenueBox, venueHalf } from '../openMeteo'

// The pin supplied for the "Seattle" domain. It is actually in the San Juan
// Islands, ~120 km north of Seattle city — the name is the folder, not the place.
const PIN = { lat: 48.5627, lon: -122.8946 }

// The four edges Wouter pinned on 2026-10-27. These ARE the 1 km published box:
// the grid is these plus 10 km of relaxation zone on each side.
const PINNED = { south: 48.372069, west: -123.305996, east: -122.595220, north: 48.780862 }

// Resolve a clicked point to a published venue box with the APP'S OWN predicate,
// not a copy of it. A local re-implementation is how the square-box assumption
// survived here: it kept passing while the real resolver changed underneath.
const venueAt = (modelKey: string, lat: number, lon: number) =>
  (MODELS[modelKey].venues || []).find((v: unknown) => inVenueBox(v, lat, lon))

describe('the San Juan Islands venue', () => {
  it('is registered on BOTH resolutions, pointing at its own domains', () => {
    expect(venueAt('ICONRACE', PIN.lat, PIN.lon)).toMatchObject({ name: 'san_juan_islands', domain: 'san_juan_islands_2km' })
    expect(venueAt('ICONRACE_1KM', PIN.lat, PIN.lon)).toMatchObject({ name: 'san_juan_islands', domain: 'san_juan_islands_1km' })
  })

  it('publishes the 1 km box as exactly the pinned edges', () => {
    // A mismatch here is silent: the app would request a grid box the publisher
    // never wrote, and the points would grey out with nothing to explain it.
    // The box is RECTANGULAR because the domain is — 45.5 km of latitude by
    // 52.3 km of longitude. One square `half` cannot express that: the larger
    // value pushes the N/S edges outside the computed grid, the smaller cuts
    // Haro Strait off the west end.
    const v = venueAt('ICONRACE_1KM', PIN.lat, PIN.lon)
    const h = venueHalf(v)
    expect(v.clat - h.lat).toBeCloseTo(PINNED.south, 3)
    expect(v.clat + h.lat).toBeCloseTo(PINNED.north, 3)
    expect(v.clon - h.lon).toBeCloseTo(PINNED.west, 3)
    expect(v.clon + h.lon).toBeCloseTo(PINNED.east, 3)
    // and it really is not square
    expect(h.lat).not.toBe(h.lon)
  })

  it('keeps every published 1 km cell clear of the relaxation zone', () => {
    // The grid is the pins + 10 km, so the box's clearance to the grid edge is
    // 10 km on all four sides BY CONSTRUCTION. If this drifts, the box has
    // started publishing cells that are being blended back to the parent.
    const GRID = { south: 48.2822, north: 48.8707, west: -123.4418, east: -122.4594 }
    const KM_LAT = 111.32
    const KM_LON = 111.32 * Math.cos((48.58 * Math.PI) / 180)
    const v = venueAt('ICONRACE_1KM', PIN.lat, PIN.lon)
    const h = venueHalf(v)
    expect((v.clat - h.lat - GRID.south) * KM_LAT).toBeGreaterThanOrEqual(9.9)
    expect((GRID.north - (v.clat + h.lat)) * KM_LAT).toBeGreaterThanOrEqual(9.9)
    expect((v.clon - h.lon - GRID.west) * KM_LON).toBeGreaterThanOrEqual(9.9)
    expect((GRID.east - (v.clon + h.lon)) * KM_LON).toBeGreaterThanOrEqual(9.9)
  })

  it('2 km stays square, and concentric with the nest', () => {
    const two = venueAt('ICONRACE', PIN.lat, PIN.lon)
    const one = venueAt('ICONRACE_1KM', PIN.lat, PIN.lon)
    expect(two.half).toBe(0.55)
    expect(venueHalf(two)).toEqual({ lat: 0.55, lon: 0.55 })
    expect(two.clat).toBeCloseTo(one.clat, 4)
    expect(two.clon).toBeCloseTo(one.clon, 4)
  })

  it('reaches Victoria on the 2 km, and still not on the 1 km', () => {
    // Victoria (-123.37) is now INSIDE the 1 km computed grid (-123.4418) but
    // only 5 km in, i.e. within the relaxation zone, so the box still stops
    // short of it. The distinction worth keeping: before the regrid it was
    // outside the grid altogether, and no widening could have reached it.
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
    // The city is at 47.6062N, outside the 2 km published box's southern edge
    // before the relaxation zone is even considered. The venue box must not
    // pretend otherwise, or a click there would fetch a grid with no data for it.
    expect(venueAt('ICONRACE', 47.6062, -122.3321)).toBeUndefined()
  })

  it('leaves every square-box venue resolving exactly as before', () => {
    // halfLat/halfLon are optional; a venue that declares neither must behave
    // identically to the old Math.abs(...) <= v.half test.
    for (const key of ['ICONRACE', 'ICONRACE_1KM']) {
      for (const v of MODELS[key].venues) {
        if (v.halfLat != null || v.halfLon != null) continue
        expect(venueHalf(v)).toEqual({ lat: v.half, lon: v.half })
        expect(inVenueBox(v, v.clat + v.half * 0.999, v.clon - v.half * 0.999)).toBe(true)
        expect(inVenueBox(v, v.clat + v.half * 1.001, v.clon)).toBe(false)
        expect(inVenueBox(v, v.clat, v.clon - v.half * 1.001)).toBe(false)
      }
    }
  })
})

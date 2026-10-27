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

  it('keeps the published 1 km box inside the generated grid, with the design buffer', () => {
    // NOMINAL KILOMETRES, NOT CELL ROWS -- and the difference is the whole
    // lesson here. This asserts only that the box sits inside the grid Zonda
    // actually produced with the ~10 km buffer it was asked for. It does NOT
    // assert the box is clear of ICON's lateral relaxation zone, which is
    // counted in refin_c_ctrl ROWS: on an R19B08 grid the row-to-row spacing in
    // the row-normal direction is ~1.2-1.4 km, and a corner is the worst case
    // on two axes at once, so this 11.8 km buys only SEVEN rows. An earlier
    // version of this test asserted the same kilometres under the name
    // "clear of the relaxation zone" and would have passed with the corners at
    // full nudging strength -- which is exactly what the OLD round grid had.
    // The authoritative check reads the grid file and cannot run here:
    //   docker run --rm -v /opt/regatta-nwp:/work -w /work icon-nwp:riviera-opt \
    //       python3 -I scripts/nudge_audit.py
    // Measured 27 Oct 2026 on the installed grid: worst corner refin_c_ctrl = 7,
    // nudging coefficient 0.138 of 0.375 (37% of boundary strength), 48% of the
    // published box inside rows 1..12. For comparison solent_1km and
    // porto_cervo_1km sit at refin_c_ctrl 8 (22%), and the superseded round San
    // Juan grid sat at 4 -- inside the PRESCRIBED zone, i.e. the 2 km parent
    // verbatim, published as 1 km output.
    const GRID = { south: 48.2599, north: 48.8929, west: -123.4664, east: -122.4339 }
    const KM_LAT = 111.32
    const KM_LON = 111.32 * Math.cos((48.58 * Math.PI) / 180)
    const v = venueAt('ICONRACE_1KM', PIN.lat, PIN.lon)
    const h = venueHalf(v)
    expect((v.clat - h.lat - GRID.south) * KM_LAT).toBeGreaterThanOrEqual(9.9)
    expect((GRID.north - (v.clat + h.lat)) * KM_LAT).toBeGreaterThanOrEqual(9.9)
    expect((v.clon - h.lon - GRID.west) * KM_LON).toBeGreaterThanOrEqual(9.9)
    expect((GRID.east - (v.clon + h.lon)) * KM_LON).toBeGreaterThanOrEqual(9.9)
  })

  it('stays inside the 2 km parent\'s own free-running interior', () => {
    // The nest is fed from the parent's solution, so what the 1 km grid needs is
    // not room inside the parent's GRID but room inside the part of the parent
    // that is actually free-running -- outside its own nudged rows 1..12.
    // Measured on the box 27 Oct 2026 (scripts/nudge_audit.py): the 2 km free
    // interior is lon -123.5915..-122.1928, lat 47.9441..49.1820, and the 1 km
    // grid including its OWN boundary rows is lon -123.4664..-122.4339,
    // lat 48.2599..48.8929 -- inside it by 9.2 km in the west, its tightest
    // side. That measurement, not the grid extents, is why the 2 km parent
    // needed no regrid when the nest moved.
    const FREE_2KM = { south: 47.9441, north: 49.182, west: -123.5915, east: -122.1928 }
    const GRID_1KM = { south: 48.2599, north: 48.8929, west: -123.4664, east: -122.4339 }
    expect(GRID_1KM.south).toBeGreaterThan(FREE_2KM.south)
    expect(GRID_1KM.north).toBeLessThan(FREE_2KM.north)
    expect(GRID_1KM.west).toBeGreaterThan(FREE_2KM.west)
    expect(GRID_1KM.east).toBeLessThan(FREE_2KM.east)
    // and the published box is inside the 1 km grid it is cut from
    const v = venueAt('ICONRACE_1KM', PIN.lat, PIN.lon)
    const h = venueHalf(v)
    expect(v.clon - h.lon).toBeGreaterThan(GRID_1KM.west)
    expect(v.clon + h.lon).toBeLessThan(GRID_1KM.east)
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

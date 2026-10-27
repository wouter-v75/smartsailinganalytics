// The current FIELD: turning a curvilinear NEMO window into the regular grid
// the map player wants.
//
// The player's contract is the Channel's AMM15 field.json —
// {header:{nx,ny,lo1,la1,dx,dy}, frames:[{u,v}]} with la1 the NORTH edge and dy
// stepping south. Getting that corner convention wrong flips the field
// vertically and nothing would complain, so it is pinned here.

import { describe, expect, it } from 'vitest'
import {
  fieldHeaderFor, indexWindow, fieldWindowUrl, fieldCurrentsUrl, buildFrames, NY, NX,
} from '../salishSeaCurrents'

const VENUE = { lat: 48.5627, lon: -122.8946 }

describe('fieldHeaderFor', () => {
  const h = fieldHeaderFor(VENUE.lat, VENUE.lon, 0.30, 0.40, 0.01)

  it('puts la1 at the NORTH edge, with dy stepping south', () => {
    expect(h.la1).toBeCloseTo(VENUE.lat + 0.30, 10)
    const south = h.la1 - h.dy * (h.ny - 1)
    expect(south).toBeCloseTo(VENUE.lat - 0.30, 8)
  })

  it('puts lo1 at the WEST edge, with dx stepping east', () => {
    expect(h.lo1).toBeCloseTo(VENUE.lon - 0.40, 10)
    expect(h.lo1 + h.dx * (h.nx - 1)).toBeCloseTo(VENUE.lon + 0.40, 8)
  })

  it('sizes the grid from the box and the resolution', () => {
    expect(h.nx).toBe(81)   // 0.80 / 0.01 + 1
    expect(h.ny).toBe(61)   // 0.60 / 0.01 + 1
  })
})

describe('indexWindow', () => {
  it('covers all four corners of the header, with a margin', () => {
    const h = fieldHeaderFor(VENUE.lat, VENUE.lon, 0.30, 0.40, 0.01)
    const w = indexWindow(h, 10)
    expect(w.y0).toBeLessThan(w.y1)
    expect(w.x0).toBeLessThan(w.x1)
    // The venue's own cell (294,285) must be comfortably inside.
    expect(w.y0).toBeLessThan(294)
    expect(w.y1).toBeGreaterThan(294)
    expect(w.x0).toBeLessThan(285)
    expect(w.x1).toBeGreaterThan(285)
  })

  it('clamps to the grid rather than asking for an index off the end', () => {
    const corner = fieldHeaderFor(51.0, -126.3, 0.3, 0.4, 0.01)
    const w = indexWindow(corner, 10)
    expect(w.y0).toBeGreaterThanOrEqual(0)
    expect(w.x0).toBeGreaterThanOrEqual(0)
    expect(w.y1).toBeLessThanOrEqual(NY - 1)
    expect(w.x1).toBeLessThanOrEqual(NX - 1)
  })
})

describe('the field URLs', () => {
  const w = { y0: 250, y1: 330, x0: 250, x1: 330 }

  it('stride the index window and encode the brackets', () => {
    const u = fieldWindowUrl(w, 2)
    expect(u).toContain('%5B250:2:330%5D%5B250:2:330%5D')
    expect(u).toContain('latitude')
    expect(u).toContain('longitude')
    expect(u).not.toContain('[')
  })

  it('constrain the currents by TIME, not by index', () => {
    // griddap takes a time value in parentheses; using an index would depend on
    // where the rolling window happens to start, which moves every hour.
    const u = fieldCurrentsUrl(w, 2, '2026-10-27T11:00:00Z', '2026-10-27T23:00:00Z')
    expect(u).toContain('%5B(2026-10-27T11:00:00Z):(2026-10-27T23:00:00Z)%5D')
    expect(u).toContain('VelEast5')
    expect(u).toContain('VelNorth5')
  })
})

describe('buildFrames', () => {
  // Four cells at ~500 m, which is SalishSeaCast's real spacing. The earlier
  // version of this fixture put them 0.10 deg (11 km) apart, which made the
  // snap-radius behaviour untestable: at that spacing every target is beyond
  // the radius and nothing ever matches.
  const geo = [
    [10, 20, 48.600, -122.950], [10, 21, 48.600, -122.945],
    [11, 20, 48.595, -122.950], [11, 21, 48.595, -122.945],
  ]
  const h = { nx: 2, ny: 2, lo1: -122.950, la1: 48.600, dx: 0.005, dy: 0.005 }

  it('maps each target to its nearest cell, north-west first', () => {
    const cur = [
      ['2026-10-27T00:30:00Z', 10, 20, 1.0, 0.0],
      ['2026-10-27T00:30:00Z', 10, 21, 2.0, 0.0],
      ['2026-10-27T00:30:00Z', 11, 20, 3.0, 0.0],
      ['2026-10-27T00:30:00Z', 11, 21, 4.0, 0.0],
    ]
    const { times, frames } = buildFrames(geo as never, cur as never, h)
    expect(times).toEqual(['2026-10-27T00:30:00Z'])
    // index 0 is the NW corner, then east, then the next row south
    expect(frames[0].u).toEqual([1, 2, 3, 4])
  })

  it('leaves a target with no water cell at zero, which draws as no current', () => {
    const cur = [['2026-10-27T00:30:00Z', 10, 20, null, null],
      ['2026-10-27T00:30:00Z', 10, 21, null, null],
      ['2026-10-27T00:30:00Z', 11, 20, null, null],
      ['2026-10-27T00:30:00Z', 11, 21, null, null]]
    const { frames } = buildFrames(geo as never, cur as never, h)
    expect(frames[0].u).toEqual([0, 0, 0, 0])
    expect(frames[0].v).toEqual([0, 0, 0, 0])
  })

  it('skips a MASKED cell and takes the nearest one that has data', () => {
    // The mask disagreement again: the nearest cell to the NW target is (10,20)
    // and it is masked this hour, so the value must come from a neighbour
    // rather than from a zero.
    const cur = [
      ['2026-10-27T00:30:00Z', 10, 20, null, null],
      ['2026-10-27T00:30:00Z', 10, 21, 2.0, 0.0],
      ['2026-10-27T00:30:00Z', 11, 20, 3.0, 0.0],
      ['2026-10-27T00:30:00Z', 11, 21, 4.0, 0.0],
    ]
    const { frames } = buildFrames(geo as never, cur as never, h)
    expect(frames[0].u[0]).not.toBe(0)
    expect([2, 3]).toContain(frames[0].u[0])
  })

  it('will NOT reach across land for a value — the snap radius is the point', () => {
    // Before the radius existed every one of 4,941 targets came back non-zero
    // on a live run, because "nearest cell with data" searched the whole
    // window: a point in the middle of Orcas Island was painted with the
    // current of the nearest channel. A target 20 km from any water stays 0.
    const far = { nx: 1, ny: 1, lo1: -122.700, la1: 48.600, dx: 0.005, dy: 0.005 }
    const cur = [['2026-10-27T00:30:00Z', 10, 20, 1.0, 0.0]]
    const { frames } = buildFrames(geo as never, cur as never, far)
    expect(frames[0].u).toEqual([0])
  })

  it('keeps one frame per time, in the order they arrive', () => {
    const cur = [
      ['2026-10-27T00:30:00Z', 10, 20, 1.0, 0.0],
      ['2026-10-27T01:30:00Z', 10, 20, 5.0, 0.0],
      ['2026-10-27T02:30:00Z', 10, 20, 9.0, 0.0],
    ]
    const { times, frames } = buildFrames(geo as never, cur as never, h)
    expect(times).toHaveLength(3)
    expect(frames).toHaveLength(3)
    expect(frames.map((f) => f.u[0])).toEqual([1, 5, 9])
  })

  it('carries east/north through as u/v in m/s, unconverted', () => {
    // The player's ramp does the knots conversion (MS_TO_KN); converting here
    // too would double it and paint every gate red.
    const cur = [['2026-10-27T00:30:00Z', 10, 20, 1.5, -2.5]]
    const { frames } = buildFrames(geo as never, cur as never, h)
    expect(frames[0].u[0]).toBe(1.5)
    expect(frames[0].v[0]).toBe(-2.5)
  })
})

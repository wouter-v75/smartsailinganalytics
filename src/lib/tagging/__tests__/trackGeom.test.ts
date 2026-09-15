import { describe, it, expect } from 'vitest'
import {
  geoRows, thin, projectTrack, nearestPoint, pointAtUtc, rowsBetween,
} from '../trackGeom'

const T = (s: number) => Date.parse('2026-09-11T11:00:00Z') + s * 1000

// A square course off Palma, walked anticlockwise.
const square = [
  { utc: T(0), lat: 39.50, lon: 2.60 },
  { utc: T(60), lat: 39.52, lon: 2.60 },
  { utc: T(120), lat: 39.52, lon: 2.63 },
  { utc: T(180), lat: 39.50, lon: 2.63 },
]

describe('geoRows', () => {
  it('drops samples with no fix and sorts by time', () => {
    const out = geoRows([
      { utc: T(60), lat: 39.5, lon: 2.6 },
      { utc: T(0), lat: 39.5, lon: 2.6 },
      { utc: T(30), lat: null, lon: 2.6 },
      { utc: T(40), lat: 39.5, lon: undefined },
    ])
    expect(out.map((r) => r.utc)).toEqual([T(0), T(60)])
  })

  it('drops 0,0 — a GPS with no fix, not a position in the Gulf of Guinea', () => {
    const out = geoRows([
      { utc: T(0), lat: 0, lon: 0 },
      { utc: T(1), lat: 39.5, lon: 2.6 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].lat).toBe(39.5)
  })
})

describe('thin', () => {
  it('leaves a short track alone', () => {
    expect(thin(square, 1200)).toHaveLength(4)
  })

  it('keeps the first and the last sample', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ utc: T(i), lat: 39.5, lon: 2.6 }))
    const out = thin(rows, 100)
    expect(out.length).toBeLessThanOrEqual(102)
    expect(out[0]).toBe(rows[0])
    expect(out[out.length - 1]).toBe(rows[rows.length - 1])
  })
})

describe('projectTrack', () => {
  it('fits inside the box, padding included', () => {
    const { points } = projectTrack(square, { width: 300, height: 200, pad: 10 })
    expect(points).toHaveLength(4)
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(10 - 1e-6)
      expect(p.x).toBeLessThanOrEqual(290 + 1e-6)
      expect(p.y).toBeGreaterThanOrEqual(10 - 1e-6)
      expect(p.y).toBeLessThanOrEqual(190 + 1e-6)
    }
  })

  it('puts north at the top', () => {
    const { points } = projectTrack(square, { width: 300, height: 200 })
    // Sample 1 is the northern corner of the western side; sample 0 the southern.
    expect(points[1].y).toBeLessThan(points[0].y)
  })

  it('keeps the aspect ratio rather than stretching to fill', () => {
    // 0.02° of latitude is ~2.2 km; 0.03° of longitude at 39.5°N is ~2.6 km.
    // Drawn into a 300×200 box, the shape must stay roughly 1.17:1 — not 1.5:1.
    const { points } = projectTrack(square, { width: 300, height: 200, pad: 0 })
    const w = Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x))
    const h = Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y))
    expect(w / h).toBeCloseTo(1.17, 1)
  })

  it('survives a boat that never moved', () => {
    const still = [
      { utc: T(0), lat: 39.5, lon: 2.6 },
      { utc: T(60), lat: 39.5, lon: 2.6 },
    ]
    const { points, path, metresPerPx } = projectTrack(still, { width: 300, height: 200 })
    expect(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
    expect(path).not.toContain('NaN')
    expect(metresPerPx).toBeNull()
  })

  it('returns nothing to draw for a day with no positions', () => {
    expect(projectTrack([], { width: 300, height: 200 })).toEqual({
      points: [], path: '', metresPerPx: null,
    })
  })
})

describe('nearestPoint', () => {
  it('finds the sample under the thumb and reports how far off it was', () => {
    const { points } = projectTrack(square, { width: 300, height: 200 })
    const target = points[2]
    const hit = nearestPoint(points, target.x + 3, target.y - 4)
    expect(hit?.index).toBe(2)
    expect(hit?.distPx).toBeCloseTo(5, 5)
  })

  it('returns null for an empty track', () => {
    expect(nearestPoint([], 10, 10)).toBeNull()
  })
})

describe('pointAtUtc', () => {
  const { points } = projectTrack(square, { width: 300, height: 200 })

  it('picks the nearest sample in time', () => {
    expect(pointAtUtc(points, T(58))?.utc).toBe(T(60))
    expect(pointAtUtc(points, T(20))?.utc).toBe(T(0))
  })

  it('clamps to the ends rather than returning nothing', () => {
    expect(pointAtUtc(points, T(-9999))?.utc).toBe(T(0))
    expect(pointAtUtc(points, T(9999))?.utc).toBe(T(180))
  })

  it('is exact on a sample', () => {
    expect(pointAtUtc(points, T(120))?.utc).toBe(T(120))
  })
})

describe('rowsBetween', () => {
  it('filters to a race window, inclusive at both ends', () => {
    expect(rowsBetween(square, T(60), T(120)).map((r) => r.utc)).toEqual([T(60), T(120)])
  })

  it('an open window is the whole day', () => {
    expect(rowsBetween(square, null, null)).toHaveLength(4)
  })
})

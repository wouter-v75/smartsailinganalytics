import { describe, it, expect } from 'vitest'
import {
  geoRows, thin, projectTrack, nearestPoint, pointAtUtc, rowsBetween, segmentPath, nearestPointWithin,
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

describe('segmentPath — what a clip covers', () => {
  const pts = [0, 1, 2, 3, 4].map((i) => ({ utc: 1000 + i * 1000, x: i * 10, y: i }))

  it('draws the stretch inside the window', () => {
    expect(segmentPath(pts, 2000, 4000)).toBe('M10.0 1.0L20.0 2.0L30.0 3.0')
  })

  it('takes the ends in either order', () => {
    expect(segmentPath(pts, 4000, 2000)).toBe(segmentPath(pts, 2000, 4000))
  })

  it('clamps to the track rather than running off it', () => {
    expect(segmentPath(pts, -1e12, 1e12)).toBe('M0.0 0.0L10.0 1.0L20.0 2.0L30.0 3.0L40.0 4.0')
  })

  it('is empty for an INSTANT, which is honestly a point', () => {
    expect(segmentPath(pts, 2000, 2000)).toBe('')
  })

  it('is empty past the end of the track', () => {
    expect(segmentPath(pts, 5500, 6000)).toBe('')
  })

  it('brackets a clip shorter than the track’s own resolution', () => {
    // A day thinned to 1200 points is sampled every fifteen or twenty seconds,
    // so a forty-second clip can contain ONE drawn point. Drawing it as a dot
    // would say the camera recorded an instant — the one thing it did not.
    const out = segmentPath(pts, 1900, 2100)
    expect(out).toBe('M0.0 0.0L10.0 1.0L20.0 2.0')
  })

  it('brackets a clip that falls entirely between two samples', () => {
    // The boat really did cover that water while the camera was running.
    expect(segmentPath(pts, 2100, 2900)).toBe('M10.0 1.0L20.0 2.0')
  })

  it('does not bracket outwards when the window already lines up', () => {
    expect(segmentPath(pts, 2000, 4000)).toBe('M10.0 1.0L20.0 2.0L30.0 3.0')
  })

  it('is empty rather than NaN for a window that is not a window', () => {
    expect(segmentPath(pts, NaN, 4000)).toBe('')
    expect(segmentPath(pts, 2000, undefined as unknown as number)).toBe('')
  })

  it('survives an empty track', () => {
    expect(segmentPath([], 0, 1)).toBe('')
  })
})

describe('nearestPointWithin — dragging along a track that crosses itself', () => {
  // Out and back over the SAME water: x runs 0→40 over ten minutes and then
  // 40→0 over the next ten. Every pixel on it belongs to two different times,
  // which is exactly the geometry that let a one-pixel nudge move a tag ten
  // minutes when the search was purely spatial.
  const pts = Array.from({ length: 21 }, (_, i) => ({
    utc: i * 60_000,
    x: i <= 10 ? i * 4 : (20 - i) * 4,
    y: 0,
  }))
  const W = 150_000   // the window a drag carries with it

  it('stays on the leg the tag is already on', () => {
    // x = 20 is both t = 5 min (going out) and t = 15 min (coming back).
    const near = nearestPointWithin(pts, 20, 0, 15 * 60_000, W)!
    expect(near.point.utc).toBe(15 * 60_000)
    expect(nearestPoint(pts, 20, 0)!.point.utc).toBe(5 * 60_000)   // the spatial answer
  })

  it('cannot be nudged onto the other leg by a pixel', () => {
    const start = 15 * 60_000
    const near = nearestPointWithin(pts, 21, 0, start, W)!
    expect(Math.abs(near.point.utc - start)).toBeLessThanOrEqual(60_000)
  })

  it('follows a finger that is actually moving', () => {
    // The drag walks the return leg: each step recentres the window, so the
    // preview travels along the track rather than snapping across to the leg
    // that happens to share the pixel.
    let at = 12 * 60_000
    const seen = [at]
    for (const x of [28, 24, 20, 16, 12, 8]) {
      const hit = nearestPointWithin(pts, x, 0, at, W)
      if (hit) { at = hit.point.utc; seen.push(at) }
    }
    expect(at).toBe(18 * 60_000)
    // Monotonic: it never doubles back into the outward leg.
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })

  it('is null rather than a guess when the window is empty', () => {
    expect(nearestPointWithin([], 0, 0, 0, 1000)).toBeNull()
    // Halfway between two samples, with a window narrower than the gap.
    expect(nearestPointWithin(pts, 0, 0, 10 * 60_000 + 30_000, 1_000)).toBeNull()
  })

  it('survives a window that is not a window', () => {
    expect(nearestPointWithin(pts, 0, 0, NaN, 1000)).toBeNull()
    expect(nearestPointWithin(pts, 0, 0, 0, NaN)).toBeNull()
  })
})

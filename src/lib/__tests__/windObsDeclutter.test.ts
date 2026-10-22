import { describe, it, expect } from 'vitest'
import { degPerPixel, better, thinForZoom, detailForZoom, obsViewport, OBS_MIN_ZOOM } from '../windObsDeclutter'
import type { WindObs } from '../windObs'

const obs = (id: string, lat: number, lon: number, trust = 5, t = '2026-10-22T09:00:00Z'): WindObs => ({
  id, source: 'metar', name: id, lat, lon, heightM: null, elevM: null,
  surface: 'land', twsKn: 10, twdDeg: 250, gustKn: null, t, trust,
})

describe('degPerPixel', () => {
  it('halves with each zoom level', () => {
    expect(degPerPixel(10, 0) / degPerPixel(11, 0)).toBeCloseTo(2, 6)
  })
  it('narrows with latitude, because meridians converge', () => {
    expect(degPerPixel(10, 60)).toBeLessThan(degPerPixel(10, 0))
  })
})

describe('better', () => {
  it('prefers TRUST — a buoy beats a rooftop', () => {
    const buoy = obs('b', 50, -1, 9)
    const roof = obs('r', 50, -1, 2)
    expect(better(buoy, roof).id).toBe('b')
    expect(better(roof, buoy).id).toBe('b')
  })
  it('prefers the fresher reading at equal trust', () => {
    const old = obs('old', 50, -1, 5, '2026-10-22T06:00:00Z')
    const now = obs('new', 50, -1, 5, '2026-10-22T09:00:00Z')
    expect(better(old, now).id).toBe('new')
  })
  it('never uses SPEED as a tie-break', () => {
    // Picking the windiest station in a crowded cell would bias the whole map
    // upward, quietly, and only where stations are dense.
    const calm = { ...obs('a', 50, -1, 5), twsKn: 2 }
    const windy = { ...obs('b', 50, -1, 5), twsKn: 30 }
    expect(better(calm, windy).id).toBe('a')      // id order, not speed
  })
  it('is stable, so the map does not flicker', () => {
    const a = obs('a', 50, -1); const b = obs('b', 50, -1)
    expect(better(a, b).id).toBe(better(b, a).id)
  })
})

describe('thinForZoom', () => {
  // Spaced ~400 m apart: distinct barbs on a race-area zoom, one smear on a
  // coastline zoom. Any closer and they SHOULD collapse at every zoom — two
  // stations 11 m apart are one reading drawn twice.
  const crowd = [
    obs('roof1', 50.7600, -1.2880, 2),
    obs('roof2', 50.7640, -1.2920, 2),
    obs('roof3', 50.7680, -1.2960, 2),
    obs('buoy', 50.7720, -1.3000, 9),
    obs('far', 51.5000, -0.1000, 5),
  ]

  it('keeps everything when zoomed in', () => {
    expect(thinForZoom(crowd, 16)).toHaveLength(5)
  })

  it('collapses a cluster to its BEST station when zoomed out', () => {
    const thin = thinForZoom(crowd, 8)
    const ids = thin.map((o) => o.id)
    expect(ids).toContain('buoy')        // trust 9 survives
    expect(ids).toContain('far')         // a different part of the map is untouched
    expect(ids).not.toContain('roof1')   // the rooftops lose to the buoy
    expect(thin.length).toBeLessThan(5)
  })

  it('is stable as the reading updates', () => {
    // Grid-snapping, not collision resolution: which station wins does not
    // depend on which others happen to be on screen, so a refresh does not
    // reshuffle the map.
    const a = thinForZoom(crowd, 9).map((o) => o.id).sort()
    const b = thinForZoom([...crowd].reverse(), 9).map((o) => o.id).sort()
    expect(a).toEqual(b)
  })

  it('survives junk', () => {
    expect(thinForZoom([], 10)).toHaveLength(0)
    expect(thinForZoom(crowd, NaN)).toHaveLength(5)
    expect(thinForZoom([obs('bad', NaN, NaN)], 10)).toHaveLength(0)
  })
})

describe('detailForZoom', () => {
  it('adds the magnetic direction only when zoomed right in', () => {
    expect(detailForZoom(13)).toBe('full')
    expect(detailForZoom(11)).toBe('full')
    expect(detailForZoom(10)).toBe('speed')
    expect(detailForZoom(8)).toBe('speed')
    expect(detailForZoom(7)).toBe('barb')
    expect(detailForZoom(4)).toBe('barb')
  })
  it('falls back to speed rather than nothing on a bad zoom', () => {
    expect(detailForZoom(NaN)).toBe('speed')
  })
})

describe('obsViewport', () => {
  it('asks for a radius that covers what is on screen', () => {
    const v = obsViewport(50.76, -1.29, 11, 900, 600)!
    expect(v.lat).toBe(50.76)
    expect(v.nm).toBeGreaterThan(5)
    expect(v.nm).toBeLessThan(40)
  })

  it('grows as you zoom out and shrinks as you zoom in', () => {
    const wide = obsViewport(50.76, -1.29, 9, 900, 600)!
    const tight = obsViewport(50.76, -1.29, 13, 900, 600)!
    expect(wide.nm).toBeGreaterThan(tight.nm)
  })

  it('REFUSES a continental view rather than asking for every station on it', () => {
    // Observations answer a local question. At zoom 5 the map is showing half
    // of Europe, and an honest "zoom in" beats a map that looks broken.
    expect(obsViewport(50.76, -1.29, 6, 900, 600)).toBeNull()
    expect(obsViewport(50.76, -1.29, 3, 900, 600)).toBeNull()
    expect(obsViewport(50.76, -1.29, OBS_MIN_ZOOM, 900, 600)).not.toBeNull()
  })

  it('never asks for more than the route will give', () => {
    // A request that says one thing while the server quietly does another is
    // worth not writing.
    expect(obsViewport(50.76, -1.29, 7, 4000, 4000)!.nm).toBeLessThanOrEqual(120)
  })

  it('rounds the centre, so nudging the map does not mint a new cache key', () => {
    const a = obsViewport(50.7612, -1.2891, 11, 900, 600)!
    const b = obsViewport(50.7634, -1.2908, 11, 900, 600)!
    expect(a.lat).toBe(b.lat)
    expect(a.lon).toBe(b.lon)
  })

  it('returns null on junk rather than a request nobody meant', () => {
    expect(obsViewport(NaN, -1.29, 11, 900, 600)).toBeNull()
    expect(obsViewport(50.76, -1.29, 11, NaN, 600)).toBeNull()
  })
})

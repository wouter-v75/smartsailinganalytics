// How many barbs to draw, and how much to write beside them, at a given zoom.
//
// THE PROBLEM. Zoomed into a race area, twenty stations are twenty useful
// readings. Zoomed out to see a coastline, the same twenty are a smear of
// overlapping arrows with numbers on top of each other, and the map says less
// than it would with five. Worse, the ones that overlap are usually the
// clustered inland ones — so the smear is made of the LEAST useful stations
// while the buoy offshore is the one you cannot read.
//
// So two separate decisions, both of which belong here rather than in a map
// callback where they cannot be tested:
//   WHICH stations to draw   — thin to one per cell, keeping the best
//   HOW MUCH to write        — barb only, + speed, or + speed and direction
//
// Pure: a cell size in degrees is derived from the zoom the way Leaflet derives
// its own scale, so nothing here needs a map object.

import type { WindObs } from './windObs'

/** A barb plus its label is about this wide on screen. */
const MARKER_PX = 54

/**
 * Degrees of longitude per pixel at a Web-Mercator zoom — the standard
 * 256-pixel tile at the equator, narrowed by latitude.
 */
export function degPerPixel(zoom: number, lat = 0): number {
  const base = 360 / (256 * Math.pow(2, zoom))
  return base * Math.max(0.2, Math.cos((lat * Math.PI) / 180))
}

/**
 * Which station wins a crowded cell. Trust first — a buoy on the water beats a
 * rooftop every time, and that is the whole point of the trust scale. Then the
 * fresher reading, because a stale barb drawn over a live one is worse than
 * nothing. Speed is never a tie-breaker: picking the windiest station would
 * quietly bias the map upward.
 */
export function better(a: WindObs, b: WindObs): WindObs {
  if ((a.trust ?? 0) !== (b.trust ?? 0)) return (a.trust ?? 0) > (b.trust ?? 0) ? a : b
  const ta = Date.parse(a.t); const tb = Date.parse(b.t)
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta > tb ? a : b
  return a.id <= b.id ? a : b          // stable, so the map does not flicker
}

/**
 * Thin to at most one station per marker-sized cell.
 *
 * Grid-snapping rather than true collision detection: it is O(n), it is stable
 * as you pan (a station's cell does not depend on which others are on screen),
 * and the result does not flicker when a reading updates. True collision
 * resolution looks tidier for one frame and jitters on every refresh.
 */
export function thinForZoom(obs: WindObs[], zoom: number): WindObs[] {
  if (!Array.isArray(obs)) return []
  // A station with no position is dropped FIRST, not skipped later: the short
  // and bad-zoom shortcuts below would otherwise hand it straight back, and a
  // barb at NaN,NaN lands wherever the map decides.
  const usable = obs.filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lon))
  if (usable.length < 2 || !Number.isFinite(zoom)) return usable
  const cells = new Map<string, WindObs>()
  for (const o of usable) {
    const stepLon = degPerPixel(zoom, o.lat) * MARKER_PX
    const stepLat = degPerPixel(zoom, 0) * MARKER_PX
    const key = `${Math.round(o.lat / stepLat)},${Math.round(o.lon / stepLon)}`
    const cur = cells.get(key)
    cells.set(key, cur ? better(cur, o) : o)
  }
  return Array.from(cells.values())
}

export type ObsDetail = 'full' | 'speed' | 'barb'

/**
 * How much text a barb can carry before it is noise.
 *
 * Direction in degrees is four more characters on an already busy symbol, and
 * the barb itself already shows direction well enough to read a shift across a
 * course. So the number is for when you have zoomed in to ask a precise
 * question — and then it is the MAGNETIC one, because that is what the compass
 * in front of the helm reads.
 */
export function detailForZoom(zoom: number): ObsDetail {
  if (!Number.isFinite(zoom)) return 'speed'
  if (zoom >= 11) return 'full'
  if (zoom >= 8) return 'speed'
  return 'barb'
}

/**
 * Below this, the map is showing a continent and asking for every station on
 * it. Observations are a local question — "what is the breeze doing over
 * there" — so under this zoom they are simply not fetched, and the legend says
 * why rather than showing an empty map that looks broken.
 *
 * Zoom 7 is roughly a 300 nm view: a whole racing coastline, not a country.
 */
export const OBS_MIN_ZOOM = 7

/**
 * What to ask /api/obs for, given where the map is looking.
 *
 * The radius covers the visible half-diagonal plus a margin, so a barb does not
 * pop in only once its station has crossed the edge. Capped at the route's own
 * limit — asking for more is silently trimmed there, and a request that says
 * one thing while the server does another is worth not writing.
 */
export function obsViewport(
  centreLat: number, centreLon: number, zoom: number, widthPx: number, heightPx: number,
): { lat: number; lon: number; nm: number } | null {
  if (![centreLat, centreLon, zoom, widthPx, heightPx].every(Number.isFinite)) return null
  if (zoom < OBS_MIN_ZOOM) return null
  const degLon = degPerPixel(zoom, centreLat)
  // Half-diagonal in pixels, converted at the centre's own scale, then to nm.
  const halfDiagPx = Math.hypot(widthPx, heightPx) / 2
  const nmPerPx = degLon * 60
  const nm = Math.min(120, Math.max(10, Math.round(halfDiagPx * nmPerPx * 1.15)))
  // Rounded so that nudging the map does not mint a new cache key each time.
  const r = (v: number) => Math.round(v * 100) / 100
  return { lat: r(centreLat), lon: r(centreLon), nm }
}

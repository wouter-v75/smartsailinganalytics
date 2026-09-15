// src/lib/tagging/trackGeom.ts
// ─────────────────────────────────────────────────────────────────────────────
// Turning a day's GPS samples into something you can put a thumb on.
//
// Not a map. The tagger's track view has one job — let a crew member point at a
// moment — and a tile map makes that harder, not easier: tiles need the network
// (which is the one thing a RIB does not have), they invite pan and zoom that
// fight the same drag gesture used to pick a point, and a course five miles off
// a featureless coast renders as blue rectangle either way. So: the track's own
// shape, drawn to fit the box, and nothing behind it.
//
// Projection is equirectangular with the longitude scaled by cos(latitude) at
// the middle of the track. Over a race course — tens of kilometres at most —
// that is accurate to well under a pixel, and unlike Web Mercator it does not
// need the whole globe's arithmetic to say where a boat was.
//
// Pure — no React, no DOM, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

export interface GeoRow {
  utc: number
  lat?: number | null
  lon?: number | null
}

export interface TrackPoint {
  utc: number
  /** Pixels inside the box handed to projectTrack. */
  x: number
  y: number
}

export interface TrackBox {
  width: number
  height: number
  /** Kept clear on every side so a marker on the edge is not half cut off. */
  pad?: number
}

export interface Projection {
  points: TrackPoint[]
  /** An SVG path for the whole track, or '' when there is nothing to draw. */
  path: string
  /** Metres per pixel, for a scale bar. null when the track is a single point. */
  metresPerPx: number | null
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const EARTH_M_PER_DEG = 111_320

/** Samples that actually carry a position, in time order. */
export function geoRows<T extends GeoRow>(rows: readonly T[] | null | undefined): T[] {
  const out = (rows || []).filter(
    (r) => r && isNum(r.utc) && isNum(r.lat) && isNum(r.lon) &&
      // 0,0 is the Atlantic off Ghana, and it is what a GPS emits before it has
      // a fix. A day that starts alongside in Palma should not be drawn as a
      // line to the Gulf of Guinea and back.
      !(r.lat === 0 && r.lon === 0)
  )
  return out.sort((a, b) => a.utc - b.utc)
}

/**
 * Thin a track to about `max` points.
 *
 * A 1 Hz log of a six-hour day is 21 600 samples; an SVG path with that many
 * commands costs more to lay out than the whole rest of the view. Every Nth
 * sample is enough for a shape you point at — and the FIRST and LAST are always
 * kept, so the track still starts and ends where the day did.
 */
export function thin<T>(rows: readonly T[], max = 1200): T[] {
  if (rows.length <= max || max < 2) return rows.slice()
  const step = Math.ceil(rows.length / max)
  const out: T[] = []
  for (let i = 0; i < rows.length; i += step) out.push(rows[i])
  const last = rows[rows.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/**
 * Project positioned samples into a box, preserving aspect ratio.
 *
 * Uniform scale on both axes, deliberately: a track squashed to fill the box
 * would show a beat and a run at different angles, and the shape of the course
 * is most of how somebody recognises where they are on it.
 */
export function projectTrack(rows: readonly GeoRow[], box: TrackBox): Projection {
  const pts = geoRows(rows)
  const pad = box.pad ?? 12
  const w = Math.max(1, box.width - pad * 2)
  const h = Math.max(1, box.height - pad * 2)

  if (!pts.length) return { points: [], path: '', metresPerPx: null }

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
  for (const r of pts) {
    const la = r.lat as number, lo = r.lon as number
    if (la < minLat) minLat = la
    if (la > maxLat) maxLat = la
    if (lo < minLon) minLon = lo
    if (lo > maxLon) maxLon = lo
  }

  const kx = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180)) || 1
  const spanX = (maxLon - minLon) * kx
  const spanY = maxLat - minLat

  // A boat that never moved, or a single sample: centre it rather than dividing
  // by zero and painting NaN into the path.
  const scale = spanX <= 0 && spanY <= 0
    ? 0
    : Math.min(spanX > 0 ? w / spanX : Infinity, spanY > 0 ? h / spanY : Infinity)

  const drawW = spanX * scale
  const drawH = spanY * scale
  const offX = pad + (w - drawW) / 2
  const offY = pad + (h - drawH) / 2

  const points: TrackPoint[] = pts.map((r) => ({
    utc: r.utc,
    x: offX + ((r.lon as number) - minLon) * kx * scale,
    // Y is flipped: latitude grows north, screen y grows down.
    y: offY + (maxLat - (r.lat as number)) * scale,
  }))

  let path = ''
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    path += `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`
  }

  return {
    points,
    path,
    metresPerPx: scale > 0 ? EARTH_M_PER_DEG / scale : null,
  }
}

/** The projected point nearest a screen position, with its distance in pixels. */
export function nearestPoint(
  points: readonly TrackPoint[],
  x: number,
  y: number
): { point: TrackPoint; index: number; distPx: number } | null {
  let best = -1
  let bestD2 = Infinity
  for (let i = 0; i < points.length; i++) {
    const dx = points[i].x - x
    const dy = points[i].y - y
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) { bestD2 = d2; best = i }
  }
  if (best < 0) return null
  return { point: points[best], index: best, distPx: Math.sqrt(bestD2) }
}

/**
 * Where a given instant sits on the projected track.
 *
 * Binary search for the nearest sample by time rather than interpolating: the
 * point is drawn as a 10 px dot on a track thinned to ~1200 samples, so the
 * nearest sample and the interpolated position differ by less than the dot.
 */
export function pointAtUtc(points: readonly TrackPoint[], utc: number): TrackPoint | null {
  if (!points.length || !isNum(utc)) return null
  let lo = 0, hi = points.length - 1
  if (utc <= points[lo].utc) return points[lo]
  if (utc >= points[hi].utc) return points[hi]
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid].utc <= utc) lo = mid
    else hi = mid
  }
  return utc - points[lo].utc <= points[hi].utc - utc ? points[lo] : points[hi]
}

/** Samples inside [t0, t1]. Used by the race filter. */
export function rowsBetween<T extends GeoRow>(
  rows: readonly T[],
  t0: number | null,
  t1: number | null
): T[] {
  if (t0 == null && t1 == null) return rows.slice()
  return rows.filter(
    (r) => (t0 == null || r.utc >= t0) && (t1 == null || r.utc <= t1)
  )
}

/**
 * The stretch of track between two instants, as an SVG path.
 *
 * Used to draw what a clip covers. A video is not a moment — "was that gybe
 * filmed" is a question about a window — so it is drawn as a length of water
 * rather than as a dot on the spot the camera happened to start.
 *
 * Returns '' when the window contains fewer than two drawn points: that is a
 * clip shorter than the track's own resolution, and a one-point path renders as
 * nothing anyway. Callers fall back to a dot.
 */
export function segmentPath(
  points: readonly TrackPoint[],
  t0: number,
  t1: number
): string {
  if (!isNum(t0) || !isNum(t1)) return ''
  const from = Math.min(t0, t1)
  const to = Math.max(t0, t1)
  let path = ''
  let n = 0
  for (const p of points) {
    if (p.utc < from) continue
    if (p.utc > to) break
    path += `${n ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`
    n++
  }
  return n > 1 ? path : ''
}

/**
 * The nearest point to (x, y) among those within `windowMs` of `aroundUtc`.
 *
 * Plain nearest-in-space is wrong for dragging a tag along the track, and
 * wrong in a way that is silent: a windward-leeward course doubles back over
 * itself, so the closest pixel to a marker on the second beat is routinely a
 * point from the first one. A one-pixel nudge could move a tag ten minutes, and
 * the crew would have no way of knowing until they went looking for it.
 *
 * Constraining to a window around where the tag CURRENTLY is makes the drag
 * follow the track instead of teleporting between legs: the window travels with
 * the preview, so a long drag still crosses the whole day, one window at a time.
 *
 * null when the window holds no points at all — the caller leaves the tag where
 * it is rather than guessing.
 */
export function nearestPointWithin(
  points: readonly TrackPoint[],
  x: number,
  y: number,
  aroundUtc: number,
  windowMs: number
): { point: TrackPoint; index: number; distPx: number } | null {
  if (!isNum(aroundUtc) || !isNum(windowMs)) return null
  const lo = aroundUtc - Math.abs(windowMs)
  const hi = aroundUtc + Math.abs(windowMs)
  let best = -1
  let bestD2 = Infinity
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (p.utc < lo) continue
    if (p.utc > hi) break          // points are in time order
    const dx = p.x - x
    const dy = p.y - y
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) { bestD2 = d2; best = i }
  }
  if (best < 0) return null
  return { point: points[best], index: best, distPx: Math.sqrt(bestD2) }
}

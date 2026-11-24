// Spherical geometry for routing, in nautical miles and degrees true.
//
// A router steps a boat a few miles at a time, so the arithmetic here is the
// inner loop of everything: it is plain spherical trigonometry on a sphere of
// one nautical mile per arc-minute (R = 3437.75 nm), which is what the nautical
// mile was defined to be. The ellipsoid would move a 600 nm course by ~0.2 %,
// far inside every other error a weather routing carries.

export const D2R = Math.PI / 180
export const R2D = 180 / Math.PI
/** Earth radius in nautical miles: 1 nm = 1 arc-minute. */
export const R_NM = 10800 / Math.PI

export interface LatLon { lat: number; lon: number }

/** Bring any angle into [0, 360). */
export const norm360 = (a: number) => ((a % 360) + 360) % 360
/** Bring any angle into (-180, 180]. */
export const norm180 = (a: number) => { const x = norm360(a); return x > 180 ? x - 360 : x }

/** Great-circle distance, nm (haversine). */
export function distNm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const p1 = aLat * D2R, p2 = bLat * D2R
  const dp = p2 - p1, dl = (bLon - aLon) * D2R
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial great-circle bearing a -> b, degrees true. */
export function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const p1 = aLat * D2R, p2 = bLat * D2R, dl = (bLon - aLon) * D2R
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return norm360(Math.atan2(y, x) * R2D)
}

/** The point `nm` along initial bearing `brg` from (lat, lon). */
export function destination(lat: number, lon: number, brg: number, nm: number): LatLon {
  const d = nm / R_NM, t = brg * D2R, p1 = lat * D2R, l1 = lon * D2R
  const sp2 = Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t)
  const p2 = Math.asin(Math.max(-1, Math.min(1, sp2)))
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * sp2)
  return { lat: p2 * R2D, lon: norm180(l2 * R2D) }
}

/**
 * Signed cross-track distance of p from the great circle a -> b, nm
 * (positive = right of the track), and the along-track distance from a.
 */
export function crossAlong(p: LatLon, a: LatLon, b: LatLon): { xte: number; along: number } {
  const d13 = distNm(a.lat, a.lon, p.lat, p.lon) / R_NM
  const t13 = bearingDeg(a.lat, a.lon, p.lat, p.lon) * D2R
  const t12 = bearingDeg(a.lat, a.lon, b.lat, b.lon) * D2R
  const xt = Math.asin(Math.sin(d13) * Math.sin(t13 - t12))
  const at = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / Math.cos(xt))))
  return { xte: xt * R_NM, along: (Math.cos(t13 - t12) < 0 ? -at : at) * R_NM }
}

/**
 * Where segment p->q comes closest to point m: the fraction along the segment
 * (0..1) and the distance, nm. Done in a local tangent plane centred on m, which
 * is exact enough for segments of a few miles and is what makes "did this step
 * pass within the rounding radius of the mark" a closed-form question rather
 * than a sampled one.
 */
export function closestApproach(p: LatLon, q: LatLon, m: LatLon): { f: number; nm: number } {
  const k = Math.cos(m.lat * D2R) * 60
  const px = (p.lon - m.lon) * k, py = (p.lat - m.lat) * 60
  const qx = (q.lon - m.lon) * k, qy = (q.lat - m.lat) * 60
  const dx = qx - px, dy = qy - py
  const L2 = dx * dx + dy * dy
  const f = L2 > 0 ? Math.max(0, Math.min(1, -(px * dx + py * dy) / L2)) : 0
  return { f, nm: Math.hypot(px + f * dx, py + f * dy) }
}

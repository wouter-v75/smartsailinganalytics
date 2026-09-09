// magVar.ts — magnetic variation to fall back on when the log has no MagVar.
//
// WHY. The start panel reports LINE SQUARE in magnetic degrees, converting from
// true with the log's MagVar column. The navigator's export has no such column,
// so the code fell back to 0 — which does not mean "unknown", it means "true and
// magnetic are the same". The panel has been showing a TRUE bearing under a
// magnetic label, wrong by the local variation.
//
// This is a small table of measured values by venue, not a model. Variation
// drifts about 0.1 deg a year, so these are good for years, but each entry
// records where and when it came from so a stale one is visible rather than
// merely old.
//
// ONLY venues with a value someone has actually supplied belong here. Guessing a
// plausible number for a venue nobody has checked would be worse than the honest
// zero it replaces, because a wrong number looks right.

export interface MagVarVenue {
  name: string
  lat: number
  lon: number
  /** Signed, POSITIVE EAST — matching the log's MagVar convention, so
   *  magnetic = true − varDeg. */
  varDeg: number
  /** Where the figure came from, and when it was good for. */
  source: string
}

export const MAGVAR_VENUES: MagVarVenue[] = [
  { name: 'Porto Cervo', lat: 41.135, lon: 9.538, varDeg: 3.5, source: 'crew, 2026-09' },
]

/** How far from a venue's centre the value is still taken to apply. A race area
 *  sits within a few miles of its venue; 100 km is generous without letting one
 *  venue's variation leak into the next. */
const RADIUS_KM = 100

const R_KM = 6371
const toRad = (d: number) => (d * Math.PI) / 180
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon)
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * R_KM * Math.asin(Math.sqrt(h))
}

/**
 * Variation for a position, or null when no venue is close enough. Null means
 * "we do not know" — callers should NOT quietly substitute zero and keep calling
 * the result magnetic.
 */
export function fallbackMagVar(lat: unknown, lon: unknown): MagVarVenue | null {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  let best: MagVarVenue | null = null
  let bestKm = Infinity
  for (const v of MAGVAR_VENUES) {
    const km = haversineKm(lat, lon, v.lat, v.lon)
    if (km < bestKm) { bestKm = km; best = v }
  }
  return bestKm <= RADIUS_KM ? best : null
}

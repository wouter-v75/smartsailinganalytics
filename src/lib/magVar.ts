// magVar.ts — magnetic variation, from the World Magnetic Model, with a small
// table of measured values that outrank it.
//
// WHY. The start panel reports LINE SQUARE in magnetic degrees, converting from
// true with the log's MagVar column. The navigator's export has no such column,
// so the code fell back to 0 — which does not mean "unknown", it means "true and
// magnetic are the same". The panel has been showing a TRUE bearing under a
// magnetic label, wrong by the local variation.
//
// WHAT CHANGED. There is now a global answer: `magVarDeg()` evaluates WMM-2025
// (the `geomagnetism` package) for any position on earth, so "no venue in the
// table" is no longer a reason to show a true bearing under a magnetic label.
// WMM carries its own secular-variation terms, so it is accurate BY DATE and
// valid to 2030 — it is renewed at the epoch, not annually.
//
// Validated against NOAA's own calculator (geomag-web, WMM-2025, elevation 0)
// on 22 Oct 2026 at seven venues on three continents: worst disagreement
// 0.0004 deg, against WMM's own stated uncertainty of ~0.34 deg. The test below
// pins that, so a package bump that quietly changed epoch would fail rather than
// drift.
//
// THE TABLE SURVIVES, and still outranks the model. A figure someone measured at
// the venue beats a global model evaluated there — and the two agree where we
// can check: the crew's 3.5 at Porto Cervo against WMM's 3.529. Each entry still
// records where and when it came from, so a stale one is visible.
//
// ONLY venues with a value someone has actually supplied belong here. There is
// no longer any reason to guess one: an unlisted venue gets the model, not a
// zero.

import geomagnetism from 'geomagnetism'

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

/**
 * Variation anywhere, positive east — the same convention as the table and as
 * the log's MagVar column, so `magnetic = true − magVarDeg(...)`.
 *
 * A measured venue value wins; otherwise WMM-2025 is evaluated at the position
 * and date. Null means the POSITION was unusable, not that we lack a figure —
 * callers must still not substitute zero and keep calling the result magnetic.
 */
export function magVarDeg(lat: unknown, lon: unknown, when: Date = new Date()): number | null {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  const measured = fallbackMagVar(lat, lon)
  if (measured) return measured.varDeg
  try {
    const d = geomagnetism.model(when).point([lat, lon]).decl
    return Number.isFinite(d) ? d : null
  } catch {
    // Past the model's validity the package throws rather than extrapolating,
    // which is the right behaviour — and null here is honest.
    return null
  }
}

/** True bearing to magnetic, or null when the variation is unknown. */
export function trueToMagnetic(trueDeg: number, lat: unknown, lon: unknown, when?: Date): number | null {
  if (!Number.isFinite(trueDeg)) return null
  const v = magVarDeg(lat, lon, when)
  if (v == null) return null
  const m = ((trueDeg - v) % 360 + 360) % 360
  return m === 0 ? 360 : m          // north reads 360, as everywhere else here
}

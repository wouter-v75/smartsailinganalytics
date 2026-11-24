// Land, as a raster the router can ask "is this step wet?".
//
// The reanalysis' own land-sea mask is 0.25 deg — 15 nm — which would close the
// Strait of Messina (1.6 nm) and the Bonifacio strait and open half of every
// island. So land comes from its own, much finer raster (the fetch script builds
// it at ~0.01 deg, ~0.6 nm, from the 1 km GLOBE-derived `global_land_mask`), and
// a step is refused if any sample along it is land. Sampling at half a cell is
// what keeps a step from jumping a narrow spit between two wet samples.

import type { LatLon } from './geo'

export interface LandMask {
  lat0: number; dLat: number; nLat: number
  lon0: number; dLon: number; nLon: number
  /** 1 = land, row-major [iLat][iLon], lat ascending. */
  cells: Uint8Array
}

export function isLand(m: LandMask, lat: number, lon: number): boolean {
  const i = Math.round((lat - m.lat0) / m.dLat), j = Math.round((lon - m.lon0) / m.dLon)
  if (i < 0 || j < 0 || i >= m.nLat || j >= m.nLon) return false
  return m.cells[i * m.nLon + j] === 1
}

/** True when the straight step a -> b touches land anywhere. */
export function stepHitsLand(m: LandMask | null, a: LatLon, b: LatLon): boolean {
  if (!m) return false
  const dy = (b.lat - a.lat) / m.dLat, dx = (b.lon - a.lon) / m.dLon
  const n = Math.max(1, Math.ceil(2 * Math.max(Math.abs(dx), Math.abs(dy))))
  for (let s = 0; s <= n; s++) {
    const f = s / n
    if (isLand(m, a.lat + f * (b.lat - a.lat), a.lon + f * (b.lon - a.lon))) return true
  }
  return false
}

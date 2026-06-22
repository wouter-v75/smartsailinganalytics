// coastline.js
// ----------------------------------------------------------------------------
// Crude land-sea mask + coastline-normal derivation for the forecast diagnostics.
// "Coastline dataset" = the Open-Meteo Elevation API (a DEM): land where
// elevation > a small threshold, sea at/below it. We sample a small grid around
// the point and feed it to coastNormalFromMask(). Cheap, no box dependency, and
// the same DEM-as-coastline approach used by reference sailing-forecast tooling.
//
// The per-venue manual override in forecastDiagnostics.VENUE_COAST_NORMAL always
// wins; this is the auto-derive fallback (decision 2026-06-22: auto + override).
// ----------------------------------------------------------------------------
import { coastNormalFromMask, VENUE_COAST_NORMAL } from './forecastDiagnostics'

const ELEV_URL = 'https://api.open-meteo.com/v1/elevation'
const _maskCache = new Map()   // key → Promise<{deg, source}>

/**
 * Fetch a land-sea mask grid around (lat,lon) from the elevation DEM and derive
 * the outward coast normal (azimuth land→sea).
 * @param {number} lat @param {number} lon
 * @param {object} [o]
 * @param {number} [o.halfDeg=0.12]  half-extent of the sample box (~13 km)
 * @param {number} [o.n=9]           grid is n×n (≤10 → ≤100 pts, the API limit)
 * @param {number} [o.landM=1]       elevation (m) above which a cell counts as land
 * @returns {Promise<{deg:number|null, source:'mask'|'none'}>}
 */
export async function deriveCoastNormal(lat, lon, o = {}) {
  const half = o.halfDeg ?? 0.12
  const n = Math.min(o.n ?? 9, 10)
  const landM = o.landM ?? 1
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180))
  // i increases NORTH (row), j increases EAST (col) — matches coastNormalFromMask northUp=true
  const lats = []; const lons = []
  for (let i = 0; i < n; i++) lats.push(lat - half + (2 * half) * (i / (n - 1)))
  for (let j = 0; j < n; j++) lons.push(lon - (half / cosLat) + (2 * half / cosLat) * (j / (n - 1)))
  const latArg = []; const lonArg = []
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { latArg.push(lats[i].toFixed(4)); lonArg.push(lons[j].toFixed(4)) }
  let elev
  try {
    const res = await fetch(`${ELEV_URL}?latitude=${latArg.join(',')}&longitude=${lonArg.join(',')}`)
    if (!res.ok) return { deg: null, source: 'none' }
    const j = await res.json()
    elev = j.elevation
  } catch { return { deg: null, source: 'none' } }
  if (!Array.isArray(elev) || elev.length !== n * n) return { deg: null, source: 'none' }
  // build mask[i][j] = land fraction (1 land / 0 sea)
  const mask = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, jj) => (elev[i * n + jj] > landM ? 1 : 0)))
  // need both land and sea in the window for a coastline to exist
  let land = 0; let sea = 0
  for (const row of mask) for (const c of row) { if (c) land++; else sea++ }
  if (!land || !sea) return { deg: null, source: 'none' }
  const mid = Math.floor(n / 2)
  const deg = coastNormalFromMask(mask, mid, mid, { northUp: true, radius: Math.min(3, mid) })
  return deg != null ? { deg, source: 'mask' } : { deg: null, source: 'none' }
}

/**
 * Resolve the coast normal for a point: per-venue override first, else DEM-derived.
 * Cached per venue/rounded-point.
 * @returns {Promise<{deg:number|null, source:'override'|'mask'|'none'}>}
 */
export async function coastNormalForPoint(venueKey, lat, lon, o = {}) {
  if (venueKey && VENUE_COAST_NORMAL[venueKey] != null) {
    return { deg: VENUE_COAST_NORMAL[venueKey], source: 'override' }
  }
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`
  if (_maskCache.has(key)) return _maskCache.get(key)
  const p = deriveCoastNormal(lat, lon, o)
  _maskCache.set(key, p)
  return p
}

// windField.js
// ----------------------------------------------------------------------------
// Builds an animated 2D wind field for the interactive map overlay.
//
// Open-Meteo does not serve GRIB to the browser, so we sample an nx*ny grid of
// points over a ~20 nm box (around clicked point 1) using Open-Meteo's
// multi-coordinate JSON API (comma-separated latitude/longitude => array of
// per-point forecasts), then convert speed/direction to u/v components and emit
// the data structure leaflet-velocity expects, one frame per forecast hour.
//
// leaflet-velocity data format (per frame):
//   [ {header:{parameterCategory:2, parameterNumber:2, nx, ny, lo1, la1, dx, dy,
//              refTime, forecastTime}, data:[u...] },
//     {header:{... parameterNumber:3 ...}, data:[v...] } ]
// data is row-major from the NW origin (la1=north, lo1=west), rows N->S.
// nx*ny === data.length. Components are in m/s; met wind direction is FROM.
// ----------------------------------------------------------------------------

import { MODELS } from './openMeteo'

const NM_DEG = 1 / 60 // 1 nautical mile in degrees latitude

// Heights available for the field selector for a given model: the model's own
// `heights`, but capped at a sensible ceiling for sailing (<=200 m).
export function fieldHeightsFor(modelKey) {
  const m = MODELS[modelKey]
  if (!m || !m.heights) return [10, 100]
  return m.heights.filter((h) => h <= 200)
}

// Models usable for the field (Open-Meteo backed). Icon-Race is self-hosted on
// a venue grid, not an Open-Meteo endpoint, so it is excluded here for now.
export function fieldModelKeys() {
  return Object.keys(MODELS).filter((k) => MODELS[k].endpoint && k !== 'ICONRACE')
}

// 20 nm box (half = 10 nm) around a centre; lon span widened by 1/cos(lat).
export function boxAround(lat, lon, nm = 20) {
  const halfLat = (nm / 2) * NM_DEG
  const halfLon = halfLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180))
  return {
    north: lat + halfLat, south: lat - halfLat,
    west: lon - halfLon, east: lon + halfLon,
  }
}

// Build the sample grid in leaflet-velocity order: rows north->south, cols
// west->east. Returns flat lat[]/lon[] plus the header geometry.
function sampleGrid(box, nx, ny) {
  const dx = (box.east - box.west) / (nx - 1)
  const dy = (box.north - box.south) / (ny - 1)
  const lats = []; const lons = []
  for (let j = 0; j < ny; j++) {        // north -> south
    const la = box.north - j * dy
    for (let i = 0; i < nx; i++) {       // west -> east
      lats.push(+la.toFixed(4))
      lons.push(+(box.west + i * dx).toFixed(4))
    }
  }
  return { lats, lons, header: { nx, ny, lo1: box.west, la1: box.north, dx, dy } }
}

// met direction (deg FROM) + speed (m/s) -> u (eastward), v (northward) m/s
function toUV(speed, dirFrom) {
  if (speed == null || dirFrom == null) return [0, 0]
  const th = (dirFrom * Math.PI) / 180
  return [-speed * Math.sin(th), -speed * Math.cos(th)]
}

// log-law-ish interpolation of speed between two heights; direction linear.
function interpAtHeight(hourly, idx, h, heights) {
  const have = (hh) => hourly[`wind_speed_${hh}m`] && hourly[`wind_speed_${hh}m`][idx] != null
  if (have(h)) {
    return { s: hourly[`wind_speed_${h}m`][idx], d: hourly[`wind_direction_${h}m`]?.[idx] }
  }
  // find bracketing available heights
  const avail = heights.filter(have).sort((a, b) => a - b)
  if (!avail.length) return { s: null, d: null }
  let lo = avail[0]; let hi = avail[avail.length - 1]
  for (let k = 0; k < avail.length; k++) { if (avail[k] <= h) lo = avail[k]; if (avail[k] >= h) { hi = avail[k]; break } }
  if (lo === hi) return { s: hourly[`wind_speed_${lo}m`][idx], d: hourly[`wind_direction_${lo}m`]?.[idx] }
  const sLo = hourly[`wind_speed_${lo}m`][idx]; const sHi = hourly[`wind_speed_${hi}m`][idx]
  const f = (Math.log(Math.max(1, h)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))
  const s = sLo + (sHi - sLo) * f
  const d = hourly[`wind_direction_${Math.abs(h - lo) <= Math.abs(hi - h) ? lo : hi}m`]?.[idx]
  return { s, d }
}

// Fetch + build the field. Returns { times:[ISO...], frames:[{u:[],v:[]}...],
// header, maxSpeed }. Speeds in m/s. `height` may be any value (mast height is
// interpolated from the model's native levels).
export async function fetchWindField({ modelKey, lat, lon, height, timezone, nm = 20, nx = 10, ny = 10 }) {
  const m = MODELS[modelKey]
  if (!m || !m.endpoint) throw new Error(`model ${modelKey} has no Open-Meteo endpoint`)
  const box = boxAround(lat, lon, nm)
  const { lats, lons, header } = sampleGrid(box, nx, ny)

  // request every native height <=200 so we can interpolate the mast height
  const heights = (m.heights || [10, 100]).filter((h) => h <= 200)
  const vars = []
  heights.forEach((h) => { vars.push(`wind_speed_${h}m`, `wind_direction_${h}m`) })

  const url = `${m.endpoint}?latitude=${lats.join(',')}&longitude=${lons.join(',')}`
    + `&hourly=${vars.join(',')}&wind_speed_unit=ms&timezone=${encodeURIComponent(timezone)}`
    + `&forecast_days=2&models=${m.modelParam}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`)
  const json = await res.json()
  const points = Array.isArray(json) ? json : [json]   // multi-coord => array
  if (points.length !== lats.length) {
    // Open-Meteo may collapse duplicate/too-close points; bail with a clear error
    throw new Error(`grid mismatch: asked ${lats.length} points, got ${points.length}`)
  }

  const times = points[0]?.hourly?.time || []
  const nT = times.length
  const N = nx * ny
  const frames = []
  let maxSpeed = 1
  for (let t = 0; t < nT; t++) {
    const u = new Array(N); const v = new Array(N)
    for (let p = 0; p < N; p++) {
      const hourly = points[p].hourly
      const { s, d } = interpAtHeight(hourly, t, height, heights)
      const [uu, vv] = toUV(s, d)
      u[p] = uu; v[p] = vv
      if (s != null && s > maxSpeed) maxSpeed = s
    }
    frames.push({ u, v })
  }
  return { times, frames, header, maxSpeed, box }
}

// Convert one frame to the leaflet-velocity [uObj, vObj] data array.
export function toVelocityData(frame, header, refTimeISO) {
  const base = {
    parameterCategory: 2, parameterUnit: 'm.s-1',
    nx: header.nx, ny: header.ny,
    lo1: header.lo1, la1: header.la1, lo2: header.lo1 + header.dx * (header.nx - 1),
    la2: header.la1 - header.dy * (header.ny - 1),
    dx: header.dx, dy: header.dy,
    refTime: refTimeISO || new Date().toISOString(), forecastTime: 0,
  }
  return [
    { header: { ...base, parameterNumber: 2, parameterNumberName: 'U-component_of_wind' }, data: frame.u },
    { header: { ...base, parameterNumber: 3, parameterNumberName: 'V-component_of_wind' }, data: frame.v },
  ]
}

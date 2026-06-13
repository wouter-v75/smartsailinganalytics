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

import { MODELS, iconRaceGridForPoint } from './openMeteo'

const NM_DEG = 1 / 60 // 1 nautical mile in degrees latitude

// Local-time label "Sat 14:00". isUTC=true converts from UTC to `timezone`;
// otherwise the ISO is treated as already-local wall-clock (Open-Meteo output).
function localLabel(iso, timezone, isUTC) {
  if (!iso) return ''
  if (isUTC) {
    const d = new Date(iso.endsWith('Z') ? iso : `${iso}Z`)
    return d.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone })
  }
  const d = new Date(iso.length <= 16 ? `${iso}:00Z` : `${iso.slice(0, 19)}Z`)
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]
  return `${wd} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// Heights available for the field selector for a given model: the model's own
// `heights`, but capped at a sensible ceiling for sailing (<=200 m).
export function fieldHeightsFor(modelKey) {
  const m = MODELS[modelKey]
  if (!m || !m.heights) return [10, 100]
  return m.heights.filter((h) => h <= 200)
}

// Models usable for the field: Open-Meteo-backed models plus Icon-Race, which
// is read from its own published grid.json (see fetchIconRaceField).
export function fieldModelKeys() {
  return Object.keys(MODELS).filter((k) => MODELS[k].endpoint || k === 'ICONRACE')
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
  const labels = times.map((t) => localLabel(t, timezone, false))
  return { times, labels, frames, header, maxSpeed, box }
}

// Build the field from Icon-Race's own grid.json (self-hosted model). The grid
// is a regular lon/lat box over the venue; we read every cell, interpolate to
// `height`, and emit the same {times,labels,frames,header,maxSpeed,box} shape.
export async function fetchIconRaceField({ lat, lon, height, timezone }) {
  const got = await iconRaceGridForPoint(lat, lon)
  if (!got) throw new Error('no Icon-Race coverage at point 1')
  const { grid, venue } = got
  const heights = (grid.heights || []).map(Number).sort((a, b) => a - b)
  const round = (x) => Math.round(x * 1000) / 1000
  const lons = [...new Set(grid.cells.map((c) => round(c.lon)))].sort((a, b) => a - b)   // W->E
  const lats = [...new Set(grid.cells.map((c) => round(c.lat)))].sort((a, b) => b - a)   // N->S
  const nx = lons.length; const ny = lats.length
  if (nx < 2 || ny < 2) throw new Error('Icon-Race grid too small to render')
  const lonIdx = new Map(lons.map((v, i) => [v, i]))
  const latIdx = new Map(lats.map((v, i) => [v, i]))
  const cellAt = new Array(nx * ny).fill(null)
  for (const c of grid.cells) {
    const i = lonIdx.get(round(c.lon)); const j = latIdx.get(round(c.lat))
    if (i != null && j != null) cellAt[j * nx + i] = c
  }
  const header = {
    nx, ny, lo1: lons[0], la1: lats[0],
    dx: (lons[nx - 1] - lons[0]) / (nx - 1), dy: (lats[0] - lats[ny - 1]) / (ny - 1),
  }
  const times = grid.time || []
  const frames = []
  let maxSpeed = 1
  for (let t = 0; t < times.length; t++) {
    const u = new Array(nx * ny); const v = new Array(nx * ny)
    for (let p = 0; p < nx * ny; p++) {
      const c = cellAt[p]
      let s = null; let d = null
      if (c) { const r = cellAtHeight(c, height, heights, t); s = r.s; d = r.d }
      const sms = s == null ? null : s / 3.6   // km/h -> m/s
      const [uu, vv] = toUV(sms, d)
      u[p] = uu; v[p] = vv
      if (sms != null && sms > maxSpeed) maxSpeed = sms
    }
    frames.push({ u, v })
  }
  const labels = times.map((tt) => localLabel(tt, timezone, true))
  const box = { north: venue.clat + venue.half, south: venue.clat - venue.half, west: venue.clon - venue.half, east: venue.clon + venue.half }
  return { times, labels, frames, header, maxSpeed, box }
}

// speed (km/h) + dir at a height from an Icon-Race cell's spd/dir maps.
function cellAtHeight(c, h, heights, t) {
  const sp = (hh) => c.spd?.[String(hh)]?.[t]
  const di = (hh) => c.dir?.[String(hh)]?.[t]
  if (sp(h) != null) return { s: sp(h), d: di(h) }
  const avail = heights.filter((hh) => sp(hh) != null).sort((a, b) => a - b)
  if (!avail.length) return { s: null, d: null }
  let lo = avail[0]; let hi = avail[avail.length - 1]
  for (let k = 0; k < avail.length; k++) { if (avail[k] <= h) lo = avail[k]; if (avail[k] >= h) { hi = avail[k]; break } }
  if (lo === hi) return { s: sp(lo), d: di(lo) }
  const f = (Math.log(Math.max(1, h)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))
  return { s: sp(lo) + (sp(hi) - sp(lo)) * f, d: di(Math.abs(h - lo) <= Math.abs(hi - h) ? lo : hi) }
}

// Bilinear sample of the field at (lat,lon) for a given frame -> wind at the
// cursor. Returns { kt, dirTrue } (speed in knots, met direction FROM, true) or
// null if the cursor is outside the field box.
export function sampleField(field, idx, lat, lon) {
  if (!field || !field.frames || !field.frames[idx]) return null
  const { nx, ny, lo1, la1, dx, dy } = field.header
  const cx = (lon - lo1) / dx          // column (W->E)
  const cy = (la1 - lat) / dy          // row (N->S)
  if (cx < 0 || cx > nx - 1 || cy < 0 || cy > ny - 1) return null
  const x0 = Math.floor(cx); const y0 = Math.floor(cy)
  const x1 = Math.min(x0 + 1, nx - 1); const y1 = Math.min(y0 + 1, ny - 1)
  const fx = cx - x0; const fy = cy - y0
  const f = field.frames[idx]
  const bil = (arr) => (
    (arr[y0 * nx + x0] * (1 - fx) + arr[y0 * nx + x1] * fx) * (1 - fy)
    + (arr[y1 * nx + x0] * (1 - fx) + arr[y1 * nx + x1] * fx) * fy
  )
  const u = bil(f.u); const v = bil(f.v)
  const spdMs = Math.hypot(u, v)
  const dirTrue = (((Math.atan2(-u, -v) * 180) / Math.PI) % 360 + 360) % 360
  return { kt: spdMs * 1.94384, dirTrue }
}

// Wind-speed colour ramp (m/s) -> [r,g,b]. Calm deep-blue -> teal -> green ->
// yellow -> orange -> red, for the shaded speed field behind the particles.
function speedRamp(s, maxS) {
  const stops = [
    [0.00, [12, 34, 72]], [0.18, [20, 110, 165]], [0.36, [26, 178, 150]],
    [0.55, [150, 200, 70]], [0.72, [240, 180, 45]], [0.88, [232, 100, 40]], [1.0, [205, 45, 60]],
  ]
  const f = Math.max(0, Math.min(1, s / Math.max(1, maxS)))
  let a = stops[0]; let b = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) { if (f >= stops[i][0] && f <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break } }
  const t = (f - a[0]) / ((b[0] - a[0]) || 1)
  return a[1].map((v, k) => Math.round(v + (b[1][k] - v) * t))
}

// Build a small nx*ny canvas coloured by wind speed -> dataURL. Used as a
// Leaflet imageOverlay that the browser scales smoothly over the field box, so
// the speed reads as a translucent colour wash under the white particles.
export function speedImageURL(frame, header, maxSpeed) {
  if (typeof document === 'undefined') return null
  const { nx, ny } = header
  const cv = document.createElement('canvas'); cv.width = nx; cv.height = ny
  const ctx = cv.getContext('2d')
  const img = ctx.createImageData(nx, ny)   // row 0 = north (matches frame order)
  for (let p = 0; p < nx * ny; p++) {
    const s = Math.hypot(frame.u[p] || 0, frame.v[p] || 0)
    const [r, g, b] = speedRamp(s, maxSpeed)
    img.data[p * 4] = r; img.data[p * 4 + 1] = g; img.data[p * 4 + 2] = b; img.data[p * 4 + 3] = 180
  }
  ctx.putImageData(img, 0, 0)
  return cv.toDataURL()
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

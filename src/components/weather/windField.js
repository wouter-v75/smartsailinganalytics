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
import { applyMOS } from './mos'

const NM_DEG = 1 / 60 // 1 nautical mile in degrees latitude

// Apply the venue MOS correction to a field's TWS, cell by cell (direction
// unchanged, speed scaled by the MOS ratio). Same correction the hourly table
// uses — just spread across the grid. localHour comes from the field's local
// labels ("Sat 14:00"). Returns a new field; unchanged if no spec.
export function applyMosToField(field, spec, mosModelId) {
  if (!field || !spec || !mosModelId) return field
  const KN = 1.94384
  const hourOf = (t) => { const h = parseInt((field.labels?.[t] || '').slice(-5, -3), 10); return Number.isNaN(h) ? null : h }
  const frames = field.frames.map((fr, t) => {
    const lh = hourOf(t)
    const n = fr.u.length
    const u = new Array(n); const v = new Array(n)
    for (let p = 0; p < n; p++) {
      const uu = fr.u[p]; const vv = fr.v[p]
      const ws = Math.hypot(uu, vv) * KN          // raw mast wind, knots
      if (ws < 1e-3) { u[p] = uu; v[p] = vv; continue }
      const dirTrue = (((Math.atan2(-uu, -vv) * 180) / Math.PI) % 360 + 360) % 360
      const r = applyMOS(spec, mosModelId, ws, dirTrue, lh)
      const f = r && r.ws > 0 ? r.ws / ws : 1
      u[p] = uu * f; v[p] = vv * f
    }
    return { u, v }
  })
  let maxSpeed = 1
  for (const fr of frames) for (let i = 0; i < fr.u.length; i++) { const s = Math.hypot(fr.u[i], fr.v[i]); if (s > maxSpeed) maxSpeed = s }
  return { ...field, frames, maxSpeed }
}

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

// Structured local stamp for the field time slider: weekday, day, month, hour,
// minute. Mirrors localLabel's UTC-vs-local handling so the hours line up with
// the short labels the MOS step parses. UTC sources (Icon-Race) are formatted in
// `timezone`; Open-Meteo's already-local wall-clock strings are read with getUTC*.
const STAMP_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const STAMP_WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function localStamp(iso, timezone, isUTC) {
  if (!iso) return null
  if (isUTC) {
    const d = new Date(iso.endsWith('Z') ? iso : `${iso}Z`)
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, weekday: 'short', day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d)
    const g = (t) => parts.find((p) => p.type === t)?.value || ''
    return { wd: g('weekday'), dd: g('day'), mon: g('month'), hh: Number(g('hour')) % 24, mm: g('minute') }
  }
  const d = new Date(iso.length <= 16 ? `${iso}:00Z` : `${iso.slice(0, 19)}Z`)
  return {
    wd: STAMP_WD[d.getUTCDay()], dd: String(d.getUTCDate()).padStart(2, '0'), mon: STAMP_MON[d.getUTCMonth()],
    hh: d.getUTCHours(), mm: String(d.getUTCMinutes()).padStart(2, '0'),
  }
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
  return Object.keys(MODELS).filter((k) => MODELS[k].endpoint || k.startsWith('ICONRACE'))
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
export async function fetchWindField({ modelKey, lat, lon, height, timezone, nm = 30, nx, ny }) {
  const m = MODELS[modelKey]
  if (!m || !m.endpoint) throw new Error(`model ${modelKey} has no Open-Meteo endpoint`)
  // Per-model sample resolution: high-res models (m.fieldGrid=16) sample a 16x16
  // grid (~2.3 km over a 20 nm box, ≈ native for AROME/ICON-2km); coarse models
  // stay at 10x10 to avoid oversampling into blocky duplicates.
  const gN = m.fieldGrid || 10
  nx = nx || gN; ny = ny || gN
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
  const stamps = times.map((t) => localStamp(t, timezone, false))
  return { times, labels, stamps, frames, header, maxSpeed, box }
}

// Build the field from Icon-Race's own grid.json (self-hosted model). The grid
// is a regular lon/lat box over the venue; we read every cell, interpolate to
// `height`, and emit the same {times,labels,frames,header,maxSpeed,box} shape.
export async function fetchIconRaceField({ lat, lon, height, timezone, modelKey = 'ICONRACE' }) {
  const got = await iconRaceGridForPoint(lat, lon, modelKey)
  if (!got) throw new Error('no Icon-Race coverage at point 1')
  const { grid } = got
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
  const stamps = times.map((tt) => localStamp(tt, timezone, true))
  // box = the ACTUAL published cell extent (centres ± half a cell), so the overlay
  // always aligns with the grid regardless of the venue.half / grid-extent match.
  const box = { north: lats[0] + header.dy / 2, south: lats[ny - 1] - header.dy / 2, west: lons[0] - header.dx / 2, east: lons[nx - 1] + header.dx / 2 }
  return { times, labels, stamps, frames, header, maxSpeed, box }
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

// ABSOLUTE Beaufort colour scale: each band's upper-bound wind speed (knots)
// maps to a fixed colour, so the same colour always means the same wind force
// regardless of the domain max. f = Beaufort number, max = upper bound (kt).
export const BEAUFORT_BANDS = [
  { f: 0, max: 1, c: [130, 145, 170] },   // calm
  { f: 1, max: 4, c: [90, 165, 210] },    // light air
  { f: 2, max: 7, c: [55, 195, 195] },    // light breeze
  { f: 3, max: 11, c: [60, 200, 120] },   // gentle breeze
  { f: 4, max: 17, c: [170, 210, 60] },   // moderate breeze
  { f: 5, max: 22, c: [240, 205, 50] },   // fresh breeze
  { f: 6, max: 28, c: [242, 150, 40] },   // strong breeze
  { f: 7, max: 34, c: [232, 95, 40] },    // near gale
  { f: 8, max: 41, c: [212, 40, 50] },    // gale
  { f: 9, max: 48, c: [200, 40, 120] },   // strong gale
  { f: 10, max: 56, c: [150, 40, 165] },  // storm
  { f: 11, max: 64, c: [110, 30, 150] },  // violent storm
  { f: 12, max: 1e9, c: [80, 20, 120] },  // hurricane
]
const MS_TO_KN = 1.94384
// Full colour range stretched across 0..PALETTE_MAX_KT so almost all the colour
// resolution lands in the racing wind range (everything above saturates at the
// top colour). Continuous interpolation between the colour anchors -> smooth,
// high-contrast gradient that reveals within-band variation.
export const PALETTE_MAX_KT = 40
function speedRamp(speedMs) {
  const B = BEAUFORT_BANDS
  const N = B.length
  const x = Math.max(0, Math.min(0.999999, (speedMs * MS_TO_KN) / PALETTE_MAX_KT))
  const pos = x * (N - 1)               // colour index position 0..N-1
  const i = Math.floor(pos)
  const t = pos - i
  const a = B[i].c; const b = B[Math.min(N - 1, i + 1)].c
  return [Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)]
}

// Build a small nx*ny canvas coloured by ABSOLUTE wind speed (Beaufort) ->
// dataURL. Used as a Leaflet imageOverlay scaled smoothly over the field box.
export function speedImageURL(frame, header, scale = 8, ramp = speedRamp) {
  if (typeof document === 'undefined') return null
  const { nx, ny } = header
  if (nx < 1 || ny < 1) return null
  // Per-cell speed (m/s), then SUPERSAMPLE: render an nx*scale × ny*scale canvas
  // where each output pixel's speed is bilinearly interpolated from the four
  // surrounding cell centres, with smoothstep weights. This gives smooth, ROUNDED
  // colour-band edges (no hard squares) while keeping the exact cell-centre values
  // — so the native model structure stays, just without the boxiness.
  const spd = new Float32Array(nx * ny)
  for (let p = 0; p < nx * ny; p++) spd[p] = Math.hypot(frame.u[p] || 0, frame.v[p] || 0)
  const at = (ix, iy) => spd[Math.min(ny - 1, Math.max(0, iy)) * nx + Math.min(nx - 1, Math.max(0, ix))]
  const smooth = (t) => t * t * (3 - 2 * t)            // smoothstep -> rounder transitions
  const ow = nx * scale; const oh = ny * scale
  const cv = document.createElement('canvas'); cv.width = ow; cv.height = oh
  const ctx = cv.getContext('2d')
  const img = ctx.createImageData(ow, oh)
  for (let oy = 0; oy < oh; oy++) {
    const gy = (oy + 0.5) / scale - 0.5
    const y0 = Math.floor(gy); const fy = smooth(gy - y0)
    for (let ox = 0; ox < ow; ox++) {
      const gx = (ox + 0.5) / scale - 0.5
      const x0 = Math.floor(gx); const fx = smooth(gx - x0)
      const s = at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy)
              + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy
      const [r, g, b] = ramp(s)
      const o = (oy * ow + ox) * 4
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 180
    }
  }
  ctx.putImageData(img, 0, 0)
  return cv.toDataURL()
}

// ── Tidal currents (CMEMS NWS FOAM-AMM15) ───────────────────────────────────
// A SELECTABLE FIELD in the same wind player. Reads its own field JSON (box ->
// Bunny) and returns the same {times,labels,stamps,frames,header,maxSpeed,box}
// shape, flagged isCurrent so the overlay renders it with the current colour
// ramp (red @ 5 kn) + current-tuned particles. Channel coverage only.

const CUR_COV = { west: -2.5, east: -1.0, south: 49.3, north: 50.8 }
export function currentsCovered(lat, lon) {
  return lat >= CUR_COV.south - 0.45 && lat <= CUR_COV.north + 0.45
      && lon >= CUR_COV.west - 0.7 && lon <= CUR_COV.east + 0.7
}

// Current speed (m/s) -> colour, RED saturating at 5 kn (Channel races run past it).
const CUR_ANCHORS = [[40, 60, 90], [40, 130, 190], [40, 180, 165], [120, 200, 85], [240, 190, 55], [220, 45, 45]]
export const CURRENT_MAX_KN = 5
export function currentRamp(speedMs) {
  const x = Math.max(0, Math.min(0.999999, (speedMs * MS_TO_KN) / CURRENT_MAX_KN))
  const N = CUR_ANCHORS.length; const pos = x * (N - 1); const i = Math.floor(pos); const t = pos - i
  const a = CUR_ANCHORS[i]; const b = CUR_ANCHORS[Math.min(N - 1, i + 1)]
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]
}

// Load the whole-Channel ~3 km overview field for the player (point 1 must be in
// coverage). Times are UTC (Z); labels/stamps are localised like the UTC models.
// Wrap a current field JSON (overview OR a hires clip) into the player field shape.
export function currentJsonToField(j, timezone) {
  const times = j.times || []
  const frames = j.frames || []
  let maxSpeed = 1
  for (const fr of frames) for (let i = 0; i < fr.u.length; i++) { const s = Math.hypot(fr.u[i], fr.v[i]); if (s > maxSpeed) maxSpeed = s }
  const h = j.header
  const box = { north: h.la1, south: h.la1 - h.dy * (h.ny - 1), west: h.lo1, east: h.lo1 + h.dx * (h.nx - 1) }
  const labels = times.map((t) => localLabel(t, timezone, true))
  const stamps = times.map((t) => localStamp(t, timezone, true))
  return { times, labels, stamps, frames, header: h, maxSpeed, box, isCurrent: true, resKm: j.res_km }
}

export async function fetchCurrentField({ lat, lon, timezone }) {
  if (!currentsCovered(lat, lon)) throw new Error('Currents cover the English Channel only — set point 1 there')
  const base = MODELS.CURRENTS && MODELS.CURRENTS.bunnyBase
  const url = base
    ? `${base}/currents/channel/field.json`
    : `/api/bunny/storage?key=${encodeURIComponent('icon-race/currents/channel/field.json')}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`currents ${res.status}`)
  return currentJsonToField(await res.json(), timezone)
}

// Fetch a ~20 km native (1.5 km) clip around (lat,lon) via the server clip route.
export async function fetchCurrentHires({ lat, lon, timezone }) {
  const res = await fetch(`/api/currents/hires?lat=${lat}&lon=${lon}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`currents hires ${res.status}`)
  return currentJsonToField(await res.json(), timezone)
}

// ── Boundary-layer height (hpbl) ────────────────────────────────────────────
// A SELECTABLE SCALAR FIELD in the same player (default off). Read from the
// SSA-Race grid.json (which now carries a per-cell `hpbl` series), it renders as
// a coloured shading overlay only — NO particles (it's a scalar, not a vector).
// Shallow PBL (cool) = decoupled, clean sea breeze; deep PBL (warm) = mixed /
// gradient-dominated. Computed on the box (bulk Richardson) so the colours mean
// the same metres at every venue.

// hpbl (m) -> colour. VALUE-anchored stops (not evenly spaced) so the racing-
// relevant lowest ~500 m get most of the colour resolution; shading saturates at
// HPBL_MAX_M (1500 m). Cool (shallow / clean sea breeze) -> warm (deep / mixed).
export const HPBL_MAX_M = 1500
const HPBL_STOPS = [
  [0,    [38, 70, 120]],   // very shallow / stable — deep blue
  [100,  [40, 130, 185]],  // shallow marine layer — blue
  [200,  [45, 178, 172]],  // teal
  [350,  [95, 192, 96]],   // green
  [500,  [222, 200, 70]],  // yellow
  [1000, [235, 130, 45]],  // orange
  [1500, [150, 52, 42]],   // deep / well-mixed — brown-red
]
export function hpblRamp(metres) {
  const m = Math.max(0, Math.min(HPBL_MAX_M, metres || 0))
  let a = HPBL_STOPS[0]; let b = HPBL_STOPS[HPBL_STOPS.length - 1]
  for (let i = 0; i < HPBL_STOPS.length - 1; i++) {
    if (m >= HPBL_STOPS[i][0] && m <= HPBL_STOPS[i + 1][0]) { a = HPBL_STOPS[i]; b = HPBL_STOPS[i + 1]; break }
  }
  const t = b[0] === a[0] ? 0 : (m - a[0]) / (b[0] - a[0])
  return [Math.round(a[1][0] + (b[1][0] - a[1][0]) * t),
    Math.round(a[1][1] + (b[1][1] - a[1][1]) * t),
    Math.round(a[1][2] + (b[1][2] - a[1][2]) * t)]
}

// Multi-resolution contour levels: fine (25 m) through the shallow 0-200 m band,
// 100 m from 200-500 m, then 500 m up to the 1500 m cap. Only levels inside the
// current frame's data range are drawn, so the displayed set is effectively dynamic.
export const HPBL_CONTOUR_LEVELS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 125, 150, 175, 200, 300, 400, 500, 1000, 1500]

// Marching-squares iso-segments for one level. Returns [[[gx,gy],[gx,gy]]...] in
// fractional GRID coords (gx = col W->E, gy = row N->S).
export function hpblContourSegments(scalar, header, level) {
  const { nx, ny } = header
  const v = (ix, iy) => { const s = scalar[iy * nx + ix]; return (s == null || Number.isNaN(s)) ? null : s }
  const cut = (ax, ay, av, bx, by, bv) => { const t = (level - av) / (bv - av); return [ax + t * (bx - ax), ay + t * (by - ay)] }
  const segs = []
  for (let iy = 0; iy < ny - 1; iy++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const v00 = v(ix, iy); const v10 = v(ix + 1, iy); const v11 = v(ix + 1, iy + 1); const v01 = v(ix, iy + 1)
      if (v00 == null || v10 == null || v11 == null || v01 == null) continue
      let c = 0
      if (v00 >= level) c |= 1
      if (v10 >= level) c |= 2
      if (v11 >= level) c |= 4
      if (v01 >= level) c |= 8
      if (c === 0 || c === 15) continue
      const top = () => cut(ix, iy, v00, ix + 1, iy, v10)
      const right = () => cut(ix + 1, iy, v10, ix + 1, iy + 1, v11)
      const bot = () => cut(ix + 1, iy + 1, v11, ix, iy + 1, v01)
      const left = () => cut(ix, iy + 1, v01, ix, iy, v00)
      switch (c) {
        case 1: case 14: segs.push([left(), top()]); break
        case 2: case 13: segs.push([top(), right()]); break
        case 3: case 12: segs.push([left(), right()]); break
        case 4: case 11: segs.push([right(), bot()]); break
        case 5: segs.push([left(), top()]); segs.push([right(), bot()]); break
        case 6: case 9: segs.push([top(), bot()]); break
        case 7: case 8: segs.push([left(), bot()]); break
        case 10: segs.push([top(), right()]); segs.push([left(), bot()]); break
        default: break
      }
    }
  }
  return segs
}

// Build an SVG element (contour lines + value labels) sized to the field grid, for
// a Leaflet svgOverlay over the field box. Lines coloured by the (darkened) ramp,
// labelled in metres; thicker for the 500 m-step lines.
export function buildHpblContourSvg(frame, header, levels = HPBL_CONTOUR_LEVELS) {
  if (typeof document === 'undefined') return null
  const { nx, ny } = header
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${nx} ${ny}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  let mn = Infinity; let mx = -Infinity
  for (const s of frame.scalar) { if (s != null && !Number.isNaN(s)) { if (s < mn) mn = s; if (s > mx) mx = s } }
  for (const lev of levels) {
    if (lev < mn || lev > mx) continue
    const segs = hpblContourSegments(frame.scalar, header, lev)
    if (!segs.length) continue
    const [r, g, b] = hpblRamp(lev)
    const col = `rgb(${Math.round(r * 0.5)},${Math.round(g * 0.5)},${Math.round(b * 0.5)})`
    let d = ''
    for (const s of segs) d += `M${(s[0][0] + 0.5).toFixed(2)} ${(s[0][1] + 0.5).toFixed(2)}L${(s[1][0] + 0.5).toFixed(2)} ${(s[1][1] + 0.5).toFixed(2)}`
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', col)
    path.setAttribute('stroke-width', String(lev % 500 === 0 ? 0.065 : (lev <= 200 ? 0.03 : 0.045)))
    path.setAttribute('stroke-opacity', '0.92'); path.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(path)
    const step = Math.max(1, Math.floor(segs.length / 3)); let placed = 0
    for (let i = 0; i < segs.length && placed < 2; i += step) {
      const s = segs[i]
      const lx = (s[0][0] + s[1][0]) / 2 + 0.5; const ly = (s[0][1] + s[1][1]) / 2 + 0.5
      const t = document.createElementNS(NS, 'text')
      t.setAttribute('x', lx.toFixed(2)); t.setAttribute('y', ly.toFixed(2))
      t.setAttribute('font-size', '0.43'); t.setAttribute('font-weight', '700')
      t.setAttribute('fill', col); t.setAttribute('stroke', 'rgba(255,255,255,0.78)')
      t.setAttribute('stroke-width', '0.025'); t.setAttribute('paint-order', 'stroke')
      t.setAttribute('text-anchor', 'middle'); t.setAttribute('dominant-baseline', 'central')
      t.textContent = String(lev)
      svg.appendChild(t); placed++
    }
  }
  return svg
}

// Like speedImageURL but colours by a per-cell SCALAR (frame.scalar) instead of
// vector magnitude. Same supersample + smoothstep for rounded band edges.
export function scalarImageURL(frame, header, scale = 8, ramp = hpblRamp) {
  if (typeof document === 'undefined') return null
  const { nx, ny } = header
  if (nx < 1 || ny < 1) return null
  const sc = new Float32Array(nx * ny)
  for (let p = 0; p < nx * ny; p++) { const v = frame.scalar[p]; sc[p] = (v == null || Number.isNaN(v)) ? 0 : v }
  const at = (ix, iy) => sc[Math.min(ny - 1, Math.max(0, iy)) * nx + Math.min(nx - 1, Math.max(0, ix))]
  const smooth = (t) => t * t * (3 - 2 * t)
  const ow = nx * scale; const oh = ny * scale
  const cv = document.createElement('canvas'); cv.width = ow; cv.height = oh
  const ctx = cv.getContext('2d')
  const img = ctx.createImageData(ow, oh)
  for (let oy = 0; oy < oh; oy++) {
    const gy = (oy + 0.5) / scale - 0.5
    const y0 = Math.floor(gy); const fy = smooth(gy - y0)
    for (let ox = 0; ox < ow; ox++) {
      const gx = (ox + 0.5) / scale - 0.5
      const x0 = Math.floor(gx); const fx = smooth(gx - x0)
      const s = at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy)
              + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy
      const [r, g, b] = ramp(s)
      const o = (oy * ow + ox) * 4
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 200
    }
  }
  ctx.putImageData(img, 0, 0)
  return cv.toDataURL()
}

// Build the hpbl scalar field from SSA-Race's grid.json (per-cell `hpbl`). Same
// {times,labels,stamps,frames,header,box} shape as the wind field, but frames
// carry `scalar:[m...]` and the field is flagged isHpbl.
export async function fetchIconRaceHpblField({ lat, lon, timezone, modelKey = 'ICONRACE' }) {
  const got = await iconRaceGridForPoint(lat, lon, modelKey)
  if (!got) throw new Error('no SSA-Race coverage at point 1')
  const { grid } = got
  if (!grid.hasHpbl || !grid.cells.some((c) => Array.isArray(c.hpbl))) {
    throw new Error('this SSA-Race cycle has no boundary-layer data yet')
  }
  const round = (x) => Math.round(x * 1000) / 1000
  const lons = [...new Set(grid.cells.map((c) => round(c.lon)))].sort((a, b) => a - b)   // W->E
  const lats = [...new Set(grid.cells.map((c) => round(c.lat)))].sort((a, b) => b - a)   // N->S
  const nx = lons.length; const ny = lats.length
  if (nx < 2 || ny < 2) throw new Error('SSA-Race grid too small to render')
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
  let scalarMax = 1
  for (let t = 0; t < times.length; t++) {
    const scalar = new Array(nx * ny)
    for (let p = 0; p < nx * ny; p++) {
      const c = cellAt[p]
      const v = c && Array.isArray(c.hpbl) ? c.hpbl[t] : null
      scalar[p] = v
      if (v != null && v > scalarMax) scalarMax = v
    }
    frames.push({ scalar })
  }
  const labels = times.map((tt) => localLabel(tt, timezone, true))
  const stamps = times.map((tt) => localStamp(tt, timezone, true))
  // box = the ACTUAL published cell extent (centres ± half a cell), so the overlay
  // always aligns with the grid regardless of the venue.half / grid-extent match.
  const box = { north: lats[0] + header.dy / 2, south: lats[ny - 1] - header.dy / 2, west: lons[0] - header.dx / 2, east: lons[nx - 1] + header.dx / 2 }
  return { times, labels, stamps, frames, header, scalarMax, box, isHpbl: true }
}

// Bilinear sample of a scalar field at (lat,lon) -> { value } (or null outside).
export function sampleScalarField(field, idx, lat, lon) {
  if (!field || !field.frames || !field.frames[idx]) return null
  const { nx, ny, lo1, la1, dx, dy } = field.header
  const cx = (lon - lo1) / dx; const cy = (la1 - lat) / dy
  if (cx < 0 || cx > nx - 1 || cy < 0 || cy > ny - 1) return null
  const x0 = Math.floor(cx); const y0 = Math.floor(cy)
  const x1 = Math.min(x0 + 1, nx - 1); const y1 = Math.min(y0 + 1, ny - 1)
  const fx = cx - x0; const fy = cy - y0
  const a = field.frames[idx].scalar
  const g = (ix, iy) => { const v = a[iy * nx + ix]; return v == null ? NaN : v }
  const v = (g(x0, y0) * (1 - fx) + g(x1, y0) * fx) * (1 - fy)
          + (g(x0, y1) * (1 - fx) + g(x1, y1) * fx) * fy
  return Number.isNaN(v) ? null : { value: v }
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

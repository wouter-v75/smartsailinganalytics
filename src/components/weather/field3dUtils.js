// field3dUtils.js
// ----------------------------------------------------------------------------
// Shared helpers for the MapLibre 3D wind-field views (inline Field3D viewer +
// the deck-capture Venue3D tool). Pure functions — no React, no fetch.
// ----------------------------------------------------------------------------
import { BEAUFORT_BANDS, PALETTE_MAX_KT } from './windField'

export const MAPLIBRE_JS = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js'
export const MAPLIBRE_CSS = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css'
export const SAT_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
export const DEM_TILES = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'
export const KN = 1.94384

// One arrow icon (pointing NORTH / up) per Beaufort band, drawn on a canvas so we
// can tint it; MapLibre rotates it per-feature via icon-rotate.
export function arrowIcon(rgb, size = 50) {
  const c = document.createElement('canvas'); c.width = size; c.height = size
  const x = c.getContext('2d'); x.translate(size / 2, size / 2)
  const hex = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
  x.beginPath(); x.moveTo(0, size * 0.34); x.lineTo(0, -size * 0.06)
  x.lineWidth = size * 0.1; x.strokeStyle = hex; x.stroke()
  x.beginPath(); x.moveTo(0, -size * 0.42); x.lineTo(size * 0.2, size * 0.04); x.lineTo(0, -size * 0.08); x.lineTo(-size * 0.2, size * 0.04)
  x.closePath(); x.fillStyle = hex; x.fill()
  x.strokeStyle = 'rgba(10,15,25,0.65)'; x.lineWidth = Math.max(1, size * 0.025); x.stroke()
  return { width: size, height: size, data: x.getImageData(0, 0, size, size).data }
}

export const bandOf = (kn) => {
  const N = BEAUFORT_BANDS.length
  return Math.max(0, Math.min(N - 1, Math.floor(Math.max(0, Math.min(0.999, (kn || 0) / PALETTE_MAX_KT)) * (N - 1))))
}

export function addArrowIcons(map) {
  BEAUFORT_BANDS.forEach((b, i) => { const id = `arrow-${i}`; if (!map.hasImage(id)) map.addImage(id, arrowIcon(b.c)) })
}

// wind/current field frame → GeoJSON arrow points (subsampled, skips calm cells)
export function fieldToGeoJSON(field, frameIdx) {
  const fr = field?.frames?.[frameIdx]; if (!fr || !fr.u) return { type: 'FeatureCollection', features: [] }
  const { nx, ny, lo1, la1, dx, dy } = field.header
  const step = Math.max(1, Math.round(nx / 16))
  const features = []
  for (let j = 0; j < ny; j += step) {
    for (let i = 0; i < nx; i += step) {
      const p = j * nx + i; const u = fr.u[p]; const v = fr.v[p]
      const spd = Math.hypot(u || 0, v || 0) * KN
      if (spd < 0.6) continue
      const toward = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lo1 + i * dx, la1 - j * dy] },
        properties: { spd: Math.round(spd), band: bandOf(spd), toward: Math.round(toward) },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

// mean TWD (meteorological FROM bearing) over the race area — orient camera UPWIND
export function meanFromDir(field, frameIdx, lat, lon, nm) {
  const fr = field?.frames?.[frameIdx]; if (!fr || !fr.u) return null
  const { nx, ny, lo1, la1, dx, dy } = field.header
  const cosLat = Math.cos((lat * Math.PI) / 180); const r2 = (nm / 60) ** 2
  let su = 0; let sv = 0; let n = 0
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cl = la1 - j * dy; const cn = lo1 + i * dx
      const dLat = lat - cl; const dLon = (lon - cn) * cosLat
      if (dLat * dLat + dLon * dLon > r2) continue
      const p = j * nx + i; const u = fr.u[p]; const v = fr.v[p]
      if (Math.hypot(u || 0, v || 0) < 0.3) continue
      su += u; sv += v; n++
    }
  }
  if (!n) return null
  const toward = (Math.atan2(su, sv) * 180) / Math.PI
  return (((toward + 180) % 360) + 360) % 360
}

export function ringGeoJSON(lat, lon, nm) {
  const coords = []; const R = nm / 60; const cosLat = Math.cos((lat * Math.PI) / 180)
  for (let a = 0; a <= 360; a += 6) { const t = (a * Math.PI) / 180; coords.push([lon + (R / cosLat) * Math.sin(t), lat + R * Math.cos(t)]) }
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] }
}

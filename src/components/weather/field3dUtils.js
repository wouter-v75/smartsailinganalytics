// field3dUtils.js
// ----------------------------------------------------------------------------
// Shared helpers for the MapLibre 3D wind-field views (inline Field3D viewer +
// the deck-capture Venue3D tool). Pure functions — no React, no fetch.
// ----------------------------------------------------------------------------
import { BEAUFORT_BANDS, PALETTE_MAX_KT, speedImageURL, scalarImageURL, currentRamp, hpblRamp } from './windField'

export const MAPLIBRE_JS = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js'
export const MAPLIBRE_CSS = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css'
export const DECK_JS = 'https://unpkg.com/deck.gl@9.0.36/dist.min.js'   // exposes window.deck (incl. MapboxOverlay, SimpleMeshLayer)
// default vertical levels shown in the 3D multi-level view (metres ASL)
export const DEFAULT_LEVELS = [10, 50, 100, 300, 600]
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
  if (!map.hasImage('arrow-mono')) map.addImage('arrow-mono', arrowIcon([20, 30, 45]))   // currents: direction-only, colour is in the drape
}

// wind/current field frame → GeoJSON arrow points (subsampled, skips calm cells)
export function fieldToGeoJSON(field, frameIdx, opts = {}) {
  const minKn = opts.minKn ?? 0.6
  const fr = field?.frames?.[frameIdx]; if (!fr || !fr.u) return { type: 'FeatureCollection', features: [] }
  const { nx, ny, lo1, la1, dx, dy } = field.header
  const step = Math.max(1, Math.round(nx / 16))
  const features = []
  for (let j = 0; j < ny; j += step) {
    for (let i = 0; i < nx; i += step) {
      const p = j * nx + i; const u = fr.u[p]; const v = fr.v[p]
      const spd = Math.hypot(u || 0, v || 0) * KN
      if (spd < minKn) continue
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

// kind of field for the 3D view
export const fieldKind = (field) => (field?.isHpbl ? 'hpbl' : field?.isCurrent ? 'current' : 'wind')

// translucent colour image (speed / current / hpbl) to DRAPE on the terrain
export function drapeImageURL(field, frameIdx) {
  const fr = field?.frames?.[frameIdx]; if (!fr) return null
  const k = fieldKind(field)
  if (k === 'hpbl') return scalarImageURL(fr, field.header, 8, hpblRamp)
  return speedImageURL(fr, field.header, 8, k === 'current' ? currentRamp : undefined)
}
export const drapeOpacity = (field) => (field?.isHpbl ? 0.62 : field?.isCurrent ? 0.55 : 0.4)
// image-source corner coordinates (TL, TR, BR, BL) from the field bounding box
export const boxCoords = (box) => [[box.west, box.north], [box.east, box.north], [box.east, box.south], [box.west, box.south]]

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

// Render a field on an OFFSCREEN MapLibre 3D map and capture PNG stills at a set
// of frame indices (used by the deck for the 4×3D "general weather" snapshots).
// Reuses one map: builds terrain+drape+arrows once, then per frame updates the
// sources, re-orients upwind, waits for idle, and captures. Returns [{idx,png}].
export async function captureField3DSeries(ML, field, opts) {
  const { lat, lon, width = 760, height = 460, exaggeration = 3, frameIndices = [] } = opts || {}
  if (!ML || !field?.frames?.length || !frameIndices.length) return []
  const cont = document.createElement('div')
  cont.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px;height:${height}px;background:#071624;`
  document.body.appendChild(cont)
  const kind = fieldKind(field)
  const minKn = kind === 'current' ? 0.2 : 0.6
  const twd0 = kind !== 'hpbl' ? meanFromDir(field, frameIndices[0], lat, lon, 5) : null
  let map
  const out = []
  try {
    map = new ML.Map({
      container: cont,
      style: { version: 8, sources: { sat: { type: 'raster', tiles: [SAT_TILES], tileSize: 256, maxzoom: 19 } }, layers: [{ id: 'sat', type: 'raster', source: 'sat' }] },
      center: [lon, lat], zoom: 10.4, pitch: 66, bearing: twd0 != null ? twd0 : 0,
      preserveDrawingBuffer: true, attributionControl: false, interactive: false, fadeDuration: 0,
    })
    const idle = () => new Promise((res) => { let done = false; const f = () => { if (done) return; done = true; res() }; map.once('idle', f); setTimeout(f, 4000) })
    await new Promise((res) => { let done = false; const f = () => { if (done) return; done = true; res() }; map.on('load', f); setTimeout(f, 9000) })
    map.addSource('dem', { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 })
    map.setTerrain({ source: 'dem', exaggeration })
    const url0 = drapeImageURL(field, frameIndices[0])
    if (url0) { map.addSource('drape', { type: 'image', url: url0, coordinates: boxCoords(field.box) }); map.addLayer({ id: 'drape', type: 'raster', source: 'drape', paint: { 'raster-opacity': drapeOpacity(field) } }) }
    if (kind !== 'hpbl') {
      addArrowIcons(map)
      map.addSource('wind', { type: 'geojson', data: fieldToGeoJSON(field, frameIndices[0], { minKn }) })
      map.addLayer({ id: 'wind', type: 'symbol', source: 'wind', layout: { 'icon-image': kind === 'current' ? 'arrow-mono' : ['concat', 'arrow-', ['to-string', ['get', 'band']]], 'icon-rotate': ['get', 'toward'], 'icon-rotation-alignment': 'map', 'icon-size': ['interpolate', ['linear'], ['get', 'spd'], 0, 0.4, 30, 1.1], 'icon-allow-overlap': true, 'icon-ignore-placement': true } })
    }
    map.addSource('ring', { type: 'geojson', data: ringGeoJSON(lat, lon, 5) })
    map.addLayer({ id: 'ring', type: 'line', source: 'ring', paint: { 'line-color': '#ef4444', 'line-width': 2, 'line-dasharray': [2, 1.5] } })
    await idle()
    for (const fidx of frameIndices) {
      const twd = kind !== 'hpbl' ? meanFromDir(field, fidx, lat, lon, 5) : null
      if (twd != null) map.setBearing(twd)
      const u2 = drapeImageURL(field, fidx); const ds = map.getSource('drape'); if (ds && u2) ds.updateImage({ url: u2, coordinates: boxCoords(field.box) })
      const ws = map.getSource('wind'); if (ws) ws.setData(fieldToGeoJSON(field, fidx, { minKn }))
      await idle()
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      let png = null; try { png = map.getCanvas().toDataURL('image/png') } catch { /* */ }
      out.push({ idx: fidx, png })
    }
  } catch { /* */ } finally { try { map?.remove() } catch { /* */ } try { document.body.removeChild(cont) } catch { /* */ } }
  return out
}

// ── multi-level 3D wind field (deck.gl) ──────────────────────────────────────
// Beaufort colour as [r,g,b,a] for deck.gl getColor.
export function beaufortRGBA(kn, a = 235) {
  const N = BEAUFORT_BANDS.length
  const x = Math.max(0, Math.min(0.999, (kn || 0) / PALETTE_MAX_KT))
  const pos = x * (N - 1); const i = Math.floor(pos); const t = pos - i
  const c0 = BEAUFORT_BANDS[i].c; const c1 = BEAUFORT_BANDS[Math.min(N - 1, i + 1)].c
  return [Math.round(c0[0] + (c1[0] - c0[0]) * t), Math.round(c0[1] + (c1[1] - c0[1]) * t), Math.round(c0[2] + (c1[2] - c0[2]) * t), a]
}

// A flat arrow mesh in the local XY plane pointing +X (east at yaw 0), for
// SimpleMeshLayer. Triangles: shaft rectangle + head triangle. z = 0 (laid flat).
export function arrowMesh() {
  const positions = new Float32Array([
    // shaft quad (two tris)
    -0.5, -0.09, 0, 0.18, -0.09, 0, 0.18, 0.09, 0,
    -0.5, -0.09, 0, 0.18, 0.09, 0, -0.5, 0.09, 0,
    // head tri
    0.18, -0.24, 0, 0.62, 0, 0, 0.18, 0.24, 0,
  ])
  const normals = new Float32Array(positions.length)
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1   // +Z up
  return { positions, normals }
}

/**
 * Build multi-level wind vectors from a field's RAW vertical stack (field.volume).
 * @param {object} volume { cellAt, heights, header }
 * @param {number} frameIdx
 * @param {number[]} levels  metres ASL to include (intersected with available heights)
 * @param {object} [o] { step } horizontal sub-sample (cells)
 * @returns {Array<{lon,lat,altM,kn,toward,band}>}
 */
export function buildProfileVectors(volume, frameIdx, levels, o = {}) {
  if (!volume?.cellAt) return []
  const { cellAt, heights, header } = volume
  const { nx, ny, lo1, la1, dx, dy } = header
  const avail = new Set((heights || []).map(Number))
  const lv = (levels || []).filter((h) => avail.has(Number(h)))
  const step = o.step || Math.max(1, Math.round(nx / 12))
  const out = []
  for (let j = 0; j < ny; j += step) {
    for (let i = 0; i < nx; i += step) {
      const c = cellAt[j * nx + i]; if (!c) continue
      const lon = lo1 + i * dx; const lat = la1 - j * dy
      for (const h of lv) {
        const sp = c.spd?.[String(h)]?.[frameIdx]; const di = c.dir?.[String(h)]?.[frameIdx]
        if (sp == null || di == null) continue
        const kn = sp * 0.539957             // km/h → kn
        if (kn < 0.4) continue
        out.push({ lon, lat, altM: Number(h), kn: Math.round(kn), toward: (di + 180) % 360, band: 0 })
      }
    }
  }
  return out
}

export function ringGeoJSON(lat, lon, nm) {
  const coords = []; const R = nm / 60; const cosLat = Math.cos((lat * Math.PI) / 180)
  for (let a = 0; a <= 360; a += 6) { const t = (a * Math.PI) / 180; coords.push([lon + (R / cosLat) * Math.sin(t), lat + R * Math.cos(t)]) }
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] }
}

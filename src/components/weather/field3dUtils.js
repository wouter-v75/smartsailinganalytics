// field3dUtils.js
// ----------------------------------------------------------------------------
// Shared helpers for the MapLibre 3D wind-field views (inline Field3D viewer +
// the deck-capture Venue3D tool). Pure functions — no React, no fetch.
// ----------------------------------------------------------------------------
import { BEAUFORT_BANDS, PALETTE_MAX_KT, speedImageURL, scalarImageURL, currentRamp, hpblRamp, hpblContourSegments } from './windField'

// TWS contour levels (kn) for the 3D shading
export const TWS_CONTOUR_KN = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 35]

export const MAPLIBRE_JS = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js'
export const MAPLIBRE_CSS = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css'
export const DECK_JS = 'https://unpkg.com/deck.gl@9.0.36/dist.min.js'   // exposes window.deck (incl. MapboxOverlay, SimpleMeshLayer)
// default vertical levels shown in the 3D multi-level view (metres ASL).
// Intersected with whatever the grid.json publishes; 300/500/900 appear once the
// box re-runs with the extended _hl stream.
export const DEFAULT_LEVELS = [10, 30, 100]
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
  // opts.step overrides the default subsample (1 = every native grid cell).
  const step = opts.step ? Math.max(1, Math.round(opts.step)) : Math.max(1, Math.round(nx / 16))
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
export const drapeOpacity = (field) => (field?.isHpbl ? 0.5 : field?.isCurrent ? 0.45 : 0.28)
// image-source corner coordinates (TL, TR, BR, BL) from the field bounding box
export const boxCoords = (box) => [[box.west, box.north], [box.east, box.north], [box.east, box.south], [box.west, box.south]]

// single-level surface vectors (for non-volume fields) — same shape as
// buildProfileVectors but from the frame's u/v at one notional altitude.
export function buildSurfaceVectors(field, frameIdx, o = {}) {
  const fr = field?.frames?.[frameIdx]; if (!fr?.u) return []
  const { nx, ny, lo1, la1, dx, dy } = field.header
  const step = o.step || Math.max(1, Math.round(nx / 16))
  const minKn = o.minKn ?? 0.6
  const altM = o.altM ?? 15
  const out = []
  for (let j = 0; j < ny; j += step) {
    for (let i = 0; i < nx; i += step) {
      const p = j * nx + i; const u = fr.u[p]; const v = fr.v[p]
      const kn = Math.hypot(u || 0, v || 0) * KN
      if (kn < minKn) continue
      out.push({ lon: lo1 + i * dx, lat: la1 - j * dy, altM, kn: Math.round(kn), toward: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360 })
    }
  }
  return out
}

// Sample the vertical stack (field.volume) at the nearest grid cell + nearest
// published height to `targetH` — used so the cursor readout can report MAST
// height regardless of the displayed field height. Returns { kt, dirTrue }.
export function sampleVolumeAtHeight(volume, frameIdx, targetH, lat, lon) {
  if (!volume?.cellAt || !volume.heights?.length) return null
  const { cellAt, heights, header } = volume
  const { nx, ny, lo1, la1, dx, dy } = header
  let h = heights[0]
  for (const hh of heights) if (Math.abs(hh - targetH) < Math.abs(h - targetH)) h = hh
  const i = Math.round((lon - lo1) / dx); const j = Math.round((la1 - lat) / dy)
  if (i < 0 || j < 0 || i >= nx || j >= ny) return null
  const c = cellAt[j * nx + i]; if (!c) return null
  const sp = c.spd?.[String(h)]?.[frameIdx]; const di = c.dir?.[String(h)]?.[frameIdx]
  if (sp == null || di == null) return null
  return { kt: sp * 0.539957, dirTrue: di, usedH: h }   // spd km/h -> kn; dir = met FROM bearing
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

// Numbered, colour-coded point markers AS MAP LAYERS (so they're captured into
// the canvas — DOM markers aren't). Each marker is a generated RGBA icon: a
// coloured disc with a white ring + the point number.
function addPointMarkers(map, points) {
  const feats = []
  for (const p of (points || [])) {
    if (p.lat == null || p.lon == null) continue
    const id = `ptmark-${p.key}`
    try {
      if (!map.hasImage(id) && typeof document !== 'undefined') {
        const N = 64, cv = document.createElement('canvas'); cv.width = cv.height = N
        const ctx = cv.getContext('2d')
        ctx.beginPath(); ctx.arc(N / 2, N / 2, N / 2 - 6, 0, 2 * Math.PI)
        ctx.fillStyle = p.color || '#38BDF8'; ctx.fill()
        ctx.lineWidth = 5; ctx.strokeStyle = '#ffffff'; ctx.stroke()
        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 34px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(String(p.key), N / 2, N / 2 + 1)
        const img = ctx.getImageData(0, 0, N, N)
        map.addImage(id, { width: N, height: N, data: new Uint8Array(img.data.buffer) })
      }
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { icon: id } })
    } catch { /* */ }
  }
  if (!feats.length) return
  map.addSource('ptmarks', { type: 'geojson', data: { type: 'FeatureCollection', features: feats } })
  map.addLayer({ id: 'ptmarks', type: 'symbol', source: 'ptmarks', layout: { 'icon-image': ['get', 'icon'], 'icon-size': 0.55, 'icon-allow-overlap': true, 'icon-ignore-placement': true } })
}

// Render a field on an OFFSCREEN MapLibre 3D map and capture PNG stills at a set
// of frame indices (used by the deck for the 4×3D "general weather" snapshots).
// Reuses one map: builds terrain+drape+arrows once, then per frame updates the
// sources, re-orients upwind, waits for idle, and captures. Returns [{idx,png}].
export async function captureField3DSeries(ML, field, opts) {
  const { lat, lon, width = 760, height = 460, exaggeration = 3, frameIndices = [], zoom = 10.4, arrowStep, ringNm = 5, points } = opts || {}
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
      center: [lon, lat], zoom, pitch: 66, bearing: twd0 != null ? twd0 : 0,
      preserveDrawingBuffer: true, attributionControl: false, interactive: false, fadeDuration: 0,
    })
    const idle = () => new Promise((res) => { let done = false; const f = () => { if (done) return; done = true; res() }; map.once('idle', f); setTimeout(f, 4000) })
    await new Promise((res) => { let done = false; const f = () => { if (done) return; done = true; res() }; map.on('load', f); setTimeout(f, 9000) })
    map.addSource('dem', { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 })
    map.setTerrain({ source: 'dem', exaggeration })
    // Speed drape. Render it as a FLAT (sea-level) deck.gl BitmapLayer so it
    // stays aligned with the wind arrows — a MapLibre raster image gets draped
    // over the 3× terrain and stretches out of the field box. Fall back to the
    // terrain-draped raster only if deck.gl isn't available.
    // FLAT (sea-level) deck.gl overlay: the speed drape PLUS the TWS contour
    // lines + labels — both rendered flat so they stay aligned with the arrows
    // (a terrain-draped raster stretches over the 3× terrain). Falls back to a
    // raster drape (no contours) only if deck.gl isn't available.
    const useDeckDrape = !!window.deck?.MapboxOverlay
    let drapeOverlay = null
    // depthCompare 'always' so the flat sea-level layers draw on top of the
    // terrain (not occluded by the sea-level DEM) and stay visible in the shot.
    const flatParams = { depthCompare: 'always', depthWriteEnabled: false, depthTest: false }
    const overlayLayersFor = (fidx) => {
      const layers = []
      const u = drapeImageURL(field, fidx)
      if (u) layers.push(new window.deck.BitmapLayer({ id: 'drape-bmp', image: u, bounds: [field.box.west, field.box.south, field.box.east, field.box.north], opacity: drapeOpacity(field), parameters: flatParams }))
      if (kind !== 'hpbl') {
        const { paths, labels } = buildContoursKn(field, fidx, TWS_CONTOUR_KN)
        if (paths.length) layers.push(new window.deck.PathLayer({ id: 'tws-contours', data: paths, getPath: (d) => d.path, getColor: [20, 30, 46, 190], getWidth: (d) => (d.major ? 2.0 : 1.1), widthUnits: 'pixels', widthMinPixels: 0.9, capRounded: true, jointRounded: true, pickable: false, parameters: flatParams }))
        if (labels.length) layers.push(new window.deck.TextLayer({ id: 'tws-labels', data: labels, getPosition: (d) => [d.position[0], d.position[1], 60 * exaggeration], getText: (d) => d.text, getSize: 12, sizeUnits: 'pixels', getColor: [255, 255, 255, 255], background: true, getBackgroundColor: [10, 18, 28, 150], backgroundPadding: [3, 1, 3, 1], billboard: true, getTextAnchor: 'middle', getAlignmentBaseline: 'center', fontWeight: 700, pickable: false }))
      }
      return layers
    }
    if (useDeckDrape) {
      // interleaved:true renders deck INTO the basemap GL canvas, so the drape +
      // contours are part of map.getCanvas().toDataURL() (interleaved:false uses a
      // separate canvas that the screenshot misses).
      drapeOverlay = new window.deck.MapboxOverlay({ interleaved: true, layers: overlayLayersFor(frameIndices[0]) })
      map.addControl(drapeOverlay)
    } else {
      const url0 = drapeImageURL(field, frameIndices[0])
      if (url0) { map.addSource('drape', { type: 'image', url: url0, coordinates: boxCoords(field.box) }); map.addLayer({ id: 'drape', type: 'raster', source: 'drape', paint: { 'raster-opacity': drapeOpacity(field) } }) }
    }
    if (kind !== 'hpbl') {
      addArrowIcons(map)
      map.addSource('wind', { type: 'geojson', data: fieldToGeoJSON(field, frameIndices[0], { minKn, step: arrowStep }) })
      map.addLayer({ id: 'wind', type: 'symbol', source: 'wind', layout: { 'icon-image': kind === 'current' ? 'arrow-mono' : ['concat', 'arrow-', ['to-string', ['get', 'band']]], 'icon-rotate': ['get', 'toward'], 'icon-rotation-alignment': 'map', 'icon-size': ['interpolate', ['linear'], ['get', 'spd'], 0, 0.4, 30, 1.1], 'icon-allow-overlap': true, 'icon-ignore-placement': true } })
    }
    map.addSource('ring', { type: 'geojson', data: ringGeoJSON(lat, lon, ringNm) })
    map.addLayer({ id: 'ring', type: 'line', source: 'ring', paint: { 'line-color': '#ef4444', 'line-width': 2, 'line-dasharray': [2, 1.5] } })
    addPointMarkers(map, points)
    await idle()
    for (const fidx of frameIndices) {
      const twd = kind !== 'hpbl' ? meanFromDir(field, fidx, lat, lon, 5) : null
      if (twd != null) map.setBearing(twd)
      if (drapeOverlay) drapeOverlay.setProps({ layers: overlayLayersFor(fidx) })
      else { const u2 = drapeImageURL(field, fidx); const ds = map.getSource('drape'); if (ds && u2) ds.updateImage({ url: u2, coordinates: boxCoords(field.box) }) }
      const ws = map.getSource('wind'); if (ws) ws.setData(fieldToGeoJSON(field, fidx, { minKn, step: arrowStep }))
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

// TWS iso-speed contour lines (kn) of the selected-height frame, as lng/lat paths
// + label points, for the 3D shading. Reuses the marching-squares from windField.
// light box-blur of a scalar grid (rounder contours)
function blurScalar(s, nx, ny, passes = 2) {
  let cur = s
  for (let k = 0; k < passes; k++) {
    const out = new Float32Array(nx * ny)
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let sum = 0; let n = 0
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const xx = x + i; const yy = y + j; if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue; sum += cur[yy * nx + xx]; n++ }
        out[y * nx + x] = sum / n
      }
    }
    cur = out
  }
  return cur
}

export function buildContoursKn(field, frameIdx, levels = TWS_CONTOUR_KN) {
  const fr = field?.frames?.[frameIdx]; if (!fr?.u) return { paths: [], labels: [] }
  const { nx, ny, lo1, la1, dx, dy } = field.header
  let scalar = new Float32Array(nx * ny)
  let mn = Infinity; let mx = -Infinity
  for (let p = 0; p < nx * ny; p++) { const s = Math.hypot(fr.u[p] || 0, fr.v[p] || 0) * KN; scalar[p] = s; if (s < mn) mn = s; if (s > mx) mx = s }
  scalar = blurScalar(scalar, nx, ny, 2)
  const toLL = (x, y) => [lo1 + x * dx, la1 - y * dy, 0]
  const paths = []; const labels = []
  for (const lev of levels) {
    if (lev < mn || lev > mx) continue
    const segs = hpblContourSegments(scalar, field.header, lev)
    if (!segs.length) continue
    const major = lev % 10 === 0
    for (const s of segs) paths.push({ path: [toLL(s[0][0], s[0][1]), toLL(s[1][0], s[1][1])], major })
    const step = Math.max(1, Math.floor(segs.length / 3)); let placed = 0
    for (let i = 0; i < segs.length && placed < 2; i += step) {
      const s = segs[i]
      labels.push({ position: toLL((s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2), text: String(lev) }); placed++
    }
  }
  return { paths, labels }
}

export function ringGeoJSON(lat, lon, nm) {
  const coords = []; const R = nm / 60; const cosLat = Math.cos((lat * Math.PI) / 180)
  for (let a = 0; a <= 360; a += 6) { const t = (a * Math.PI) / 180; coords.push([lon + (R / cosLat) * Math.sin(t), lat + R * Math.cos(t)]) }
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] }
}

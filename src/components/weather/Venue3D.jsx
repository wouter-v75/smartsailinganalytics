// Venue3D.jsx
// ----------------------------------------------------------------------------
// PROTOTYPE — "Strategic considerations" 3D venue view. Renders a pitched 3D
// terrain (MapLibre GL + AWS terrarium DEM + ESRI World Imagery satellite drape)
// and overlays the 1 km wind field as Beaufort-coloured arrows rotated by wind
// direction — the auto-generated equivalent of the hand-annotated Google-Earth
// obliques in the reference Keynote. Rotate/tilt to frame it, then Capture PNG
// for the deck.
//
// Admin-only. MapLibre is lazy-loaded from CDN (kept out of the main bundle).
// ----------------------------------------------------------------------------
import React, { useEffect, useRef, useState } from 'react'
import { useScriptsOnce } from './useScriptOnce'
import { MODELS } from './openMeteo'
import { BEAUFORT_BANDS, PALETTE_MAX_KT, fetchWindField, fetchIconRaceField } from './windField'

const MAPLIBRE_JS = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js'
const MAPLIBRE_CSS = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css'
const SAT_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const DEM_TILES = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'
const KN = 1.94384

const PREFERRED = ['ICONRACE', 'ICONRACE_1KM', 'AROME', 'AROME_HD', 'ECMWF', 'ICON', 'ITALIA', 'DMI', 'ARPEGE']

// One arrow icon (pointing NORTH / up) per Beaufort band, drawn on a canvas so we
// can tint it; MapLibre rotates it per-feature via icon-rotate.
function arrowIcon(rgb, size = 50) {
  const c = document.createElement('canvas'); c.width = size; c.height = size
  const x = c.getContext('2d'); x.translate(size / 2, size / 2)
  const hex = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
  x.strokeStyle = 'rgba(10,15,25,0.65)'; x.lineWidth = Math.max(1, size * 0.03)
  // shaft
  x.beginPath(); x.moveTo(0, size * 0.34); x.lineTo(0, -size * 0.06)
  x.lineWidth = size * 0.1; x.strokeStyle = hex; x.stroke()
  // head
  x.beginPath(); x.moveTo(0, -size * 0.42); x.lineTo(size * 0.2, size * 0.04); x.lineTo(0, -size * 0.08); x.lineTo(-size * 0.2, size * 0.04)
  x.closePath(); x.fillStyle = hex; x.fill()
  x.strokeStyle = 'rgba(10,15,25,0.65)'; x.lineWidth = Math.max(1, size * 0.025); x.stroke()
  return { width: size, height: size, data: x.getImageData(0, 0, size, size).data }
}
const bandOf = (kn) => {
  const N = BEAUFORT_BANDS.length
  return Math.max(0, Math.min(N - 1, Math.floor(Math.max(0, Math.min(0.999, (kn || 0) / PALETTE_MAX_KT)) * (N - 1))))
}

// mean TWD (meteorological FROM bearing) over the race area for one frame — used
// to orient the camera UPWIND (we look toward where the wind comes from).
function meanFromDir(field, frameIdx, lat, lon, nm) {
  const fr = field?.frames?.[frameIdx]; if (!fr) return null
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
  return ((toward + 180) % 360 + 360) % 360   // FROM bearing (TWD)
}

// wind field frame → GeoJSON arrow points (subsampled, skips calm/no-data cells)
function fieldToGeoJSON(field, frameIdx) {
  const fr = field?.frames?.[frameIdx]; if (!fr) return { type: 'FeatureCollection', features: [] }
  const { nx, ny, lo1, la1, dx, dy } = field.header
  const step = Math.max(1, Math.round(nx / 16))
  const features = []
  for (let j = 0; j < ny; j += step) {
    for (let i = 0; i < nx; i += step) {
      const p = j * nx + i; const u = fr.u[p]; const v = fr.v[p]
      const spd = Math.hypot(u || 0, v || 0) * KN
      if (spd < 0.6) continue
      const toward = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360   // bearing wind blows TOWARD
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lo1 + i * dx, la1 - j * dy] },
        properties: { spd: Math.round(spd), band: bandOf(spd), toward: Math.round(toward) },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

export default function Venue3D({ p1lat, p1lon, resolvedTz = 'UTC', mastHeight = 20, modelAvailable = [] }) {
  const ready = useScriptsOnce([MAPLIBRE_JS], [MAPLIBRE_CSS])
  const mapRef = useRef(null)
  const divRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [img, setImg] = useState(null)
  const [model, setModel] = useState('')
  const [hour, setHour] = useState(12)
  const [exag, setExag] = useState(3)

  const avail = PREFERRED.filter((k) => (modelAvailable.includes ? modelAvailable.includes(k) : true))
  const modelKey = model || avail[0] || 'ICONRACE'

  useEffect(() => () => { try { mapRef.current?.remove() } catch { /* */ } }, [])

  async function render() {
    setErr(''); setImg(null); setBusy(true)
    try {
      const ML = window.maplibregl; if (!ML) throw new Error('map engine loading — retry')
      if (p1lat == null || p1lon == null) throw new Error('pick race point 1 first')
      // fetch the wind field for the venue
      const field = modelKey.startsWith('ICONRACE')
        ? await fetchIconRaceField({ lat: p1lat, lon: p1lon, height: mastHeight, timezone: resolvedTz, modelKey })
        : (MODELS[modelKey]?.endpoint ? await fetchWindField({ modelKey, lat: p1lat, lon: p1lon, height: mastHeight, timezone: resolvedTz }) : null)
      if (!field?.frames?.length) throw new Error(`no wind field for ${modelKey}`)
      const stamps = field.stamps || field.labels || []
      let fi = stamps.findIndex((s) => String(s).includes(`${String(hour).padStart(2, '0')}:`))
      if (fi < 0) fi = Math.floor(field.frames.length / 2)
      const geo = fieldToGeoJSON(field, fi)
      // orient the camera UPWIND: look TOWARD where the wind comes from (TWD)
      const twd = meanFromDir(field, fi, p1lat, p1lon, 5)
      const bearing = twd != null ? twd : 0

      try { mapRef.current?.remove() } catch { /* */ }
      const map = new ML.Map({
        container: divRef.current,
        style: {
          version: 8,
          sources: { sat: { type: 'raster', tiles: [SAT_TILES], tileSize: 256, maxzoom: 19, attribution: 'Esri World Imagery' } },
          layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
        },
        center: [p1lon, p1lat], zoom: 10.5, pitch: 68, bearing,
        preserveDrawingBuffer: true, attributionControl: true,
      })
      mapRef.current = map
      map.addControl(new ML.NavigationControl({ visualizePitch: true }), 'top-right')
      await new Promise((res) => map.on('load', res))

      // 3D terrain
      map.addSource('dem', { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14, attribution: 'Mapzen/AWS terrain' })
      map.setTerrain({ source: 'dem', exaggeration: exag })

      // arrow icons per Beaufort band
      BEAUFORT_BANDS.forEach((b, i) => { const id = `arrow-${i}`; if (!map.hasImage(id)) map.addImage(id, arrowIcon(b.c)) })

      map.addSource('wind', { type: 'geojson', data: geo })
      map.addLayer({
        id: 'wind', type: 'symbol', source: 'wind',
        layout: {
          'icon-image': ['concat', 'arrow-', ['to-string', ['get', 'band']]],
          'icon-rotate': ['get', 'toward'],
          'icon-rotation-alignment': 'map',
          'icon-size': ['interpolate', ['linear'], ['get', 'spd'], 0, 0.4, 30, 1.1],
          'icon-allow-overlap': true, 'icon-ignore-placement': true,
        },
      })
      // 5 nm race-area ring on point 1
      map.addSource('ring', { type: 'geojson', data: ringGeoJSON(p1lat, p1lon, 5) })
      map.addLayer({ id: 'ring', type: 'line', source: 'ring', paint: { 'line-color': '#ef4444', 'line-width': 2, 'line-dasharray': [2, 1.5] } })
    } catch (e) { setErr(e?.message || 'render failed') } finally { setBusy(false) }
  }

  function capture() {
    try {
      const map = mapRef.current; if (!map) return
      map.triggerRepaint()
      requestAnimationFrame(() => { try { setImg(map.getCanvas().toDataURL('image/png')) } catch (e) { setErr('capture failed: ' + (e?.message || e)) } })
    } catch (e) { setErr('capture failed') }
  }

  return (
    <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 12, marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0', alignSelf: 'center' }}>🏔️ 3D venue view (prototype)</div>
        <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
          <span style={lbl}>Model</span>
          <select value={modelKey} onChange={(e) => setModel(e.target.value)} style={input} disabled={busy}>
            {avail.map((k) => <option key={k} value={k}>{MODELS[k]?.label || k}</option>)}
          </select>
        </label>
        <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
          <span style={lbl}>Hour (local)</span>
          <select value={hour} onChange={(e) => setHour(+e.target.value)} style={input} disabled={busy}>
            {[9, 10, 11, 12, 13, 14, 15, 16, 17].map((h) => <option key={h} value={h}>{h}:00</option>)}
          </select>
        </label>
        <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
          <span style={lbl}>Vert. ×</span>
          <select value={exag} onChange={(e) => setExag(+e.target.value)} style={input} disabled={busy}>
            {[1, 1.5, 2, 3, 4, 5].map((x) => <option key={x} value={x}>{x}×</option>)}
          </select>
        </label>
        <button onClick={render} disabled={busy || !ready} style={btn}>{busy ? 'Rendering…' : ready ? 'Render' : 'Loading map…'}</button>
        <button onClick={capture} disabled={busy} style={{ ...btn, background: '#0EA5E9' }}>Capture PNG</button>
      </div>
      {err && <div style={{ color: '#FCA5A5', fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <div ref={divRef} style={{ width: '100%', height: 460, borderRadius: 8, overflow: 'hidden', background: '#071624' }} />
      <div style={{ fontSize: 11, color: '#64748B', marginTop: 6 }}>View is oriented UPWIND (looking toward the TWD). Vert. exaggeration ×{exag}. Drag/right-drag to adjust, then Capture PNG. Arrows = {modelKey} wind @ {hour}:00, Beaufort-coloured; red dashed = 5 nm race area.</div>
      {img && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 4 }}>Captured still (right-click → Save, or drag into the deck):</div>
          <img src={img} alt="3D venue capture" style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid #1E3A5A' }} />
        </div>
      )}
    </div>
  )
}

function ringGeoJSON(lat, lon, nm) {
  const coords = []; const R = nm / 60; const cosLat = Math.cos((lat * Math.PI) / 180)
  for (let a = 0; a <= 360; a += 6) { const t = (a * Math.PI) / 180; coords.push([lon + (R / cosLat) * Math.sin(t), lat + R * Math.cos(t)]) }
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] }
}

const lbl = { fontSize: 11, color: '#94A3B8', fontWeight: 600 }
const input = { background: '#0F2438', color: '#E2E8F0', border: '1px solid #1E3A5A', borderRadius: 6, padding: '6px 8px', fontSize: 13 }
const btn = { background: '#1E3A5A', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }

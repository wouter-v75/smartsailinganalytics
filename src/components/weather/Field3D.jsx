// Field3D.jsx
// ----------------------------------------------------------------------------
// Inline 3D field viewer for the Forecast tab. Consumes the ALREADY-FETCHED
// `field` (no network) and renders it on MapLibre 3D terrain (AWS terrarium DEM +
// ESRI satellite drape). The field's colour image (wind speed / current / HPBL)
// is DRAPED on the terrain; wind & current additionally get direction arrows.
// The shared time bar drives `frameIdx` — we update drape + arrows in place.
// Camera orients UPWIND; drag/right-drag to rotate & tilt.
// ----------------------------------------------------------------------------
import React, { useEffect, useRef, useState } from 'react'
import { useScriptsOnce } from './useScriptOnce'
import {
  MAPLIBRE_JS, MAPLIBRE_CSS, SAT_TILES, DEM_TILES,
  addArrowIcons, fieldToGeoJSON, meanFromDir, ringGeoJSON,
  fieldKind, drapeImageURL, drapeOpacity, boxCoords,
} from './field3dUtils'

export default function Field3D({ field, frameIdx = 0, p1lat, p1lon, height = 640, exaggeration = 3 }) {
  const ready = useScriptsOnce([MAPLIBRE_JS], [MAPLIBRE_CSS])
  const divRef = useRef(null)
  const mapRef = useRef(null)
  const loadedRef = useRef(false)
  const [err, setErr] = useState('')
  const fi = field?.frames?.length ? Math.min(frameIdx, field.frames.length - 1) : 0
  const kind = fieldKind(field)

  useEffect(() => {
    if (!ready || !divRef.current || !field?.frames?.length || mapRef.current) return
    const ML = window.maplibregl
    if (!ML) { setErr('map engine unavailable'); return }
    const lat = p1lat ?? field.header.la1; const lon = p1lon ?? field.header.lo1
    const twd = kind !== 'hpbl' ? meanFromDir(field, fi, lat, lon, 5) : null
    let map
    try {
      map = new ML.Map({
        container: divRef.current,
        style: { version: 8, sources: { sat: { type: 'raster', tiles: [SAT_TILES], tileSize: 256, maxzoom: 19, attribution: 'Esri World Imagery' } }, layers: [{ id: 'sat', type: 'raster', source: 'sat' }] },
        center: [lon, lat], zoom: 10.4, pitch: 60, bearing: twd != null ? twd : 0,
        maxPitch: 85, preserveDrawingBuffer: true, attributionControl: true,
      })
    } catch (e) { setErr(e?.message || 'map init failed'); return }
    mapRef.current = map
    map.addControl(new ML.NavigationControl({ visualizePitch: true }), 'top-right')
    map.on('load', () => {
      try {
        map.addSource('dem', { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 })
        map.setTerrain({ source: 'dem', exaggeration })
        // draped colour surface (wind speed / current / hpbl)
        const url = drapeImageURL(field, fi)
        if (url) {
          map.addSource('drape', { type: 'image', url, coordinates: boxCoords(field.box) })
          map.addLayer({ id: 'drape', type: 'raster', source: 'drape', paint: { 'raster-opacity': drapeOpacity(field), 'raster-resampling': 'linear' } })
        }
        // arrows (wind & current only)
        if (kind !== 'hpbl') {
          addArrowIcons(map)
          map.addSource('wind', { type: 'geojson', data: fieldToGeoJSON(field, fi, { minKn: kind === 'current' ? 0.2 : 0.6 }) })
          map.addLayer({
            id: 'wind', type: 'symbol', source: 'wind',
            layout: {
              'icon-image': kind === 'current' ? 'arrow-mono' : ['concat', 'arrow-', ['to-string', ['get', 'band']]],
              'icon-rotate': ['get', 'toward'], 'icon-rotation-alignment': 'map',
              'icon-size': ['interpolate', ['linear'], ['get', 'spd'], 0, 0.4, 30, 1.1],
              'icon-allow-overlap': true, 'icon-ignore-placement': true,
            },
          })
        }
        if (p1lat != null && p1lon != null) {
          map.addSource('ring', { type: 'geojson', data: ringGeoJSON(p1lat, p1lon, 5) })
          map.addLayer({ id: 'ring', type: 'line', source: 'ring', paint: { 'line-color': '#ef4444', 'line-width': 2, 'line-dasharray': [2, 1.5] } })
        }
        loadedRef.current = true
      } catch (e) { setErr(e?.message || 'layer build failed') }
    })
    return () => { try { map.remove() } catch { /* */ } mapRef.current = null; loadedRef.current = false }
  }, [ready, field]) // eslint-disable-line react-hooks/exhaustive-deps

  // update drape + arrows when the time index changes (no rebuild)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    try {
      const url = drapeImageURL(field, fi)
      const ds = map.getSource('drape'); if (ds && url) ds.updateImage({ url, coordinates: boxCoords(field.box) })
      const ws = map.getSource('wind'); if (ws) ws.setData(fieldToGeoJSON(field, fi, { minKn: kind === 'current' ? 0.2 : 0.6 }))
    } catch { /* */ }
  }, [fi, field, kind])

  useEffect(() => {
    const map = mapRef.current
    if (map && loadedRef.current) { try { map.setTerrain({ source: 'dem', exaggeration }) } catch { /* */ } }
  }, [exaggeration])

  const rotateBy = (d) => { const m = mapRef.current; if (m) m.easeTo({ bearing: m.getBearing() + d, duration: 300 }) }
  const tiltBy = (d) => { const m = mapRef.current; if (m) m.easeTo({ pitch: Math.max(0, Math.min(85, m.getPitch() + d)), duration: 300 }) }
  const setPitch = (p) => { const m = mapRef.current; if (m) m.easeTo({ pitch: p, duration: 350 }) }

  return (
    <div style={{ position: 'relative', width: '100%', height }}>
      <div ref={divRef} style={{ width: '100%', height: '100%', borderRadius: 8, overflow: 'hidden', background: '#071624', border: '1px solid #1E3A5A' }} />
      {/* explicit view controls (don't rely on right-drag gesture) */}
      <div style={{ position: 'absolute', left: 8, bottom: 8, display: 'flex', gap: 5, flexWrap: 'wrap', maxWidth: 'calc(100% - 16px)' }}>
        <button onClick={() => rotateBy(-30)} title="Rotate left" style={c3dBtn}>⟲</button>
        <button onClick={() => rotateBy(30)} title="Rotate right" style={c3dBtn}>⟳</button>
        <button onClick={() => tiltBy(12)} title="Tilt toward horizontal" style={c3dBtn}>tilt ↑</button>
        <button onClick={() => tiltBy(-12)} title="Tilt toward top-down" style={c3dBtn}>tilt ↓</button>
        <button onClick={() => setPitch(0)} title="Top-down view" style={c3dBtn}>Top</button>
        <button onClick={() => setPitch(72)} title="Low oblique (horizon) view" style={c3dBtn}>Horizon</button>
      </div>
      {!ready && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748B', fontSize: 12 }}>Loading 3D map…</div>}
      {err && <div style={{ position: 'absolute', left: 8, top: 8, color: '#FCA5A5', fontSize: 11, background: 'rgba(3,15,26,0.8)', padding: '3px 8px', borderRadius: 6 }}>{err}</div>}
    </div>
  )
}
const c3dBtn = { background: 'rgba(8,22,38,0.9)', color: '#E2E8F0', border: '1px solid #1E3A5A', borderRadius: 6, padding: '5px 9px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }

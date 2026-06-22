// Field3D.jsx
// ----------------------------------------------------------------------------
// Inline 3D wind-field viewer for the Forecast tab. Consumes the ALREADY-FETCHED
// `field` (no network) and renders it on MapLibre 3D terrain (AWS terrarium DEM +
// ESRI satellite drape) as Beaufort-coloured arrows. The shared time bar drives
// `frameIdx`; we update the arrow source in place (no map rebuild) as it changes.
// Camera is oriented UPWIND (toward the TWD); drag/right-drag to rotate & tilt.
// ----------------------------------------------------------------------------
import React, { useEffect, useRef, useState } from 'react'
import { useScriptsOnce } from './useScriptOnce'
import { MAPLIBRE_JS, MAPLIBRE_CSS, SAT_TILES, DEM_TILES, addArrowIcons, fieldToGeoJSON, meanFromDir, ringGeoJSON } from './field3dUtils'

export default function Field3D({ field, frameIdx = 0, p1lat, p1lon, height = 640, exaggeration = 3 }) {
  const ready = useScriptsOnce([MAPLIBRE_JS], [MAPLIBRE_CSS])
  const divRef = useRef(null)
  const mapRef = useRef(null)
  const loadedRef = useRef(false)
  const [err, setErr] = useState('')
  const fi = field?.frames?.length ? Math.min(frameIdx, field.frames.length - 1) : 0

  // build the map once the engine + container + field are ready
  useEffect(() => {
    if (!ready || !divRef.current || !field?.frames?.length || mapRef.current) return
    const ML = window.maplibregl
    if (!ML) { setErr('map engine unavailable'); return }
    const lat = p1lat ?? field.header.la1; const lon = p1lon ?? field.header.lo1
    const twd = meanFromDir(field, fi, lat, lon, 5)
    let map
    try {
      map = new ML.Map({
        container: divRef.current,
        style: {
          version: 8,
          sources: { sat: { type: 'raster', tiles: [SAT_TILES], tileSize: 256, maxzoom: 19, attribution: 'Esri World Imagery' } },
          layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
        },
        center: [lon, lat], zoom: 10.4, pitch: 66, bearing: twd != null ? twd : 0,
        preserveDrawingBuffer: true, attributionControl: true,
      })
    } catch (e) { setErr(e?.message || 'map init failed'); return }
    mapRef.current = map
    map.addControl(new ML.NavigationControl({ visualizePitch: true }), 'top-right')
    map.on('load', () => {
      try {
        map.addSource('dem', { type: 'raster-dem', tiles: [DEM_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14, attribution: 'Mapzen/AWS terrain' })
        map.setTerrain({ source: 'dem', exaggeration })
        addArrowIcons(map)
        map.addSource('wind', { type: 'geojson', data: fieldToGeoJSON(field, fi) })
        map.addLayer({
          id: 'wind', type: 'symbol', source: 'wind',
          layout: {
            'icon-image': ['concat', 'arrow-', ['to-string', ['get', 'band']]],
            'icon-rotate': ['get', 'toward'], 'icon-rotation-alignment': 'map',
            'icon-size': ['interpolate', ['linear'], ['get', 'spd'], 0, 0.4, 30, 1.1],
            'icon-allow-overlap': true, 'icon-ignore-placement': true,
          },
        })
        if (p1lat != null && p1lon != null) {
          map.addSource('ring', { type: 'geojson', data: ringGeoJSON(p1lat, p1lon, 5) })
          map.addLayer({ id: 'ring', type: 'line', source: 'ring', paint: { 'line-color': '#ef4444', 'line-width': 2, 'line-dasharray': [2, 1.5] } })
        }
        loadedRef.current = true
      } catch (e) { setErr(e?.message || 'layer build failed') }
    })
    return () => { try { map.remove() } catch { /* */ } mapRef.current = null; loadedRef.current = false }
  }, [ready, field]) // eslint-disable-line react-hooks/exhaustive-deps

  // update arrows in place when the time index changes (no rebuild)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    const src = map.getSource('wind')
    if (src) src.setData(fieldToGeoJSON(field, fi))
  }, [fi, field])

  // update terrain exaggeration live
  useEffect(() => {
    const map = mapRef.current
    if (map && loadedRef.current) { try { map.setTerrain({ source: 'dem', exaggeration }) } catch { /* */ } }
  }, [exaggeration])

  return (
    <div style={{ position: 'relative', width: '100%', height }}>
      <div ref={divRef} style={{ width: '100%', height: '100%', borderRadius: 8, overflow: 'hidden', background: '#071624', border: '1px solid #1E3A5A' }} />
      {!ready && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748B', fontSize: 12 }}>Loading 3D map…</div>}
      {err && <div style={{ position: 'absolute', left: 8, bottom: 8, color: '#FCA5A5', fontSize: 11, background: 'rgba(3,15,26,0.8)', padding: '3px 8px', borderRadius: 6 }}>{err}</div>}
    </div>
  )
}

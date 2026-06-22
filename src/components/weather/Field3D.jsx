// Field3D.jsx
// ----------------------------------------------------------------------------
// Inline 3D field viewer for the Forecast tab. MapLibre 3D terrain (AWS DEM +
// ESRI satellite) with the field's colour image DRAPED on the terrain. For
// SSA-Race fields that carry the full vertical stack (field.volume), it renders
// MULTI-LEVEL wind arrows at true altitude via deck.gl (SimpleMeshLayer,
// interleaved) — a 3D meteogram of the vertical shear. Other fields fall back to
// flat single-level arrows. Shared time bar drives the frame; on-screen controls
// rotate/tilt and toggle levels. Camera orients upwind.
// ----------------------------------------------------------------------------
import React, { useEffect, useRef, useState } from 'react'
import { useScriptsOnce } from './useScriptOnce'
import {
  MAPLIBRE_JS, MAPLIBRE_CSS, DECK_JS, DEFAULT_LEVELS, SAT_TILES, DEM_TILES,
  addArrowIcons, fieldToGeoJSON, meanFromDir, ringGeoJSON,
  fieldKind, drapeImageURL, drapeOpacity, boxCoords,
  buildProfileVectors, beaufortRGBA,
} from './field3dUtils'

export default function Field3D({ field, frameIdx = 0, p1lat, p1lon, height = 640, exaggeration = 3 }) {
  const ready = useScriptsOnce([MAPLIBRE_JS, DECK_JS], [MAPLIBRE_CSS])
  const divRef = useRef(null)
  const mapRef = useRef(null)
  const overlayRef = useRef(null)
  const loadedRef = useRef(false)
  const [err, setErr] = useState('')
  const fi = field?.frames?.length ? Math.min(frameIdx, field.frames.length - 1) : 0
  const kind = fieldKind(field)
  const heights = field?.volume?.heights || []
  const hasVolume = !!field?.volume?.cellAt && kind === 'wind'
  const [levels, setLevels] = useState(() => DEFAULT_LEVELS.filter((h) => heights.includes(h)))

  // Arrows as PathLayer polylines (shaft + 2 head segments) — positions computed
  // directly in [lng,lat,altitude], so no mesh/orientation ambiguity. Length ∝
  // speed, colour ∝ Beaufort, drawn at each selected altitude (× exaggeration).
  const D2R = Math.PI / 180
  const windLayer = () => {
    if (!hasVolume || !window.deck || !levels.length) return []
    const data = buildProfileVectors(field.volume, fi, levels)
    const lat0 = p1lat ?? field.header.la1
    const cosLat = Math.cos(lat0 * D2R) || 1
    const pathOf = (d) => {
      const z = d.altM * exaggeration
      const L = 0.014 * Math.max(0.45, Math.min(2.1, d.kn / 11))      // shaft length (deg)
      const tR = d.toward * D2R; const e = Math.sin(tR) / cosLat; const n = Math.cos(tR)
      const tipLon = d.lon + L * e; const tipLat = d.lat + L * n
      const hL = 0.42 * L
      const al = (d.toward + 180 - 26) * D2R; const ar = (d.toward + 180 + 26) * D2R
      return [
        [d.lon, d.lat, z], [tipLon, tipLat, z],
        [tipLon + hL * Math.sin(al) / cosLat, tipLat + hL * Math.cos(al), z],
        [tipLon, tipLat, z],
        [tipLon + hL * Math.sin(ar) / cosLat, tipLat + hL * Math.cos(ar), z],
      ]
    }
    return [new window.deck.PathLayer({
      id: 'wind3d', data, getPath: pathOf, getColor: (d) => beaufortRGBA(d.kn),
      getWidth: 2.4, widthUnits: 'pixels', widthMinPixels: 1.4, capRounded: true, jointRounded: true, pickable: false,
    })]
  }

  // build the map once
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
        const url = drapeImageURL(field, fi)
        if (url) { map.addSource('drape', { type: 'image', url, coordinates: boxCoords(field.box) }); map.addLayer({ id: 'drape', type: 'raster', source: 'drape', paint: { 'raster-opacity': drapeOpacity(field), 'raster-resampling': 'linear' } }) }
        // flat single-level arrows ONLY when there's no vertical stack
        if (kind !== 'hpbl' && !hasVolume) {
          addArrowIcons(map)
          map.addSource('wind', { type: 'geojson', data: fieldToGeoJSON(field, fi, { minKn: kind === 'current' ? 0.2 : 0.6 }) })
          map.addLayer({ id: 'wind', type: 'symbol', source: 'wind', layout: { 'icon-image': kind === 'current' ? 'arrow-mono' : ['concat', 'arrow-', ['to-string', ['get', 'band']]], 'icon-rotate': ['get', 'toward'], 'icon-rotation-alignment': 'map', 'icon-size': ['interpolate', ['linear'], ['get', 'spd'], 0, 0.4, 30, 1.1], 'icon-allow-overlap': true, 'icon-ignore-placement': true } })
        }
        if (p1lat != null && p1lon != null) { map.addSource('ring', { type: 'geojson', data: ringGeoJSON(p1lat, p1lon, 5) }); map.addLayer({ id: 'ring', type: 'line', source: 'ring', paint: { 'line-color': '#ef4444', 'line-width': 2, 'line-dasharray': [2, 1.5] } }) }
        // multi-level deck.gl arrows
        if (hasVolume && window.deck?.MapboxOverlay) {
          const overlay = new window.deck.MapboxOverlay({ interleaved: false, layers: windLayer() })
          map.addControl(overlay); overlayRef.current = overlay
        } else if (hasVolume) {
          setErr('deck.gl overlay unavailable')
        }
        loadedRef.current = true
      } catch (e) { setErr(e?.message || 'layer build failed') }
    })
    return () => { try { map.remove() } catch { /* */ } mapRef.current = null; overlayRef.current = null; loadedRef.current = false }
  }, [ready, field]) // eslint-disable-line react-hooks/exhaustive-deps

  // update drape + flat arrows + deck arrows on time / level / exaggeration change
  useEffect(() => {
    const map = mapRef.current; if (!map || !loadedRef.current) return
    try {
      const url = drapeImageURL(field, fi); const ds = map.getSource('drape'); if (ds && url) ds.updateImage({ url, coordinates: boxCoords(field.box) })
      const ws = map.getSource('wind'); if (ws) ws.setData(fieldToGeoJSON(field, fi, { minKn: kind === 'current' ? 0.2 : 0.6 }))
      if (overlayRef.current) overlayRef.current.setProps({ layers: windLayer() })
    } catch { /* */ }
  }, [fi, levels, exaggeration, field]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const map = mapRef.current; if (map && loadedRef.current) { try { map.setTerrain({ source: 'dem', exaggeration }) } catch { /* */ } } }, [exaggeration])

  const rotateBy = (d) => { const m = mapRef.current; if (m) m.easeTo({ bearing: m.getBearing() + d, duration: 300 }) }
  const tiltBy = (d) => { const m = mapRef.current; if (m) m.easeTo({ pitch: Math.max(0, Math.min(85, m.getPitch() + d)), duration: 300 }) }
  const setPitch = (p) => { const m = mapRef.current; if (m) m.easeTo({ pitch: p, duration: 350 }) }
  const toggleLevel = (h) => setLevels((cur) => (cur.includes(h) ? cur.filter((x) => x !== h) : [...cur, h].sort((a, b) => a - b)))

  return (
    <div style={{ position: 'relative', width: '100%', height }}>
      <div ref={divRef} style={{ width: '100%', height: '100%', borderRadius: 8, overflow: 'hidden', background: '#071624', border: '1px solid #1E3A5A' }} />
      {/* level toggles (multi-level fields only) */}
      {hasVolume && (
        <div style={{ position: 'absolute', left: 8, top: 8, display: 'flex', gap: 5, flexWrap: 'wrap', maxWidth: 'calc(100% - 16px)', alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 700, background: 'rgba(8,22,38,0.85)', padding: '3px 6px', borderRadius: 5 }}>3D wind field — levels (m)</span>
          <button onClick={() => setLevels(heights.slice())} style={lvlBtn(levels.length === heights.length)}>All</button>
          {heights.map((h) => <button key={h} onClick={() => toggleLevel(h)} style={lvlBtn(levels.includes(h))}>{h}</button>)}
        </div>
      )}
      {/* view controls */}
      <div style={{ position: 'absolute', left: 8, bottom: 8, display: 'flex', gap: 5, flexWrap: 'wrap', maxWidth: 'calc(100% - 16px)' }}>
        <button onClick={() => rotateBy(-30)} title="Rotate left" style={c3dBtn}>⟲</button>
        <button onClick={() => rotateBy(30)} title="Rotate right" style={c3dBtn}>⟳</button>
        <button onClick={() => tiltBy(12)} title="Tilt toward horizontal" style={c3dBtn}>tilt ↑</button>
        <button onClick={() => tiltBy(-12)} title="Tilt toward top-down" style={c3dBtn}>tilt ↓</button>
        <button onClick={() => setPitch(0)} title="Top-down view" style={c3dBtn}>Top</button>
        <button onClick={() => setPitch(72)} title="Low oblique (horizon) view" style={c3dBtn}>Horizon</button>
      </div>
      {!ready && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748B', fontSize: 12 }}>Loading 3D map…</div>}
      {err && <div style={{ position: 'absolute', right: 8, top: 8, color: '#FCA5A5', fontSize: 11, background: 'rgba(3,15,26,0.8)', padding: '3px 8px', borderRadius: 6 }}>{err}</div>}
    </div>
  )
}
const c3dBtn = { background: 'rgba(8,22,38,0.9)', color: '#E2E8F0', border: '1px solid #1E3A5A', borderRadius: 6, padding: '5px 9px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }
const lvlBtn = (on) => ({ background: on ? '#0EA5E9' : 'rgba(8,22,38,0.9)', color: on ? '#031018' : '#94A3B8', border: '1px solid #1E3A5A', borderRadius: 5, padding: '3px 7px', fontSize: 11, fontWeight: 700, cursor: 'pointer' })

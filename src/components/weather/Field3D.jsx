// Field3D.jsx
// ----------------------------------------------------------------------------
// Inline 3D field viewer for the Forecast tab. MapLibre 3D terrain (AWS DEM +
// ESRI satellite). Everything else is drawn in a deck.gl overlay so it covers
// the full grid regardless of terrain: a flat BitmapLayer colour drape, TWS
// contour lines + labels (selected/mast height), and wind arrows — multi-level
// (true altitude) for SSA-Race fields that carry the vertical stack, single-level
// for the rest. Shared time bar drives the frame; hover shows the wind value.
// ----------------------------------------------------------------------------
import React, { useEffect, useRef, useState } from 'react'
import { useScriptsOnce } from './useScriptOnce'
import { sampleField } from './windField'
import {
  MAPLIBRE_JS, MAPLIBRE_CSS, DECK_JS, defaultLevels, SAT_TILES, DEM_TILES,
  meanFromDir, ringGeoJSON, fieldKind, drapeImageURL, drapeOpacity, boxCoords,
  buildProfileVectors, buildSurfaceVectors, beaufortRGBA, buildContoursKn, TWS_CONTOUR_KN, sampleVolumeAtHeight,
} from './field3dUtils'

const D2R = Math.PI / 180

export default function Field3D({ field, frameIdx = 0, p1lat, p1lon, points = [], mastHeight = 30, height = 640, exaggeration = 3 }) {
  const ready = useScriptsOnce([MAPLIBRE_JS, DECK_JS], [MAPLIBRE_CSS])
  const divRef = useRef(null)
  const mapRef = useRef(null)
  const overlayRef = useRef(null)
  const loadedRef = useRef(false)
  const pointMarkersRef = useRef([])
  const [loaded, setLoaded] = useState(false)   // reactive: triggers a layer refresh once the map is ready
  const [err, setErr] = useState('')
  const [readout, setReadout] = useState(null)   // { x, y, kt, dir }
  const fi = field?.frames?.length ? Math.min(frameIdx, field.frames.length - 1) : 0
  const kind = fieldKind(field)
  const heights = field?.volume?.heights || []
  const hasVolume = !!field?.volume?.cellAt && kind === 'wind'
  // Refs so the map's mousemove handler (registered once per field) always reads
  // the CURRENT time frame + mast height — otherwise the readout freezes on the
  // frame selected when the map first initialised (it then never changes as you
  // scrub the time bar).
  const fiRef = useRef(fi); fiRef.current = fi
  const mastRef = useRef(mastHeight); mastRef.current = mastHeight
  const [levels, setLevels] = useState(() => defaultLevels(heights))

  // Keep the selected levels valid for the current field. The state is seeded
  // once at mount, so when the field swaps to one with a different vertical
  // stack (e.g. AROME → SSA-Race during the model auto-select), stale or empty
  // levels would leave NO arrows drawn. Reconcile: drop levels the new field
  // doesn't have, and if nothing valid remains fall back to a sensible default
  // so arrows always show.
  const heightsKey = heights.join(',')
  useEffect(() => {
    if (!hasVolume || !heights.length) return
    setLevels((cur) => {
      const valid = cur.filter((h) => heights.includes(h))
      if (valid.length) return valid.length === cur.length ? cur : valid
      const def = defaultLevels(heights)
      return def.length ? def : heights.slice(0, 1)
    })
  }, [heightsKey, hasVolume]) // eslint-disable-line react-hooks/exhaustive-deps

  // arrow PathLayer (shaft + 2 head segments, positions in [lng,lat,altitude])
  const arrowPathLayer = (data) => {
    const lat0 = p1lat ?? field.header.la1
    const cosLat = Math.cos(lat0 * D2R) || 1
    const pathOf = (d) => {
      const z = d.altM * exaggeration
      const L = 0.014 * Math.max(0.45, Math.min(2.1, d.kn / 11))
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
    return new window.deck.PathLayer({ id: 'wind3d', data, getPath: pathOf, getColor: (d) => beaufortRGBA(d.kn), getWidth: 2.4, widthUnits: 'pixels', widthMinPixels: 1.4, capRounded: true, jointRounded: true, pickable: false })
  }

  const deckLayers = () => {
    const Dk = window.deck; if (!Dk) return []
    const out = []
    const url = drapeImageURL(field, fi)
    if (url) out.push(new Dk.BitmapLayer({ id: 'drape-bmp', image: url, bounds: [field.box.west, field.box.south, field.box.east, field.box.north], opacity: drapeOpacity(field) }))
    if (kind !== 'hpbl') {
      const { paths, labels } = buildContoursKn(field, fi, TWS_CONTOUR_KN)
      if (paths.length) out.push(new Dk.PathLayer({ id: 'tws-contours', data: paths, getPath: (d) => d.path, getColor: [20, 30, 46, 190], getWidth: (d) => (d.major ? 2.0 : 1.1), widthUnits: 'pixels', widthMinPixels: 0.9, capRounded: true, jointRounded: true, pickable: false }))
      if (labels.length) out.push(new Dk.TextLayer({
        id: 'tws-labels', data: labels,
        getPosition: (d) => [d.position[0], d.position[1], 60 * exaggeration],   // lift off the surface so it isn't buried
        getText: (d) => d.text, getSize: 13, sizeUnits: 'pixels', getColor: [255, 255, 255, 255],
        background: true, getBackgroundColor: [10, 18, 28, 150], backgroundPadding: [4, 2, 4, 2],
        billboard: true, getTextAnchor: 'middle', getAlignmentBaseline: 'center', fontWeight: 700, pickable: false,
      }))
    }
    const arrows = hasVolume ? buildProfileVectors(field.volume, fi, levels) : (kind !== 'hpbl' ? buildSurfaceVectors(field, fi) : [])
    if (arrows.length) out.push(arrowPathLayer(arrows))
    return out
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
        if (p1lat != null && p1lon != null) { map.addSource('ring', { type: 'geojson', data: ringGeoJSON(p1lat, p1lon, 5) }); map.addLayer({ id: 'ring', type: 'line', source: 'ring', paint: { 'line-color': '#ef4444', 'line-width': 2, 'line-dasharray': [2, 1.5] } }) }
        if (window.deck?.MapboxOverlay) {
          const overlay = new window.deck.MapboxOverlay({ interleaved: false, layers: deckLayers() })
          map.addControl(overlay); overlayRef.current = overlay
        } else {
          // fallback: flat terrain-draped image (no arrows) if deck is unavailable
          const url = drapeImageURL(field, fi)
          if (url) { map.addSource('drape', { type: 'image', url, coordinates: boxCoords(field.box) }); map.addLayer({ id: 'drape', type: 'raster', source: 'drape', paint: { 'raster-opacity': drapeOpacity(field) } }) }
          setErr('deck.gl unavailable — arrows hidden')
        }
        loadedRef.current = true; setLoaded(true)
      } catch (e) { setErr(e?.message || 'layer build failed') }
    })
    // hover readout — MAST-height wind at the cursor. Prefer the vertical stack
    // (SSA-Race) so it's mast regardless of the displayed height; otherwise fall
    // back to the displayed field (which defaults to mast, else its lowest level).
    map.on('mousemove', (e) => {
      const cfi = fiRef.current
      // Match what's drawn: the shading / contours / arrows all use the displayed
      // FRAME field, so sample that (at the current time). Fall back to the mast-
      // height volume only when there are no frames.
      let s = sampleField(field, cfi, e.lngLat.lat, e.lngLat.lng)
      if (!s || s.kt == null) s = field.volume ? sampleVolumeAtHeight(field.volume, cfi, mastRef.current, e.lngLat.lat, e.lngLat.lng) : null
      if (s && s.kt != null) setReadout({ x: e.point.x, y: e.point.y, kt: Math.round(s.kt), dir: Math.round(s.dirTrue) })
      else setReadout(null)
    })
    map.on('mouseout', () => setReadout(null))
    return () => { try { map.remove() } catch { /* */ } mapRef.current = null; overlayRef.current = null; loadedRef.current = false; setLoaded(false) }
  }, [ready, field]) // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh deck layers on time / level / exaggeration change — AND once the map
  // finishes loading (`loaded`), so arrows draw on the first frame instead of
  // only after the first scrub.
  useEffect(() => {
    const map = mapRef.current; if (!map || !loadedRef.current) return
    try {
      if (overlayRef.current) overlayRef.current.setProps({ layers: deckLayers() })
      const ds = map.getSource('drape'); if (ds) { const url = drapeImageURL(field, fi); if (url) ds.updateImage({ url, coordinates: boxCoords(field.box) }) }
    } catch { /* */ }
  }, [fi, levels, exaggeration, field, loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const map = mapRef.current; if (map && loadedRef.current) { try { map.setTerrain({ source: 'dem', exaggeration }) } catch { /* */ } } }, [exaggeration])

  // The 3 selected points, as numbered colour-coded markers (matching the 2D
  // map). Re-added whenever the map rebuilds (field change) or the points move.
  const pointsKey = points.map((p) => `${p.key}:${p.lat},${p.lon},${p.color}`).join('|')
  useEffect(() => {
    const map = mapRef.current; const ML = window.maplibregl
    if (!map || !ML) return undefined
    pointMarkersRef.current.forEach((m) => { try { m.remove() } catch { /* */ } })
    pointMarkersRef.current = []
    points.forEach((p) => {
      if (p.lat == null || p.lon == null) return
      const el = document.createElement('div')
      el.style.cssText = `background:${p.color};color:#fff;font-weight:700;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.5);font-size:11px;cursor:default`
      el.textContent = p.key
      try {
        const mk = new ML.Marker({ element: el, anchor: 'center' }).setLngLat([p.lon, p.lat]).addTo(map)
        pointMarkersRef.current.push(mk)
      } catch { /* */ }
    })
    return () => { pointMarkersRef.current.forEach((m) => { try { m.remove() } catch { /* */ } }); pointMarkersRef.current = [] }
  }, [pointsKey, ready, field]) // eslint-disable-line react-hooks/exhaustive-deps

  const rotateBy = (d) => { const m = mapRef.current; if (m) m.easeTo({ bearing: m.getBearing() + d, duration: 300 }) }
  const tiltBy = (d) => { const m = mapRef.current; if (m) m.easeTo({ pitch: Math.max(0, Math.min(85, m.getPitch() + d)), duration: 300 }) }
  const setPitch = (p) => { const m = mapRef.current; if (m) m.easeTo({ pitch: p, duration: 350 }) }
  const toggleLevel = (h) => setLevels((cur) => (cur.includes(h) ? cur.filter((x) => x !== h) : [...cur, h].sort((a, b) => a - b)))

  return (
    <div style={{ position: 'relative', width: '100%', height }}>
      <div ref={divRef} style={{ width: '100%', height: '100%', borderRadius: 8, overflow: 'hidden', background: '#071624', border: '1px solid #1E3A5A' }} />
      {hasVolume && (
        <div style={{ position: 'absolute', left: 8, top: 8, display: 'flex', gap: 5, flexWrap: 'wrap', maxWidth: 'calc(100% - 16px)', alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 700, background: 'rgba(8,22,38,0.85)', padding: '3px 6px', borderRadius: 5 }}>3D wind field — levels (m)</span>
          <button onClick={() => setLevels(heights.slice())} style={lvlBtn(levels.length === heights.length)}>All</button>
          {heights.map((h) => <button key={h} onClick={() => toggleLevel(h)} style={lvlBtn(levels.includes(h))}>{Math.round(h)}</button>)}
        </div>
      )}
      {readout && (
        <div style={{ position: 'absolute', left: readout.x + 12, top: readout.y + 12, pointerEvents: 'none', background: 'rgba(3,15,26,0.9)', color: '#fff', font: '700 12px ui-monospace, monospace', padding: '3px 7px', borderRadius: 6, border: '1px solid #1E3A5A', whiteSpace: 'nowrap', zIndex: 3 }}>
          {String(readout.dir).padStart(3, '0')}° · {readout.kt} kn
        </div>
      )}
      <div style={{ position: 'absolute', left: 8, bottom: 8, display: 'flex', gap: 5, flexWrap: 'wrap', maxWidth: 'calc(100% - 16px)' }}>
        <button onClick={() => rotateBy(-30)} title="Rotate left" style={c3dBtn}>⟲</button>
        <button onClick={() => rotateBy(30)} title="Rotate right" style={c3dBtn}>⟳</button>
        <button onClick={() => tiltBy(12)} title="Tilt toward horizontal" style={c3dBtn}>tilt ↑</button>
        <button onClick={() => tiltBy(-12)} title="Tilt toward top-down" style={c3dBtn}>tilt ↓</button>
        <button onClick={() => setPitch(0)} title="Top-down view" style={c3dBtn}>Top</button>
        <button onClick={() => setPitch(72)} title="Low oblique (horizon) view" style={c3dBtn}>Horizon</button>
      </div>
      {!ready && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8A97A9', fontSize: 12 }}>Loading 3D map…</div>}
      {err && <div style={{ position: 'absolute', right: 8, top: 8, color: '#FCA5A5', fontSize: 11, background: 'rgba(3,15,26,0.8)', padding: '3px 8px', borderRadius: 6 }}>{err}</div>}
    </div>
  )
}
const c3dBtn = { background: 'rgba(8,22,38,0.9)', color: '#E2E8F0', border: '1px solid #1E3A5A', borderRadius: 6, padding: '5px 9px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }
const lvlBtn = (on) => ({ background: on ? '#0EA5E9' : 'rgba(8,22,38,0.9)', color: on ? '#031018' : '#94A3B8', border: '1px solid #1E3A5A', borderRadius: 5, padding: '3px 7px', fontSize: 11, fontWeight: 700, cursor: 'pointer' })

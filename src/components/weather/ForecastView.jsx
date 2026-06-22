// Forecast sub-tab of WeatherTab.
//
// Native React port of the Forecast section of the standalone weather tool
// (Smart Sailing Analytics/index.html, v1.3). Covers the map + 3-point
// picker, the model fetch panel, the per-location summary strip and the
// per-location hourly tables. Wind profile + multi-location comparison
// chart land in Phase 2; the Skew-T sounding is Phase 3.
//
// Leaflet is loaded from CDN on first mount via useScriptsOnce. No new npm
// deps. The dark theme is applied at the component level — the underlying
// Leaflet tiles stay light (street map readability matters more than chrome).

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useScriptsOnce } from './useScriptOnce'
import PlotlyChart from './PlotlyChart'
import {
  MODELS, COMPARE_ORDER,
  fetchAllForPoint, pickDefaultActiveModel, hasValidSpeed,
  kmhToKnots, decimalToDMS,
  calculateTheoreticalSeaProfile, pressureToAltitude,
  interpolateSpeedAtHeight,
  labelWithCycle, withCycleLabel, localForecastWindow,
} from './openMeteo'
import { useModelCycles } from './modelCycles'
import {
  matchVenue, specFor, wind30, applyMOS, mosSeries, correctionInfo,
} from './mos'
import {
  fetchWindField, fetchIconRaceField, fetchCurrentField, fetchCurrentHires, currentsCovered, toVelocityData, speedImageURL, sampleField,
  applyMosToField, fieldHeightsFor, BEAUFORT_BANDS, PALETTE_MAX_KT, currentRamp,
  fetchIconRaceHpblField, scalarImageURL, sampleScalarField, hpblRamp, HPBL_MAX_M, buildHpblContourSvg,
} from './windField'

// Approx magnetic variation for the western Mediterranean venues (~+3° E in
// 2026). magnetic = true − variation (east positive). Adjust if you extend
// beyond the Med.
const MAG_VAR_DEG = 3

// Model picker order — Icon-Race first (left-most), then the global models.
// Forecast model picker: the self-hosted SSA-Race models (2 km, 1 km) first,
// then the global/regional models.
const MODEL_PICK_ORDER = ['ICONRACE', 'ICONRACE_1KM', ...COMPARE_ORDER.filter((k) => !k.startsWith('ICONRACE')), 'HPBL', 'CURRENTS']

// Small pill button for the model/height selectors.
function PillBtn({ active, color = '#06B6D4', onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
        cursor: 'pointer', whiteSpace: 'nowrap',
        border: `1px solid ${active ? color : '#1E3A5A'}`,
        background: active ? color : 'transparent',
        color: active ? '#001018' : '#94A3B8',
      }}
    >
      {children}
    </button>
  )
}

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
// Animated particle-flow wind layer (loaded after Leaflet — it extends L).
const VELOCITY_JS = 'https://unpkg.com/leaflet-velocity@1/dist/leaflet-velocity.min.js'
const VELOCITY_CSS = 'https://unpkg.com/leaflet-velocity@1/dist/leaflet-velocity.min.css'

// Point markers — colour each by index. The standalone tool uses red /
// green / orange; we keep the same emoji convention so existing users
// recognise the picker.
const LOCATION_META = [
  { key: '1', emoji: '🔴', accent: '#EF4444' },
  { key: '2', emoji: '🟢', accent: '#10B981' },
  { key: '3', emoji: '🟠', accent: '#F97316' },
]

const today = () => new Date().toISOString().slice(0, 10)
const TZ_OPTIONS = [
  { v: 'auto',                       l: 'Auto (browser)' },
  { v: 'UTC',                        l: 'UTC' },
  { v: 'Europe/London',              l: 'Europe/London' },
  { v: 'Europe/Paris',               l: 'Europe/Paris' },
  { v: 'Europe/Madrid',              l: 'Europe/Madrid' },
  { v: 'Europe/Rome',                l: 'Europe/Rome' },
  { v: 'Europe/Helsinki',            l: 'Europe/Helsinki' },
  { v: 'America/New_York',           l: 'America/New_York' },
  { v: 'America/Los_Angeles',        l: 'America/Los_Angeles' },
  { v: 'Australia/Sydney',           l: 'Australia/Sydney' },
]

// Props:
//   windData, activeModel, resolvedTz — fetched data (lifted to WeatherTab so
//     CompareView and future sub-tabs share the same payload without refetch).
//   onDataChange(windData, activeModel, resolvedTz) — emitted after a fetch.
//   onActiveModelChange(modelKey) — emitted when the user flips the toggle.
export default function ForecastView({
  windData = {},
  activeModel = 'AROME',
  resolvedTz = 'UTC',
  mastHeight = 20,
  onMastHeightChange,
  onDataChange,
  onActiveModelChange,
  persist = {},
  onPersistChange,
  canMos = false,
  canIconRace = false,
  canHeights = false,
}) {
  const leafletReady = useScriptsOnce([LEAFLET_JS], [LEAFLET_CSS])
  const mapDivRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef({}) // { '1': marker, '2': marker, '3': marker }

  // Form state stays local — only the post-fetch results are lifted. Date is
  // always "today" (forecast_days window) and timezone is always auto; models
  // are always all-fetched (greyed where a model has no data in the area).
  const [locations, setLocations] = useState(() => persist.locations || {}) // restored across tab switches
  // Fetch all models; Icon-Race only for TL2+ (so its data never reaches lower roles).
  // Icon-Race (and its v2 A/B twin) are TL2+ only; everything else is open.
  const ALL_MODELS = useMemo(() => Object.fromEntries(COMPARE_ORDER.map((k) => [k, !k.startsWith('ICONRACE') || canIconRace])), [canIconRace])
  // Model run cycles (00/06/12/18z) -> shown in every model name. activeModelObj
  // is the active model with its cycle folded into `label`, so the tables /
  // charts it's passed to render e.g. "AROME 00z" with no further changes.
  const cycles = useModelCycles()
  const activeModelObj = useMemo(() => withCycleLabel(MODELS[activeModel], cycles[activeModel]), [activeModel, cycles])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [progress, setProgress] = useState(null) // { done, total, label } during fetch

  // ── Animated wind-field overlay (appears once all 3 points are set) ──
  const [velocityReady, setVelocityReady] = useState(false)
  const [mapReady, setMapReady] = useState(false)   // true once the Leaflet map exists (re-draws markers/field on remount)
  const [fieldModel, setFieldModel] = useState(() => persist.fieldModel || 'AROME')
  const [fieldHeight, setFieldHeight] = useState(() => persist.fieldHeight ?? 10) // number, or 'mast'
  const [fieldHourIdx, setFieldHourIdx] = useState(() => persist.fieldHourIdx || 0)
  const [fieldPlaying, setFieldPlaying] = useState(false)
  const [field, setField] = useState(() => persist.field || null) // { times, labels, frames, header, maxSpeed, box }
  const [fieldLoading, setFieldLoading] = useState(false)
  const [fieldErr, setFieldErr] = useState('')
  const velocityLayerRef = useRef(null)
  const velocityKindRef = useRef(null)   // 'wind' | 'current' — recreate the layer when this flips
  const speedOverlayRef = useRef(null)
  const contourOverlayRef = useRef(null) // hpbl contour-line + label SVG overlay
  const curOverviewRef = useRef(null)    // cached ~3 km currents overview, to swap back on zoom-out
  const curTierRef = useRef('overview')  // 'overview' | 'hires'
  const readoutRef = useRef(null)
  const selLabelRef = useRef(null)   // local-time label of the currently scrubbed hour (kept across model switches)
  const venueBoxesRef = useRef([])   // Icon-Race coverage rectangles (TL2+ only)

  // Persist points + field selection up to WeatherTab so they survive sub-tab
  // switches (ForecastView is dynamically imported and unmounts when hidden).
  useEffect(() => {
    onPersistChange?.({ locations, fieldModel, fieldHeight, fieldHourIdx, field })
  }, [locations, fieldModel, fieldHeight, fieldHourIdx, field])
  const tzResolved = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const allThree = !!(locations['1'] && locations['2'] && locations['3'])

  // Load leaflet-velocity AFTER Leaflet (it extends the global L).
  useEffect(() => {
    if (!leafletReady) return
    if (window.L && window.L.velocityLayer) { setVelocityReady(true); return }
    if (!document.querySelector(`link[href="${VELOCITY_CSS}"]`)) {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = VELOCITY_CSS; document.head.appendChild(l)
    }
    const done = () => { if (window.L && window.L.velocityLayer) setVelocityReady(true) }
    let s = document.querySelector(`script[src="${VELOCITY_JS}"]`)
    if (s) { if (s.dataset.loaded === '1') done(); else s.addEventListener('load', done) }
    else {
      s = document.createElement('script'); s.src = VELOCITY_JS; s.async = true
      s.onload = () => { s.dataset.loaded = '1'; done() }
      s.onerror = () => { /* leave overlay disabled */ }
      document.head.appendChild(s)
    }
  }, [leafletReady])

  // Fetch the field grid for point 1's 20 nm box on point/model/height change.
  const p1lat = locations['1']?.lat; const p1lon = locations['1']?.lon
  // Field MOS availability: point 1 within 20 nm of a calibrated venue AND the
  // selected model has a fitted correction there.
  const fieldVenue = p1lat != null ? matchVenue(p1lat, p1lon) : null
  const fieldMosId = MODELS[fieldModel]?.mosModel
  const fieldMosAvail = !!(fieldVenue && fieldMosId && correctionInfo(fieldVenue, fieldMosId))
  useEffect(() => {
    if (!allThree || p1lat == null) { setField(null); return }
    let cancelled = false
    setFieldLoading(true); setFieldErr('')
    const isMos = fieldHeight === 'mastMOS' && fieldMosAvail && canMos
    const hVal = (fieldHeight === 'mast' || fieldHeight === 'mastMOS') ? mastHeight : fieldHeight
    const req = fieldModel === 'CURRENTS'
      ? fetchCurrentField({ lat: p1lat, lon: p1lon, timezone: tzResolved })
      : fieldModel === 'HPBL'
        ? fetchIconRaceHpblField({ lat: p1lat, lon: p1lon, timezone: tzResolved, modelKey: 'ICONRACE' })
        : fieldModel.startsWith('ICONRACE')
          ? fetchIconRaceField({ lat: p1lat, lon: p1lon, height: hVal, timezone: tzResolved, modelKey: fieldModel })
          : fetchWindField({ modelKey: fieldModel, lat: p1lat, lon: p1lon, height: hVal, timezone: tzResolved })
    req
      .then((f) => {
        if (cancelled) return
        const ff = isMos ? applyMosToField(f, specFor(fieldVenue), fieldMosId) : f
        if (fieldModel === 'CURRENTS') { curOverviewRef.current = ff; curTierRef.current = 'overview' }
        setField(ff)
        // keep the same wall-clock hour selected across model switches
        const want = selLabelRef.current
        const ni = want && ff.labels ? ff.labels.findIndex((l) => l === want) : -1
        if (ni >= 0) setFieldHourIdx(ni)
        else setFieldHourIdx((i) => Math.min(i, Math.max(0, ff.times.length - 1)))
      })
      .catch((e) => { if (!cancelled) { setField(null); setFieldErr(e?.message || 'fetch failed') } })
      .finally(() => { if (!cancelled) setFieldLoading(false) })
    return () => { cancelled = true }
  }, [allThree, p1lat, p1lon, fieldModel, fieldHeight, mastHeight, tzResolved, fieldMosAvail, canMos])

  // Currents LOD: when the current field is showing, zoom IN (≥10) loads the native
  // ~1.5 km clip (20 km around point 1) and zoom OUT swaps back to the ~3 km overview.
  // fitBounds-on-field-change re-frames each tier; the tier guard prevents loops.
  useEffect(() => {
    const map = mapRef.current
    if (!map || fieldModel !== 'CURRENTS' || p1lat == null) return
    const onZoom = async () => {
      const z = map.getZoom()
      if (z >= 10 && curTierRef.current !== 'hires') {
        try {
          const hf = await fetchCurrentHires({ lat: p1lat, lon: p1lon, timezone: tzResolved })
          if (curTierRef.current === 'hires' || fieldModel !== 'CURRENTS') return
          curTierRef.current = 'hires'; setField(hf)
        } catch { /* keep the overview */ }
      } else if (z < 10 && curTierRef.current !== 'overview' && curOverviewRef.current) {
        curTierRef.current = 'overview'; setField(curOverviewRef.current)
      }
    }
    map.on('zoomend', onZoom)
    return () => map.off('zoomend', onZoom)
  }, [fieldModel, p1lat, p1lon, tzResolved, mapReady])

  // If MOS becomes unavailable (model/venue change) while it's selected, fall back to raw mast.
  useEffect(() => {
    if (fieldHeight === 'mastMOS' && (!fieldMosAvail || !canMos)) setFieldHeight('mast')
  }, [fieldHeight, fieldMosAvail, canMos])

  // Below TL2: never leave Icon-Race selected (e.g. restored from a prior session).
  useEffect(() => {
    if (canIconRace) return
    if (fieldModel.startsWith('ICONRACE')) setFieldModel('AROME')
    if (activeModel.startsWith('ICONRACE')) onActiveModelChange?.('AROME')
  }, [canIconRace, fieldModel, activeModel]) // eslint-disable-line react-hooks/exhaustive-deps

  // tl1/guest: 10 m winds only — force the wind-field height to 10 m.
  useEffect(() => {
    if (!canHeights && fieldHeight !== 10) setFieldHeight(10)
  }, [canHeights, fieldHeight])

  // Render the speed-colour wash + white particles for the current frame.
  useEffect(() => {
    const map = mapRef.current; const L = window.L
    if (!map || !L || !velocityReady) return
    const clearLayers = () => {
      if (velocityLayerRef.current) { try { map.removeLayer(velocityLayerRef.current) } catch { /* */ } velocityLayerRef.current = null }
      if (speedOverlayRef.current) { try { map.removeLayer(speedOverlayRef.current) } catch { /* */ } speedOverlayRef.current = null }
      if (contourOverlayRef.current) { try { map.removeLayer(contourOverlayRef.current) } catch { /* */ } contourOverlayRef.current = null }
    }
    if (!field || !field.frames.length) { clearLayers(); return }
    const idx = Math.min(fieldHourIdx, field.frames.length - 1)
    const bounds = [[field.box.south, field.box.west], [field.box.north, field.box.east]]

    // 1) translucent speed-shaded colour wash, under the particles. The canvas
    //    is supersampled + smoothstep-interpolated in speedImageURL (rounded band
    //    edges that still preserve the native cell values), so normal scaling
    //    here gives a smooth-but-detailed field — neither washed-out nor boxy.
    const isCur = !!field.isCurrent   // currents: red@5kn colour wash + current-tuned particles
    const isHpbl = !!field.isHpbl     // boundary-layer height: scalar shading, NO particles
    const opacity = isHpbl ? 0.62 : (isCur ? 0.55 : 0.4)
    const sUrl = isHpbl
      ? scalarImageURL(field.frames[idx], field.header, 8, hpblRamp)
      : speedImageURL(field.frames[idx], field.header, 8, isCur ? currentRamp : undefined)
    if (sUrl) {
      if (!speedOverlayRef.current) {
        speedOverlayRef.current = L.imageOverlay(sUrl, bounds, { opacity, interactive: false, pane: 'speedField' }).addTo(map)
      } else {
        speedOverlayRef.current.setUrl(sUrl); speedOverlayRef.current.setBounds(bounds); speedOverlayRef.current.setOpacity(opacity)
      }
    }

    // hpbl is a scalar field — shading + contour lines, no particle layer. Drop any
    // existing particles, (re)build the contour+label overlay for this frame, stop.
    if (isHpbl) {
      if (velocityLayerRef.current) { try { map.removeLayer(velocityLayerRef.current) } catch { /* */ } velocityLayerRef.current = null; velocityKindRef.current = null }
      if (contourOverlayRef.current) { try { map.removeLayer(contourOverlayRef.current) } catch { /* */ } contourOverlayRef.current = null }
      const svg = buildHpblContourSvg(field.frames[idx], field.header)
      if (svg) contourOverlayRef.current = L.svgOverlay(svg, bounds, { interactive: false, opacity: 0.95 }).addTo(map)
      return
    }
    // leaving hpbl for a wind/current model — make sure contours are gone
    if (contourOverlayRef.current) { try { map.removeLayer(contourOverlayRef.current) } catch { /* */ } contourOverlayRef.current = null }

    // 2) animated particles on top. Recreate the layer when the field KIND flips
    //    (wind<->current) so maxVelocity/scale match the data range.
    const kind = isCur ? 'current' : 'wind'
    if (velocityLayerRef.current && velocityKindRef.current !== kind) {
      try { map.removeLayer(velocityLayerRef.current) } catch { /* */ } velocityLayerRef.current = null
    }
    const data = toVelocityData(field.frames[idx], field.header, field.times[idx])
    if (!velocityLayerRef.current) {
      velocityKindRef.current = kind
      velocityLayerRef.current = L.velocityLayer({
        displayValues: false,   // we render our own knots + magnetic readout
        data,
        maxVelocity: isCur ? 2.6 : Math.max(12, field.maxSpeed),   // 2.6 m/s ≈ 5 kn
        velocityScale: isCur ? 0.016 : 0.011,
        particleMultiplier: isCur ? 1 / 400 : 1 / 1400,   // wind: halved density (was 1/700) — less cluttered
        particleAge: 70,
        lineWidth: 1.3,
        colorScale: ['rgba(255,255,255,0.5)', 'rgba(255,255,255,0.9)'],
      }).addTo(map)
    } else {
      velocityLayerRef.current.setData(data)
    }
  }, [field, fieldHourIdx, velocityReady, mapReady])

  // Frame the map to the field's box whenever a new field loads (the box can
  // change between models — Open-Meteo 20 nm box vs Icon-Race venue box).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !field || !velocityReady) return
    map.fitBounds([[field.box.south, field.box.west], [field.box.north, field.box.east]], { padding: [10, 10] })
  }, [field, velocityReady, mapReady])

  // Remove both layers when the field turns off (e.g. a point cleared).
  useEffect(() => {
    if (allThree) return
    const map = mapRef.current
    if (map && velocityLayerRef.current) { try { map.removeLayer(velocityLayerRef.current) } catch { /* */ } velocityLayerRef.current = null }
    if (map && speedOverlayRef.current) { try { map.removeLayer(speedOverlayRef.current) } catch { /* */ } speedOverlayRef.current = null }
    if (map && contourOverlayRef.current) { try { map.removeLayer(contourOverlayRef.current) } catch { /* */ } contourOverlayRef.current = null }
    setFieldPlaying(false)
  }, [allThree])

  // Play/pause: advance the hour, looping.
  useEffect(() => {
    if (!fieldPlaying || !field || !field.times.length) return
    const id = setInterval(() => setFieldHourIdx((i) => (i + 1) % field.times.length), 650)
    return () => clearInterval(id)
  }, [fieldPlaying, field])

  // Remember the scrubbed hour's local label so a model switch keeps the time.
  useEffect(() => {
    if (field?.labels?.length) selLabelRef.current = field.labels[Math.min(fieldHourIdx, field.labels.length - 1)]
  }, [field, fieldHourIdx])

  // Cursor readout: TWS in knots + TWD in magnetic, sampled from the field.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !field) return
    const idx = Math.min(fieldHourIdx, field.frames.length - 1)
    const onMove = (e) => {
      const el = readoutRef.current; if (!el) return
      if (field.isHpbl) {
        const r = sampleScalarField(field, idx, e.latlng.lat, e.latlng.lng)
        if (!r) { el.style.display = 'none'; return }
        el.textContent = `PBL ${Math.round(r.value)} m`
        el.style.display = 'block'
        return
      }
      const s = sampleField(field, idx, e.latlng.lat, e.latlng.lng)
      if (!s) { el.style.display = 'none'; return }
      if (field.isCurrent) {
        // current SET = direction it flows TOWARD (true); speed = drift (knots)
        const toward = (((Math.round(s.dirTrue + 180)) % 360) + 360) % 360
        el.textContent = `${String(toward).padStart(3, '0')}°T   ${s.kt.toFixed(1)} kn`
      } else {
        const mag = ((Math.round(s.dirTrue - MAG_VAR_DEG) % 360) + 360) % 360
        el.textContent = `${String(mag).padStart(3, '0')}°M   ${s.kt.toFixed(1)} kt`
      }
      el.style.display = 'block'
    }
    const onOut = () => { if (readoutRef.current) readoutRef.current.style.display = 'none' }
    map.on('mousemove', onMove); map.on('mouseout', onOut)
    return () => { map.off('mousemove', onMove); map.off('mouseout', onOut) }
  }, [field, fieldHourIdx, mapReady])

  // ── Map bootstrap ────────────────────────────────────────────────────
  useEffect(() => {
    if (!leafletReady || !mapDivRef.current || mapRef.current) return
    const L = window.L
    if (!L) return
    const map = L.map(mapDivRef.current, { zoomControl: true, scrollWheelZoom: true }).setView([48.8566, 2.3522], 6)
    // Pane for the speed colour wash: above tiles (200), below the particle
    // canvas (overlayPane 400) and the location markers (markerPane 600).
    map.createPane('speedField'); map.getPane('speedField').style.zIndex = 250
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO', subdomains: 'abcd', maxZoom: 20,
    }).addTo(map)
    // Lift the very dark CARTO tiles so coastline + labels stay readable under
    // the wind field. (Tweak the brightness factor to taste.)
    try { map.getPane('tilePane').style.filter = 'brightness(1.7) contrast(0.92)' } catch { /* */ }


    // Click → place / cycle markers (1 → 2 → 3 → replace 1 again).
    map.on('click', (e) => {
      setLocations((prev) => {
        const next = { ...prev }
        // Find first empty slot, else cycle through 1/2/3.
        let slot = ['1', '2', '3'].find((k) => !(k in next))
        if (!slot) {
          // All filled — replace whichever was set first (slot 1 by convention).
          slot = '1'
        }
        next[slot] = { lat: e.latlng.lat, lon: e.latlng.lng }
        return next
      })
    })

    // No pre-dropped marker — locations start empty so clicks number 1 → 2 → 3.
    mapRef.current = map
    setMapReady(true)
    return () => {
      try { map.remove() } catch { /* ignore */ }
      mapRef.current = null
      markersRef.current = {}   // drop stale markers bound to the removed map
      setMapReady(false)
    }
  }, [leafletReady])

  // Mirror `locations` state to the map markers (re-runs once the map exists).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !window.L) return
    // Remove markers no longer in state.
    for (const k of Object.keys(markersRef.current)) {
      if (!locations[k]) {
        map.removeLayer(markersRef.current[k])
        delete markersRef.current[k]
      }
    }
    // Add / update each.
    for (const [k, coords] of Object.entries(locations)) {
      if (!markersRef.current[k]) {
        addMarker(map, k, coords.lat, coords.lon)
      } else {
        markersRef.current[k].setLatLng([coords.lat, coords.lon])
      }
    }
  }, [locations, mapReady])

  // Icon-Race coverage boxes — drawn only for TL2+ (canIconRace), and re-evaluated
  // if the role resolves after the map mounts.
  useEffect(() => {
    const map = mapRef.current; const L = window.L
    if (!map || !L || !mapReady) return
    venueBoxesRef.current.forEach((r) => { try { map.removeLayer(r) } catch { /* */ } })
    venueBoxesRef.current = []
    if (!canIconRace) return
    const venues = (MODELS.ICONRACE && MODELS.ICONRACE.venues) || []
    venues.forEach((v) => {
      const bounds = [[v.clat - v.half, v.clon - v.half], [v.clat + v.half, v.clon + v.half]]
      const r = L.rectangle(bounds, { color: '#e36209', weight: 1.5, fillColor: '#e36209', fillOpacity: 0.06, dashArray: '5 4', interactive: false })
        .addTo(map).bindTooltip(`Icon-Race: ${v.name}`, { sticky: true, direction: 'top' })
      venueBoxesRef.current.push(r)
    })
  }, [mapReady, canIconRace])

  function addMarker(map, key, lat, lon) {
    const L = window.L
    const meta = LOCATION_META.find((m) => m.key === key)
    const html = `<div style="background:${meta.accent};color:#fff;font-weight:700;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);font-size:11px">${key}</div>`
    const icon = L.divIcon({ html, className: '', iconSize: [24, 24], iconAnchor: [12, 12] })
    const m = L.marker([lat, lon], { icon, draggable: true }).addTo(map)
    m.on('dragend', () => {
      const ll = m.getLatLng()
      setLocations((prev) => ({ ...prev, [key]: { lat: ll.lat, lon: ll.lng } }))
    })
    markersRef.current[key] = m
  }

  function clearLocation(key) {
    setLocations((prev) => {
      const next = { ...prev }; delete next[key]; return next
    })
    // Drop that point's fetched data too so the table goes back to placeholder.
    if (windData[key]) {
      const next = { ...windData }; delete next[key]
      onDataChange?.(next, activeModel, resolvedTz)
    }
  }

  // ── Fetch all models for every selected location (auto-triggered) ─────
  async function fetchAll(locs = locations) {
    setLoading(true); setErr(null)
    const tz = tzResolved
    const labelFor = (k) => (k === 'GFS' ? 'GFS (upper air)' : (MODELS[k]?.label || k))
    const locEntries = Object.entries(locs)
    if (!locEntries.length) { setLoading(false); return }
    const perPoint = COMPARE_ORDER.length + 1 // +GFS
    const total = locEntries.length * perPoint
    let done = 0
    setProgress({ done: 0, total, label: 'Starting…' })
    try {
      const out = {}
      for (const [key, coords] of locEntries) {
        // eslint-disable-next-line no-await-in-loop
        out[key] = await fetchAllForPoint({
          latitude: coords.lat,
          longitude: coords.lon,
          timezone: tz,
          enabledModels: ALL_MODELS,
          onProgress: ({ modelKey, phase }) => {
            if (phase === 'start') {
              setProgress({ done, total, label: `Loading ${labelFor(modelKey)} — Location ${key}` })
            } else {
              done += 1
              setProgress({ done, total, label: `Loaded ${labelFor(modelKey)} — Location ${key}` })
            }
          },
        })
      }
      const points = Object.values(out)
      onDataChange?.(out, pickDefaultActiveModel(points), tz)
    } catch (e) {
      setErr(e?.message || 'fetch failed')
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }

  // Which models actually returned data at any selected point (for greying).
  const modelAvailable = useMemo(() => {
    const out = {}
    for (const k of COMPARE_ORDER) {
      out[k] = Object.values(windData).some(
        (d) => d.surfaceByModel[k] && hasValidSpeed(d.surfaceByModel[k].hourly)
      )
    }
    // Currents is a FIELD-ONLY layer (not a wind model): available when point 1 is
    // inside the Channel current coverage.
    out.CURRENTS = !!(p1lat != null && p1lon != null && currentsCovered(p1lat, p1lon))
    // Boundary-layer height is a FIELD-ONLY scalar layer from SSA-Race: available
    // when point 1 sits inside an SSA-Race venue box (same gate as the model).
    out.HPBL = !!canIconRace
    return out
  }, [windData, p1lat, p1lon, canIconRace])

  // Auto-fetch all models whenever the points change (debounced for drags).
  const fetchAllRef = useRef(null)
  fetchAllRef.current = fetchAll
  useEffect(() => {
    if (!Object.keys(locations).length) return
    const id = setTimeout(() => { fetchAllRef.current(locations) }, 500)
    return () => clearTimeout(id)
  }, [locations, canIconRace])

  const hasResults = Object.keys(windData).length > 0
  const tzLabel = resolvedTz === 'UTC' ? 'UTC' : resolvedTz

  return (
    <div style={{ padding: '16px 20px 40px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Map (half width in landscape) + wind-field controls beside it */}
      <Card>
       <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* LEFT — map + point chips */}
        <div style={{ flex: '1 1 460px', minWidth: 300 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
          📍 Click 3 points — models load automatically
        </div>
        <div style={{ position: 'relative' }}>
          <div
            ref={mapDivRef}
            style={{
              width: '100%',
              height: 640,
              border: '1px solid #1E3A5A',
              borderRadius: 8,
              background: '#0A1929',
            }}
          />
          <div
            ref={readoutRef}
            style={{
              position: 'absolute', left: 8, bottom: 8, zIndex: 500, display: 'none',
              background: 'rgba(3,15,26,0.85)', color: '#fff',
              font: '700 12px ui-monospace, monospace', padding: '4px 9px',
              borderRadius: 6, border: '1px solid #1E3A5A', pointerEvents: 'none',
              letterSpacing: 0.5,
            }}
          />
        </div>

        {/* Time bar + colour legend sit DIRECTLY under the map (mobile usability). */}
        {field && field.times.length > 0 && (() => {
          const n = field.times.length
          const cur = Math.min(fieldHourIdx, n - 1)
          const stamps = field.stamps || []
          const st = stamps[cur]
          const curLabel = st
            ? `${st.wd} ${st.dd} ${st.mon} · ${String(st.hh).padStart(2, '0')}:${st.mm}`
            : (field.labels?.[cur] || '')
          const ticks = []
          for (let i = 0; i < n; i++) {
            const s = stamps[i]
            if (!s || s.hh % 6 !== 0) continue
            ticks.push({ i, pct: n > 1 ? (i / (n - 1)) * 100 : 0, time: `${String(s.hh).padStart(2, '0')}:00`, date: (s.hh === 0 || ticks.length === 0) ? `${s.wd} ${s.dd} ${s.mon}` : '' })
          }
          return (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8 }}>
              <button onClick={() => setFieldPlaying((p) => !p)} style={{ background: '#1E3A5A', color: '#fff', border: 'none', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 13 }}>{fieldPlaying ? '⏸' : '▶'}</button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <input type="range" min={0} max={n - 1} value={cur} onChange={(e) => { setFieldPlaying(false); setFieldHourIdx(Number(e.target.value)) }} style={{ width: '100%' }} />
                <div style={{ position: 'relative', height: 24 }}>
                  {ticks.map((tk) => (
                    <div key={tk.i} style={{ position: 'absolute', left: `${tk.pct}%`, transform: 'translateX(-50%)', textAlign: 'center', whiteSpace: 'nowrap' }}>
                      <div style={{ width: 1, height: 4, background: '#334C66', margin: '0 auto 1px' }} />
                      <div style={{ fontSize: 9, color: '#94A3B8', lineHeight: 1.1 }}>{tk.time}</div>
                      {tk.date && <div style={{ fontSize: 8, color: '#64748B', lineHeight: 1.1 }}>{tk.date}</div>}
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#E2E8F0', minWidth: 116, textAlign: 'right' }}>{curLabel}</div>
            </div>
          )
        })()}
        {field && (field.isHpbl ? (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 10, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Boundary layer (m) — shallow = clean breeze · contours 25 / 100 / 500 m</div>
            <div style={{ height: 12, borderRadius: 4, border: '1px solid #1E3A5A', background: 'linear-gradient(to right, rgb(38,70,120) 0%, rgb(40,130,185) 6.7%, rgb(45,178,172) 13.3%, rgb(95,192,96) 23.3%, rgb(222,200,70) 33.3%, rgb(235,130,45) 66.7%, rgb(150,52,42) 100%)' }} />
            <div style={{ position: 'relative', height: 10, fontSize: 8, color: '#64748B', marginTop: 2 }}>
              {[0, 200, 500, 1000, 1500].map((v) => (
                <span key={v} style={{ position: 'absolute', left: `${(v / HPBL_MAX_M) * 100}%`, transform: 'translateX(-50%)' }}>{v}{v === 1500 ? '+' : ''}</span>
              ))}
            </div>
          </div>
        ) : field.isCurrent ? (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 10, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Current (kn) — red ≥ 5</div>
            <div style={{ height: 12, borderRadius: 4, border: '1px solid #1E3A5A', background: 'linear-gradient(to right, rgb(40,60,90), rgb(40,130,190), rgb(40,180,165), rgb(120,200,85), rgb(240,190,55), rgb(220,45,45))' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: '#64748B', marginTop: 2 }}>
              {[0, 1, 2, 3, 4, 5].map((kt) => <span key={kt}>{kt}{kt === 5 ? '+' : ''}</span>)}
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 10, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Wind colour (kt)</div>
            <div style={{ height: 12, borderRadius: 4, border: '1px solid #1E3A5A', background: `linear-gradient(to right, ${BEAUFORT_BANDS.map((b) => `rgb(${b.c[0]},${b.c[1]},${b.c[2]})`).join(',')})` }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: '#64748B', marginTop: 2 }}>
              {[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{Math.round(f * PALETTE_MAX_KT)}{f === 1 ? '+' : ''}</span>)}
            </div>
          </div>
        ))}

        </div>{/* end LEFT column */}

        {/* RIGHT — wind-field controls as buttons */}
        <div style={{ flex: '1 1 300px', minWidth: 240, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1 }}>
            🌀 Wind field {allThree ? '· point 1 (20 nm)' : ''}
          </div>
          {!allThree && <div style={{ fontSize: 11, color: '#64748B' }}>Set 3 points to load the field.</div>}
          <div style={{ fontSize: 11, color: '#94A3B8' }}>
            Model: <span style={{ color: MODELS[fieldModel]?.color, fontWeight: 700 }}>{labelWithCycle(fieldModel, cycles)}</span>
            <span style={{ color: '#475569' }}> — pick below</span>
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Height</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <PillBtn active={fieldHeight === 10} onClick={() => setFieldHeight(10)}>10 m</PillBtn>
              {canHeights && <PillBtn active={fieldHeight === 'mast'} onClick={() => setFieldHeight('mast')}>Mast {mastHeight} m</PillBtn>}
              {canHeights && fieldMosAvail && canMos && (
                <PillBtn active={fieldHeight === 'mastMOS'} color="#22D3EE" onClick={() => setFieldHeight('mastMOS')}>Mast {mastHeight} m MOS</PillBtn>
              )}
              {canHeights && fieldHeightsFor(fieldModel).filter((h) => h >= 50).map((h) => (
                <PillBtn key={h} active={fieldHeight === h} onClick={() => setFieldHeight(h)}>{h} m</PillBtn>
              ))}
            </div>
          </div>
          {canHeights && (
          <div>
            <div style={{ fontSize: 10, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Mast height (m)</div>
            <input type="number" min="1" max="120" step="1" value={mastHeight}
              onChange={(e) => onMastHeightChange?.(Math.max(0, Number(e.target.value) || 0))}
              style={{ ...inputStyle, width: 92 }} />
          </div>
          )}
          {/* time bar moved directly under the map (above) for mobile usability */}
          <div style={{ fontSize: 11, minHeight: 14 }}>
            {fieldLoading && <span style={{ color: '#FBBF24' }}>loading field…</span>}
            {fieldErr && <span style={{ color: '#F87171' }}>field: {fieldErr}</span>}
            {!velocityReady && !fieldErr && allThree && <span style={{ color: '#94A3B8' }}>loading particles…</span>}
            {loading && <span style={{ color: '#7DD3FC' }}> · loading models…</span>}
          </div>
          {/* colour legend moved directly under the map (above) */}
        </div>{/* end RIGHT column */}
       </div>{/* end flex row */}
      </Card>

      {/* Single model picker — drives BOTH the wind field and the hourly tables.
          Icon-Race first; available models coloured, others greyed; selected highlighted. */}
      {hasResults && (
        <Card>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#CBD5E1' }}>Select model:</span>
            {(canIconRace ? MODEL_PICK_ORDER : MODEL_PICK_ORDER.filter((k) => !k.startsWith('ICONRACE'))).map((k) => {
              const m = MODELS[k]
              const avail = modelAvailable[k]
              // CURRENTS and HPBL drive the FIELD only (default off, leaving the
              // tables on their wind model); every other pill drives field + tables.
              const fieldOnly = k === 'CURRENTS' || k === 'HPBL'
              const selected = fieldOnly ? fieldModel === k : activeModel === k
              const offTitle = k === 'CURRENTS'
                ? 'Currents cover the English Channel — set point 1 there'
                : k === 'HPBL'
                  ? 'Boundary-layer height — set point 1 in an SSA-Race venue'
                  : `${m.label} has no data here`
              return (
                <button
                  key={k}
                  disabled={!avail}
                  onClick={() => { if (fieldOnly) { setFieldModel(k) } else { onActiveModelChange?.(k); setFieldModel(k) } }}
                  title={avail ? (m.subtitle || '') : offTitle}
                  style={{
                    fontSize: 15, fontWeight: 700, padding: '8px 18px', borderRadius: 999,
                    cursor: avail ? 'pointer' : 'not-allowed',
                    border: `1px solid ${selected ? m.color : (avail ? m.color + '88' : '#1E3A5A')}`,
                    background: selected ? m.color : (avail ? m.color + '22' : 'transparent'),
                    color: selected ? '#001018' : (avail ? '#E2E8F0' : '#475569'),
                    opacity: avail ? 1 : 0.5,
                  }}
                >
                  {labelWithCycle(k, cycles)}
                </button>
              )
            })}
            {loading && <span style={{ fontSize: 12, color: '#7DD3FC' }}>loading…</span>}
          </div>
        </Card>
      )}

      {err && (
        <Card><div style={{ color: '#EF4444', fontSize: 13 }}>⚠ {err}</div></Card>
      )}

      {/* Multi-location summary strip — appears as soon as we have data. */}
      {hasResults && (
        <LocationSummaryStrip windData={windData} model={activeModelObj} />
      )}

      {/* Hourly tables */}
      {hasResults && (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0' }}>
              📊 Hourly Wind Tables (08:00–18:00 {tzLabel}) — <span style={{ color: MODELS[activeModel]?.color }}>{activeModelObj?.label}</span>
            </span>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: '#475569' }}>model selected above</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
            {Object.entries(windData).map(([key, point]) => (
              <WindTable
                key={key}
                locationKey={key}
                point={point}
                model={activeModelObj}
                timezone={resolvedTz}
                mastHeight={mastHeight}
                mosAllowed={canMos}
                heightsAllowed={canHeights}
              />
            ))}
          </div>
        </Card>
      )}

      {/* Wind speed comparison — all picked locations on one chart at the
          active model's 10m and upper height. */}
      {hasResults && (
        <Card>
          <ChartTitle>
            🌬 Wind Speed Comparison — All Locations ({activeModelObj.label})
          </ChartTitle>
          <WindCompareChart windData={windData} model={activeModelObj} timezone={resolvedTz} />
        </Card>
      )}

      {/* Vertical wind profile — surface model levels + GFS pressure levels +
          theoretical neutral marine log profile at a user-selectable time. */}
      {hasResults && (
        <WindProfileSection
          windData={windData}
          model={activeModelObj}
          timezone={resolvedTz}
        />
      )}

      {/* GFS planetary boundary layer height — single line per location, not
          model-dependent (GFS only). Useful sea-breeze / convection signal. */}
      {hasResults && (
        <Card>
          <ChartTitle>🌫 Planetary Boundary Layer Height (GFS)</ChartTitle>
          <BoundaryLayerChart windData={windData} timezone={resolvedTz} />
        </Card>
      )}
    </div>
  )
}

// ── Subcomponents ─────────────────────────────────────────────────────

function WindTable({ locationKey, point, model, timezone, mastHeight, mosAllowed = false, heightsAllowed = false }) {
  const meta = LOCATION_META.find((m) => m.key === locationKey)
  const surf = point.surfaceByModel[model.key]
  // Speed columns = the model's display heights plus the mast height, sorted
  // ascending so the row reads low→high. The mast height is interpolated and
  // highlighted; if it coincides with a native column the two merge into one.
  // Table shows sailing-relevant heights only: drop model columns above 100 m
  // (the user's mast height is always kept, even if set higher).
  // tl1/guest see 10 m only; everyone else gets the model heights (<=100 m) + mast.
  const speedHeights = heightsAllowed
    ? Array.from(new Set([...model.tableCols.filter((h) => h <= 100), mastHeight]))
      .filter((h) => Number.isFinite(h) && h > 0)
      .sort((a, b) => a - b)
    : [10]

  if (!surf || !hasValidSpeed(surf.hourly)) {
    return (
      <div style={{ background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8, padding: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#E2E8F0', marginBottom: 8 }}>
          {meta.emoji} Location {locationKey} — Wind Forecast
        </div>
        <div style={{ fontSize: 11, color: '#475569', textAlign: 'center', padding: 12 }}>
          🚫 No {model.label} data here<br />
          <span style={{ color: '#334155' }}>Try another model above</span>
        </div>
      </div>
    )
  }

  // MOS correction availability for this point + active model.
  const venue = matchVenue(point.coords.latitude, point.coords.longitude)
  const mosId = model.mosModel
  const spec = venue && mosId ? specFor(venue) : null
  const corr = venue && mosId ? correctionInfo(venue, mosId) : null
  const canMos = !!(mosAllowed && spec && corr)

  const hourly = surf.hourly
  const rows = []
  hourly.time.forEach((timeStr, index) => {
    const date = new Date(timeStr)
    const hour = parseInt(
      date.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }),
      10
    )
    if (hour >= 8 && hour <= 18) {
      let mos = null
      if (canMos) {
        const w = wind30(hourly, model.heights, index)
        if (w) {
          const r = applyMOS(spec, mosId, w.ws30, w.twd, hour)
          mos = r ? r.ws : null
        }
      }
      rows.push({
        time: date.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: timezone }),
        windDir: hourly.wind_direction_10m?.[index],
        speeds: speedHeights.map((h) => (
          h === mastHeight
            ? interpolateSpeedAtHeight(hourly, model.heights, mastHeight, index)
            : hourly[`wind_speed_${h}m`]?.[index]
        )),
        mos,
      })
    }
  })

  return (
    <div style={{ background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8, padding: 10, overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#E2E8F0' }}>
          {meta.emoji} Location {locationKey}
        </span>
        <span style={{ fontSize: 9, fontWeight: 700, color: '#000', background: model.color, padding: '1px 6px', borderRadius: 4 }}>
          {model.label}
        </span>
      </div>
      {canMos && (
        <div style={{ fontSize: 9, color: '#34D399', marginBottom: 6 }}>
          ✓ MOS-corrected 30 m for <b>{venue.replace('_', ' ')}</b> · {corr.type}
          {model.mosApprox ? ' ≈' : ''} · CV RMSE {corr.cv_rmse} kt
          {corr.type === 'sector' && corr.sector_agreement != null
            ? ` · dir agree ${Math.round(corr.sector_agreement * 100)}%` : ''}
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            <th style={th}>Time<br /><span style={{ fontSize: 9, color: '#475569' }}>{timezone}</span></th>
            <th style={th}>10m<br /><span style={{ fontSize: 9, color: '#475569' }}>TWD °</span></th>
            {speedHeights.map((h) => {
              const isMast = h === mastHeight
              return (
                <th key={h} style={isMast ? thHi : th}>
                  {isMast ? '⛵ ' : ''}{h}m<br />
                  <span style={{ fontSize: 9, color: isMast ? '#38BDF8' : '#475569' }}>TWS kt</span>
                </th>
              )
            })}
            {canMos && (
              <th style={{ ...th, color: '#34D399' }}>30m MOS<br /><span style={{ fontSize: 9, color: '#1f7a5a' }}>kt</span></th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={tdTime}>{r.time}</td>
              <td style={td}>{r.windDir != null ? String(Math.round(r.windDir)).padStart(3, '0') : '–'}</td>
              {r.speeds.map((s, j) => {
                const isMast = speedHeights[j] === mastHeight
                return (
                  <td key={j} style={isMast ? tdHi : td}>{s != null ? kmhToKnots(s).toFixed(1) : '–'}</td>
                )
              })}
              {canMos && (
                <td style={{ ...td, color: '#34D399', fontWeight: 700 }}>
                  {r.mos != null ? r.mos.toFixed(1) : '–'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Phase 2 chart sections ────────────────────────────────────────────

// Per-location stat block: emoji + coords + avg / max / min wind + elevation.
function LocationSummaryStrip({ windData, model }) {
  const entries = Object.entries(windData)
  return (
    <Card>
      <ChartTitle>📊 Multi-Location Wind Comparison</ChartTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        {entries.map(([key, point]) => {
          const meta = LOCATION_META.find((m) => m.key === key)
          const surf = point.surfaceByModel[model.key]
          const valid = surf?.hourly?.wind_speed_10m?.filter?.((v) => v != null) || []
          const hasData = valid.length > 0
          const avg = hasData ? valid.reduce((a, b) => a + b, 0) / valid.length : null
          const max = hasData ? Math.max(...valid) : null
          const min = hasData ? Math.min(...valid) : null
          return (
            <div key={key} style={{ background: '#071624', border: `1px solid ${meta.accent}44`, borderRadius: 8, padding: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 13 }}>{meta.emoji}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#E2E8F0' }}>Location {key}</span>
                <span style={{ fontSize: 9, fontWeight: 700, color: '#000', background: model.color, padding: '1px 5px', borderRadius: 3 }}>
                  {model.label}
                </span>
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#64748B', marginBottom: 8 }}>
                {decimalToDMS(point.coords.latitude, false)}, {decimalToDMS(point.coords.longitude, true)}
              </div>
              {hasData ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6 }}>
                  <Stat label="Avg" value={`${kmhToKnots(avg).toFixed(1)} kt`} />
                  <Stat label="Max" value={`${kmhToKnots(max).toFixed(1)} kt`} />
                  <Stat label="Min" value={`${kmhToKnots(min).toFixed(1)} kt`} />
                  <Stat label="Elev" value={`${Math.round(point.elevation || 0)} m`} />
                </div>
              ) : (
                <div style={{ fontSize: 11, color: '#64748B' }}>No {model.label} data here.</div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#E2E8F0', fontFamily: 'monospace' }}>{value}</div>
    </div>
  )
}

// Wind speed over time, one trace per location at 10m + dashed at the model's
// upper height. Active model only.
function WindCompareChart({ windData, model, timezone }) {
  const data = useMemo(() => {
    const traces = []
    const upParam = `wind_speed_${model.upperHeight}m`
    for (const [key, point] of Object.entries(windData)) {
      const meta = LOCATION_META.find((m) => m.key === key)
      const surf = point.surfaceByModel[model.key]
      if (!surf || !hasValidSpeed(surf.hourly)) continue
      const xs = surf.hourly.time.map((t) => new Date(t))
      const s10 = surf.hourly.wind_speed_10m
      const sUp = surf.hourly[upParam]
      if (s10) {
        traces.push({
          x: xs, y: s10.map((s) => s != null ? kmhToKnots(s) : null),
          type: 'scatter', mode: 'lines+markers',
          name: `${meta.emoji} Loc ${key} (10m)`,
          line: { color: meta.accent, width: 3 }, marker: { size: 5 },
          connectgaps: true,
        })
      }
      if (sUp) {
        traces.push({
          x: xs, y: sUp.map((s) => s != null ? kmhToKnots(s) : null),
          type: 'scatter', mode: 'lines',
          name: `${meta.emoji} Loc ${key} (${model.upperHeight}m)`,
          line: { color: meta.accent, width: 2, dash: 'dash' },
          connectgaps: true,
        })
      }
      // MOS-corrected 30 m (venue-calibrated) — bold dash-dot line.
      const venue = matchVenue(point.coords.latitude, point.coords.longitude)
      const spec = venue && model.mosModel ? specFor(venue) : null
      if (spec) {
        const ms = mosSeries(surf.hourly, model.heights, spec, model.mosModel, timezone)
        if (ms && ms.some((v) => v != null)) {
          traces.push({
            x: xs, y: ms,
            type: 'scatter', mode: 'lines',
            name: `${meta.emoji} Loc ${key} MOS 30m`,
            line: { color: meta.accent, width: 3, dash: 'dashdot' },
            connectgaps: true,
          })
        }
      }
    }
    return traces
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windData, model.key, timezone])

  const layout = {
    // Fixed 2-day local window (00 today → 00 +2d); ignores any earlier data.
    xaxis: { title: 'Time', type: 'date', range: localForecastWindow(2), autorange: false },
    yaxis: { title: 'Wind speed (knots)', rangemode: 'tozero' },
    hovermode: 'x unified',
    legend: { orientation: 'h', y: -0.2 },
    margin: { t: 20, b: 80, l: 60, r: 20 },
  }
  return (
    <PlotlyChart
      data={data}
      layout={layout}
      height={340}
      placeholder={`No ${model.label} data to compare`}
    />
  )
}

// Vertical profile — surface levels from the active model + GFS pressure
// levels + theoretical log profile from the model's 10m wind. Time selector
// drives `timeIndex`.
function WindProfileSection({ windData, model, timezone }) {
  const times = useMemo(() => {
    for (const point of Object.values(windData)) {
      const surf = point.surfaceByModel[model.key]
      if (surf?.hourly?.time?.length) return surf.hourly.time
      if (point.gfs?.hourly?.time?.length) return point.gfs.hourly.time
    }
    return []
  }, [windData, model.key])
  const [timeIdx, setTimeIdx] = useState(0)
  useEffect(() => { setTimeIdx(0) }, [windData, model.key])

  const data = useMemo(() => {
    const traces = []
    const surfaceLevels = model.heights.map((h) => ({ name: `${h}m`, param: `wind_speed_${h}m`, altitude: h }))
    const pressureLevels = [975, 950, 925, 900, 875, 850, 825, 800, 775, 750].map((p) => ({
      name: `${p}hPa`, param: `wind_speed_${p}hPa`, altitude: pressureToAltitude(p),
    }))
    for (const [key, point] of Object.entries(windData)) {
      const meta = LOCATION_META.find((m) => m.key === key)
      const surf = point.surfaceByModel[model.key]
      const gfsHourly = point.gfs?.hourly || {}
      const profile = []
      if (surf?.hourly) {
        for (const lv of surfaceLevels) {
          const spd = surf.hourly[lv.param]?.[timeIdx]
          if (spd != null && spd > 0) {
            profile.push({ name: lv.name, altitude: Math.max(lv.altitude, 1), speed: kmhToKnots(spd), source: model.label })
          }
        }
      }
      for (const lv of pressureLevels) {
        const spd = gfsHourly[lv.param]?.[timeIdx]
        if (spd != null && spd > 0) {
          profile.push({ name: lv.name, altitude: Math.max(lv.altitude, 1), speed: kmhToKnots(spd), source: 'GFS' })
        }
      }
      if (profile.length) {
        profile.sort((a, b) => a.altitude - b.altitude)
        traces.push({
          x: profile.map((d) => d.speed),
          y: profile.map((d) => d.altitude),
          type: 'scatter', mode: 'lines+markers',
          name: `${meta.emoji} Loc ${key}`,
          line: { color: meta.accent, width: 3 }, marker: { size: 6 },
          text: profile.map((d) => `<b>Loc ${key}</b><br>Level: ${d.name}<br>Alt: ${Math.round(d.altitude)} m<br>Speed: ${d.speed.toFixed(1)} kt<br><i>${d.source}</i>`),
          hovertemplate: '%{text}<extra></extra>',
        })
      }
      // Theoretical neutral marine log profile from the model's 10m wind.
      const w10 = surf?.hourly?.wind_speed_10m?.[timeIdx]
      if (w10 && w10 > 0) {
        const theory = calculateTheoreticalSeaProfile(w10)
        traces.push({
          x: theory.map((d) => kmhToKnots(d.speed)),
          y: theory.map((d) => d.height),
          type: 'scatter', mode: 'lines',
          name: `📏 Loc ${key} log z₀=0.2mm`,
          line: { color: meta.accent + '66', width: 2, dash: 'dot' },
          hoverinfo: 'skip',
        })
      }
    }
    return traces
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windData, model.key, timeIdx])

  const selTime = times[timeIdx] ? new Date(times[timeIdx]) : null
  const timeLabel = selTime
    ? selTime.toLocaleString('en-GB', { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''

  const layout = {
    xaxis: { title: 'Wind speed (knots)', rangemode: 'tozero' },
    yaxis: { title: 'Altitude (m)', type: 'log', tickformat: '.0f' },
    hovermode: 'closest',
    legend: { x: 0.02, y: 0.98 },
    margin: { t: 20, b: 50, l: 70, r: 20 },
  }
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <ChartTitle inline>
          📈 Vertical Wind Profile ({model.label} + GFS) — {timeLabel || '—'}
        </ChartTitle>
        <div style={{ flex: 1 }} />
        <Field label="Time">
          <select value={timeIdx} onChange={(e) => setTimeIdx(Number(e.target.value))} style={inputStyle}>
            {times.map((t, i) => (
              <option key={i} value={i}>
                {new Date(t).toLocaleString('en-GB', { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <PlotlyChart
        data={data}
        layout={layout}
        height={380}
        placeholder="No profile data"
      />
    </Card>
  )
}

// Boundary-layer height per location: SSA-Race hpbl (self-hosted, bulk-Richardson,
// solid) plus the GFS PBL as a coarse global reference (dotted). SSA-Race times are
// UTC; the GFS column is venue-local wall-clock — both are mapped to venue-local
// wall-clock so the lines align on the shared x-axis.
function BoundaryLayerChart({ windData, timezone }) {
  const data = useMemo(() => {
    // UTC ISO -> venue-local wall-clock string (parsed as the same basis as GFS).
    const toLocalWall = (iso) => {
      const d = new Date(iso.endsWith('Z') ? iso : `${iso}Z`)
      const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(d)
      const g = (t) => p.find((x) => x.type === t)?.value
      return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`
    }
    const traces = []
    for (const [key, point] of Object.entries(windData)) {
      const meta = LOCATION_META.find((m) => m.key === key)
      // SSA-Race hpbl — solid, one line per self-hosted resolution present.
      let hasRace = false
      for (const mk of ['ICONRACE', 'ICONRACE_1KM']) {
        const sh = point.surfaceByModel?.[mk]?.hourly
        const sb = sh?.boundary_layer_height; const st = sh?.time
        if (sb && st && sb.some((h) => h != null && h > 0)) {
          hasRace = true
          traces.push({
            x: st.map((t) => new Date(toLocalWall(t))),
            y: sb,
            type: 'scatter', mode: 'lines+markers',
            name: `${meta.emoji} Loc ${key} · ${MODELS[mk].label}`,
            line: { color: meta.accent, width: 3 }, marker: { size: 5 },
            connectgaps: true,
          })
        }
      }
      // GFS PBL — coarse global reference, shown ONLY where no SSA-Race hpbl exists
      // (when the high-res self-hosted model covers the point, GFS adds noise).
      if (!hasRace) {
        const hr = point.gfs?.hourly || {}
        const blh = hr.boundary_layer_height
        const time = hr.time
        if (blh && time && blh.some((h) => h != null && h > 0)) {
          traces.push({
            x: time.map((t) => new Date(t)),
            y: blh,
            type: 'scatter', mode: 'lines',
            name: `${meta.emoji} Loc ${key} · GFS`,
            line: { color: meta.accent, width: 1.5, dash: 'dot' },
            opacity: 0.7, connectgaps: true,
          })
        }
      }
    }
    return traces
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windData, timezone])
  const layout = {
    xaxis: { title: 'Time', type: 'date' },
    yaxis: { title: 'PBL height (m)', rangemode: 'tozero' },
    hovermode: 'x unified',
    legend: { orientation: 'h', y: -0.2 },
    margin: { t: 20, b: 80, l: 60, r: 20 },
  }
  return <PlotlyChart data={data} layout={layout} height={300} placeholder="No PBL data at the selected points" />
}

function ChartTitle({ children, inline }) {
  return (
    <div
      style={{
        fontSize: 12, fontWeight: 700,
        color: '#7DD3FC',
        textTransform: 'uppercase', letterSpacing: 1,
        marginBottom: inline ? 0 : 10,
        display: inline ? 'inline-block' : 'block',
      }}
    >
      {children}
    </div>
  )
}

function Card({ children }) {
  return (
    <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14 }}>
      {children}
    </div>
  )
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</span>
      {children}
    </label>
  )
}

// ── Styles (match SSA conventions) ─────────────────────────────────────
const inputStyle = {
  background: '#071624', border: '1px solid #1E3A5A', borderRadius: 6,
  color: '#E2E8F0', padding: '6px 9px', fontSize: 13,
}
const btnPrimary = {
  background: '#06B6D4', border: 'none', borderRadius: 6, color: '#000',
  fontWeight: 700, fontSize: 13, padding: '7px 16px', cursor: 'pointer',
}
const btnGhost = {
  background: '#1E3A5A', border: 'none', borderRadius: 4, color: '#94A3B8',
  fontSize: 10, padding: '3px 8px', cursor: 'pointer',
}
const th = { padding: '6px 4px', textAlign: 'center', color: '#94A3B8', fontWeight: 600, fontSize: 10, borderBottom: '1px solid #1E3A5A' }
const td = { padding: '4px', textAlign: 'center', color: '#E2E8F0', fontFamily: 'monospace', borderBottom: '1px solid #0F2030' }
const tdTime = { ...td, fontWeight: 700, color: '#7DD3FC' }
const thHi = { ...th, background: '#0E2A38', color: '#67E8F9', borderBottom: '1px solid #155E75' }
const tdHi = { ...td, background: '#0E2A38', color: '#67E8F9', fontWeight: 700, borderBottom: '1px solid #0F2030' }

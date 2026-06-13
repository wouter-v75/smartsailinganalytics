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
  MODELS, MODEL_ORDER, COMPARE_ORDER,
  fetchAllForPoint, pickDefaultActiveModel, hasValidSpeed,
  kmhToKnots, decimalToDMS,
  calculateTheoreticalSeaProfile, pressureToAltitude,
  interpolateSpeedAtHeight,
} from './openMeteo'
import {
  matchVenue, specFor, wind30, applyMOS, mosSeries, correctionInfo,
} from './mos'

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'

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
}) {
  const leafletReady = useScriptsOnce([LEAFLET_JS], [LEAFLET_CSS])
  const mapDivRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef({}) // { '1': marker, '2': marker, '3': marker }

  // Form state stays local — only the post-fetch results are lifted.
  const [date, setDate] = useState(today())
  const [timezone, setTimezone] = useState('auto')
  const [locations, setLocations] = useState({}) // empty → first click fills slot 1, then 2, then 3
  const [enabledModels, setEnabledModels] = useState(
    () => Object.fromEntries(COMPARE_ORDER.map((k) => [k, true]))
  )
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [progress, setProgress] = useState(null) // { done, total, label } during fetch

  // ── Map bootstrap ────────────────────────────────────────────────────
  useEffect(() => {
    if (!leafletReady || !mapDivRef.current || mapRef.current) return
    const L = window.L
    if (!L) return
    const map = L.map(mapDivRef.current, { zoomControl: true, scrollWheelZoom: true }).setView([48.8566, 2.3522], 6)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 18,
    }).addTo(map)

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
    return () => {
      try { map.remove() } catch { /* ignore */ }
      mapRef.current = null
    }
  }, [leafletReady])

  // Mirror `locations` state to the map markers.
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
  }, [locations])

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

  // ── Fetch all models for every selected location ─────────────────────
  async function fetchAll() {
    setLoading(true); setErr(null); onDataChange?.({}, activeModel, resolvedTz)
    const tz = timezone === 'auto'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : timezone
    const labelFor = (k) => (k === 'GFS' ? 'GFS (upper air)' : (MODELS[k]?.label || k))
    const locEntries = Object.entries(locations)
    const perPoint = COMPARE_ORDER.filter((k) => enabledModels[k]).length + 1 // +GFS
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
          enabledModels,
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
  const setActiveModel = (key) => onActiveModelChange?.(key)

  // Which models actually returned data at any selected point (for greying).
  const modelAvailable = useMemo(() => {
    const out = {}
    for (const k of COMPARE_ORDER) {
      out[k] = enabledModels[k] && Object.values(windData).some(
        (d) => d.surfaceByModel[k] && hasValidSpeed(d.surfaceByModel[k].hourly)
      )
    }
    return out
  }, [enabledModels, windData])

  const hasResults = Object.keys(windData).length > 0
  const tzLabel = resolvedTz === 'UTC' ? 'UTC' : resolvedTz

  return (
    <div style={{ padding: '16px 20px 40px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Map + location cards */}
      <Card>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
          📍 Select up to 3 locations
        </div>
        <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 8 }}>
          Click the map to drop a marker. Click again to add a 2nd / 3rd point.
          Drag any marker to fine-tune. Markers persist until you Clear.
        </div>
        <div
          ref={mapDivRef}
          style={{
            width: '100%',
            height: 320,
            border: '1px solid #1E3A5A',
            borderRadius: 8,
            background: '#0A1929',
          }}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
          {LOCATION_META.map((m) => {
            const c = locations[m.key]
            return (
              <div
                key={m.key}
                style={{
                  flex: '1 1 200px',
                  background: '#0A1929',
                  border: `1px solid ${c ? m.accent + '88' : '#1E3A5A'}`,
                  borderRadius: 8,
                  padding: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <span style={{ fontSize: 14 }}>{m.emoji}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#E2E8F0' }}>Location {m.key}</span>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: c ? '#10B981' : '#475569' }}>
                    {c ? 'Selected' : 'Empty'}
                  </span>
                  {c && (
                    <button onClick={() => clearLocation(m.key)} style={btnGhost}>Clear</button>
                  )}
                </div>
                {c ? (
                  <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#94A3B8' }}>
                    <div>Lat&nbsp;{decimalToDMS(c.lat, false)}</div>
                    <div>Lon&nbsp;{decimalToDMS(c.lon, true)}</div>
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: '#475569' }}>Click map to select</div>
                )}
              </div>
            )
          })}
        </div>
      </Card>

      {/* Controls */}
      <Card>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Start date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Timezone">
            <select value={timezone} onChange={(e) => setTimezone(e.target.value)} style={inputStyle}>
              {TZ_OPTIONS.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
            </select>
          </Field>
          <div style={{ flex: 1 }} />
          <Field label="Mast height (m)">
            <input
              type="number" min="1" max="120" step="1"
              value={mastHeight}
              onChange={(e) => onMastHeightChange?.(Math.max(0, Number(e.target.value) || 0))}
              style={{ ...inputStyle, width: 92 }}
              title="Interpolated masthead wind — fit through the 3 nearest model heights"
            />
          </Field>
          <button
            onClick={fetchAll}
            disabled={loading || Object.keys(locations).length === 0}
            style={btnPrimary}
          >
            {loading ? 'Fetching…' : '🌬 Fetch wind data'}
          </button>
        </div>

        {/* Fetch progress — which models are loading. */}
        {loading && progress && (
          <div style={{ marginTop: 12 }}>
            <div style={{ height: 8, background: '#071624', border: '1px solid #1E3A5A', borderRadius: 999, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`, background: '#06B6D4', transition: 'width 0.2s ease' }} />
            </div>
            <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 6, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>{progress.label}</span>
              <span style={{ color: '#64748B', fontVariantNumeric: 'tabular-nums' }}>{progress.done}/{progress.total}</span>
            </div>
          </div>
        )}

        {/* Model checkboxes — tick which to fetch. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12, paddingTop: 10, borderTop: '1px solid #1E3A5A' }}>
          <span style={{ fontSize: 11, color: '#94A3B8' }}>Models to fetch:</span>
          {COMPARE_ORDER.map((k) => {
            const m = MODELS[k]
            const greyed = hasResults && !modelAvailable[k]
            return (
              <label
                key={k}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: 11,
                  color: greyed ? '#475569' : '#E2E8F0',
                  cursor: 'pointer',
                  opacity: greyed ? 0.55 : 1,
                  border: `1px solid ${enabledModels[k] ? m.color : '#1E3A5A'}`,
                  background: enabledModels[k] ? m.color + '22' : 'transparent',
                  padding: '3px 8px', borderRadius: 999,
                }}
                title={greyed ? `${m.label} has no data at the selected points` : (m.subtitle || '')}
              >
                <input
                  type="checkbox"
                  checked={!!enabledModels[k]}
                  onChange={(e) => setEnabledModels((prev) => ({ ...prev, [k]: e.target.checked }))}
                />
                {m.label}
              </label>
            )
          })}
        </div>
      </Card>

      {err && (
        <Card><div style={{ color: '#EF4444', fontSize: 13 }}>⚠ {err}</div></Card>
      )}

      {/* Multi-location summary strip — appears as soon as we have data. */}
      {hasResults && (
        <LocationSummaryStrip windData={windData} model={MODELS[activeModel]} />
      )}

      {/* Hourly tables */}
      {hasResults && (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0' }}>
              📊 Hourly Wind Tables (08:00–18:00 {tzLabel})
            </span>
            <div style={{ flex: 1 }} />
            {/* Surface model toggle */}
            <div style={{ display: 'flex', gap: 4 }}>
              {MODEL_ORDER.map((k) => {
                const m = MODELS[k]
                const on = activeModel === k
                const data = Object.values(windData).some(
                  (d) => d.surfaceByModel[k] && hasValidSpeed(d.surfaceByModel[k].hourly)
                )
                return (
                  <button
                    key={k}
                    onClick={() => setActiveModel(k)}
                    disabled={!data}
                    title={data ? m.subtitle : `${m.label} has no data here`}
                    style={{
                      fontSize: 11, fontWeight: 700,
                      padding: '5px 12px', borderRadius: 6,
                      border: `1px solid ${on ? m.color : '#1E3A5A'}`,
                      background: on ? m.color : 'transparent',
                      color: on ? '#000' : (data ? '#E2E8F0' : '#475569'),
                      cursor: data ? 'pointer' : 'not-allowed',
                      opacity: data ? 1 : 0.5,
                    }}
                  >{m.label}</button>
                )
              })}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
            {Object.entries(windData).map(([key, point]) => (
              <WindTable
                key={key}
                locationKey={key}
                point={point}
                model={MODELS[activeModel]}
                timezone={resolvedTz}
                mastHeight={mastHeight}
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
            🌬 Wind Speed Comparison — All Locations ({MODELS[activeModel].label})
          </ChartTitle>
          <WindCompareChart windData={windData} model={MODELS[activeModel]} timezone={resolvedTz} />
        </Card>
      )}

      {/* Vertical wind profile — surface model levels + GFS pressure levels +
          theoretical neutral marine log profile at a user-selectable time. */}
      {hasResults && (
        <WindProfileSection
          windData={windData}
          model={MODELS[activeModel]}
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

function WindTable({ locationKey, point, model, timezone, mastHeight }) {
  const meta = LOCATION_META.find((m) => m.key === locationKey)
  const surf = point.surfaceByModel[model.key]
  // Speed columns = the model's display heights plus the mast height, sorted
  // ascending so the row reads low→high. The mast height is interpolated and
  // highlighted; if it coincides with a native column the two merge into one.
  // Table shows sailing-relevant heights only: drop model columns above 100 m
  // (the user's mast height is always kept, even if set higher).
  const speedHeights = Array.from(new Set([...model.tableCols.filter((h) => h <= 100), mastHeight]))
    .filter((h) => Number.isFinite(h) && h > 0)
    .sort((a, b) => a - b)

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
  const canMos = !!(spec && corr)

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
              <th style={{ ...th, color: '#34D399' }}>MOS<br /><span style={{ fontSize: 9, color: '#1f7a5a' }}>30m kt</span></th>
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
    xaxis: { title: 'Time', type: 'date' },
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

// GFS boundary layer height — one line per location.
function BoundaryLayerChart({ windData, timezone }) {
  const data = useMemo(() => {
    const traces = []
    for (const [key, point] of Object.entries(windData)) {
      const meta = LOCATION_META.find((m) => m.key === key)
      const hr = point.gfs?.hourly || {}
      const blh = hr.boundary_layer_height
      const time = hr.time
      if (!blh || !time || !blh.some((h) => h != null && h > 0)) continue
      traces.push({
        x: time.map((t) => new Date(t)),
        y: blh,
        type: 'scatter', mode: 'lines+markers',
        name: `${meta.emoji} Loc ${key}`,
        line: { color: meta.accent, width: 3 }, marker: { size: 5 },
        connectgaps: true,
      })
    }
    return traces
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windData])
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

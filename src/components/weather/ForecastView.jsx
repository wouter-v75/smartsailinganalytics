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
import {
  MODELS, MODEL_ORDER, COMPARE_ORDER,
  fetchAllForPoint, pickDefaultActiveModel, hasValidSpeed,
  kmhToKnots, decimalToDMS,
} from './openMeteo'

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

export default function ForecastView() {
  const leafletReady = useScriptsOnce([LEAFLET_JS], [LEAFLET_CSS])
  const mapDivRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef({}) // { '1': marker, '2': marker, '3': marker }

  // Form state
  const [date, setDate] = useState(today())
  const [timezone, setTimezone] = useState('auto')
  // Initial sample point — Paris, matches the standalone tool's default.
  const [locations, setLocations] = useState({ 1: { lat: 48.8566, lon: 2.3522 } })
  const [enabledModels, setEnabledModels] = useState(
    () => Object.fromEntries(COMPARE_ORDER.map((k) => [k, true]))
  )

  // Fetch state
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)
  const [windData, setWindData] = useState({}) // { '1': pointData, '2': pointData, ... }
  const [activeModel, setActiveModel] = useState('AROME')
  const [resolvedTz, setResolvedTz] = useState('UTC')

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

    // Drop the initial Paris marker.
    addMarker(map, '1', 48.8566, 2.3522)
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
    // Clear any existing windData so the table goes back to placeholder.
    setWindData((prev) => {
      const next = { ...prev }; delete next[key]; return next
    })
  }

  // ── Fetch all models for every selected location ─────────────────────
  async function fetchAll() {
    setLoading(true); setErr(null); setWindData({})
    const tz = timezone === 'auto'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : timezone
    setResolvedTz(tz)
    try {
      const out = {}
      for (const [key, coords] of Object.entries(locations)) {
        // eslint-disable-next-line no-await-in-loop
        out[key] = await fetchAllForPoint({
          latitude: coords.lat,
          longitude: coords.lon,
          timezone: tz,
          enabledModels,
        })
      }
      setWindData(out)
      const points = Object.values(out)
      setActiveModel(pickDefaultActiveModel(points))
    } catch (e) {
      setErr(e?.message || 'fetch failed')
    } finally {
      setLoading(false)
    }
  }

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
          <button
            onClick={fetchAll}
            disabled={loading || Object.keys(locations).length === 0}
            style={btnPrimary}
          >
            {loading ? 'Fetching…' : '🌬 Fetch wind data'}
          </button>
        </div>

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
              />
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

// ── Subcomponents ─────────────────────────────────────────────────────

function WindTable({ locationKey, point, model, timezone }) {
  const meta = LOCATION_META.find((m) => m.key === locationKey)
  const surf = point.surfaceByModel[model.key]
  const cols = model.tableCols // [10, c2, c3]

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

  const hourly = surf.hourly
  const rows = []
  hourly.time.forEach((timeStr, index) => {
    const date = new Date(timeStr)
    const hour = parseInt(
      date.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }),
      10
    )
    if (hour >= 8 && hour <= 18) {
      rows.push({
        time: date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone }),
        windDir: hourly.wind_direction_10m?.[index],
        speeds: cols.map((h) => hourly[`wind_speed_${h}m`]?.[index]),
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
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            <th style={th}>Time<br /><span style={{ fontSize: 9, color: '#475569' }}>{timezone}</span></th>
            <th style={th}>Dir<br /><span style={{ fontSize: 9, color: '#475569' }}>10m °</span></th>
            {cols.map((h) => (
              <th key={h} style={th}>Speed<br /><span style={{ fontSize: 9, color: '#475569' }}>{h}m kt</span></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={tdTime}>{r.time}</td>
              <td style={td}>{r.windDir != null ? String(Math.round(r.windDir)).padStart(3, '0') : '–'}</td>
              {r.speeds.map((s, j) => (
                <td key={j} style={td}>{s != null ? kmhToKnots(s).toFixed(1) : '–'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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

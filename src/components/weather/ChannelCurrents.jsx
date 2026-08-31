// ChannelCurrents.jsx — AMM15 tidal-current overlay, gated on the chosen point 1.
//
// Activates only once point 1 is set in Forecast AND point 1 is within ~50 km of
// the Channel current coverage (so it never fires for the Med venues). Loads the
// decimated ~3 km whole-Channel overview for context, and — when you zoom in —
// lazily fetches a ~20x20 km native 1.5 km clip around point 1 via /api/currents/hires
// (the full field is clipped server-side, so the phone downloads only the small box).
//
// Field shape (box-published): { units:'m/s', res_km, header:{nx,ny,lo1,la1,dx,dy},
//   times:[ISO…], frames:[{u:[],v:[]}…] }  u=eastward v=northward m/s, rows N→S.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useScriptsOnce } from './useScriptOnce'
import { addDarkBasemap } from './basemaps'
import { toVelocityData } from './windField'
import { MODELS } from './openMeteo'

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
const VELOCITY_JS = 'https://unpkg.com/leaflet-velocity@1/dist/leaflet-velocity.min.js'
const VELOCITY_CSS = 'https://unpkg.com/leaflet-velocity@1/dist/leaflet-velocity.min.css'

const KN = 1.94384
const ZOOM_HIRES = 10            // at/above this zoom, load the 20 km native clip
const TZ = 'UTC'                 // coverage spans UK + FR coasts — UTC is unambiguous

// Channel current coverage (matches the box bbox) + ~50 km buffer for the gate.
const COV = { west: -2.5, east: -1.0, south: 49.3, north: 50.8 }
const inCoverage = (lat, lon) =>
  lat >= COV.south - 0.45 && lat <= COV.north + 0.45 && lon >= COV.west - 0.7 && lon <= COV.east + 0.7

// normalise a forecast point to { lat, lon } (the picker may use lat/lon, latitude/longitude…)
function asPoint(p) {
  if (!p) return null
  const lat = p.lat ?? p.latitude ?? p.clat
  const lon = p.lon ?? p.lng ?? p.longitude ?? p.clon
  return (lat == null || lon == null) ? null : { lat: Number(lat), lon: Number(lon) }
}

// Tidal-current colour ramp: calm→strong over 0–5 kn, RED saturating at 5 kn
// (anything ≥5 kn stays red — Channel races run well past it).
const CUR_STOPS = [
  [0.0, [40, 60, 90]], [1.0, [40, 130, 190]], [2.0, [40, 180, 165]],
  [3.0, [120, 200, 85]], [4.0, [240, 190, 55]], [5.0, [220, 45, 45]],
]
const CUR_COLORSCALE = CUR_STOPS.map(([, c]) => `rgb(${c[0]},${c[1]},${c[2]})`)
function curColor(kt) {
  const S = CUR_STOPS
  if (kt <= S[0][0]) return S[0][1]
  for (let i = 1; i < S.length; i++) {
    if (kt <= S[i][0]) {
      const [k0, c0] = S[i - 1]; const [k1, c1] = S[i]; const t = (kt - k0) / (k1 - k0)
      return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * t))
    }
  }
  return S[S.length - 1][1]
}

function overviewUrl() {
  const base = MODELS.ICONRACE && MODELS.ICONRACE.bunnyBase
  return base
    ? `${base}/currents/channel/field.json`
    : `/api/bunny/storage?key=${encodeURIComponent('icon-race/currents/channel/field.json')}`
}
async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

function localLabel(iso) {
  if (!iso) return ''
  const d = new Date(iso.endsWith('Z') ? iso : `${iso}Z`)
  return d.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ })
}

// bilinear sample -> { kt, toward } (compass heading the flow goes TOWARD)
function sampleCurrent(field, idx, lat, lon) {
  if (!field || !field.frames || !field.frames[idx]) return null
  const { nx, ny, lo1, la1, dx, dy } = field.header
  const cx = (lon - lo1) / dx; const cy = (la1 - lat) / dy
  if (cx < 0 || cx > nx - 1 || cy < 0 || cy > ny - 1) return null
  const x0 = Math.floor(cx); const y0 = Math.floor(cy)
  const x1 = Math.min(x0 + 1, nx - 1); const y1 = Math.min(y0 + 1, ny - 1)
  const fx = cx - x0; const fy = cy - y0; const f = field.frames[idx]
  const bil = (a) => (a[y0 * nx + x0] * (1 - fx) + a[y0 * nx + x1] * fx) * (1 - fy)
    + (a[y1 * nx + x0] * (1 - fx) + a[y1 * nx + x1] * fx) * fy
  const u = bil(f.u); const v = bil(f.v)
  return { kt: Math.hypot(u, v) * KN, toward: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360 }
}

export default function ChannelCurrents({ point1 = null }) {
  const p1 = useMemo(() => asPoint(point1), [point1])
  const covered = !!(p1 && inCoverage(p1.lat, p1.lon))

  const leafletReady = useScriptsOnce([LEAFLET_JS], [LEAFLET_CSS])
  const [velReady, setVelReady] = useState(false)
  const mapDivRef = useRef(null); const mapRef = useRef(null); const layerRef = useRef(null)
  const fieldsRef = useRef({})            // { overview, hires } cached
  const [field, setField] = useState(null)
  const [tier, setTier] = useState('overview')
  const [err, setErr] = useState('')
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [cursor, setCursor] = useState(null)

  // leaflet-velocity after Leaflet
  useEffect(() => {
    if (!leafletReady) return
    if (window.L && window.L.velocityLayer) { setVelReady(true); return }
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = VELOCITY_CSS; document.head.appendChild(css)
    const s = document.createElement('script'); s.src = VELOCITY_JS
    s.onload = () => { if (window.L && window.L.velocityLayer) setVelReady(true) }
    document.body.appendChild(s)
  }, [leafletReady])

  // load overview once point 1 is covered
  useEffect(() => {
    if (!covered) return
    let alive = true
    getJSON(overviewUrl())
      .then((j) => { if (!alive) return; fieldsRef.current.overview = j; setField((f) => f || j) })
      .catch(() => { if (alive) setErr('Could not load current data') })
    return () => { alive = false }
  }, [covered])

  // init map centred on point 1
  useEffect(() => {
    if (!leafletReady || !covered || !field || mapRef.current || !mapDivRef.current) return
    const L = window.L
    const map = L.map(mapDivRef.current, { zoomControl: true, attributionControl: false })
    addDarkBasemap(L, map, { maxZoom: 13 })
    map.setView([p1.lat, p1.lon], 9)
    L.circleMarker([p1.lat, p1.lon], { radius: 6, color: '#EF4444', weight: 2, fillOpacity: 0.6 }).addTo(map)
    mapRef.current = map

    map.on('zoomend', async () => {
      const hi = map.getZoom() >= ZOOM_HIRES
      if (hi && tier !== 'hires') {
        if (fieldsRef.current.hires) { setField(fieldsRef.current.hires); setTier('hires'); return }
        try {
          const j = await getJSON(`/api/currents/hires?lat=${p1.lat}&lon=${p1.lon}`)
          fieldsRef.current.hires = j; setField(j); setTier('hires')
        } catch { /* stay on overview */ }
      } else if (!hi && tier !== 'overview' && fieldsRef.current.overview) {
        setField(fieldsRef.current.overview); setTier('overview')
      }
    })
    map.on('mousemove', (e) => setCursor({ lat: e.latlng.lat, lon: e.latlng.lng }))
    map.on('mouseout', () => setCursor(null))
    return () => { try { map.remove() } catch { /* */ } mapRef.current = null }
  }, [leafletReady, covered, field])

  // Open on the frame nearest NOW (clamps to the newest frame when the whole
  // published window is in the past — i.e. stale data). Beats always starting at
  // frame 0, which showed the OLDEST time in the file.
  useEffect(() => {
    const t = field?.times || []
    if (!t.length) return
    const ms = (x) => Date.parse(x.endsWith('Z') ? x : `${x}Z`)
    const now = Date.now()
    let best = 0, bd = Infinity
    for (let i = 0; i < t.length; i++) { const d = Math.abs(ms(t[i]) - now); if (d < bd) { bd = d; best = i } }
    setIdx(best)
  }, [field])

  // Freshness of the PUBLISHED current product. It's a box product (CMEMS AMM15),
  // so if that pipeline stalls the app must say so rather than pass off old tide.
  const freshness = useMemo(() => {
    const t = field?.times || []
    if (!t.length) return null
    const ms = (x) => Date.parse(x.endsWith('Z') ? x : `${x}Z`)
    const first = ms(t[0]), last = ms(t[t.length - 1])
    const updated = field?.updated ? Date.parse(field.updated) : null
    const now = Date.now()
    const stale = (Number.isFinite(last) && last < now - 3 * 3600e3) || (updated != null && now - updated > 36 * 3600e3)
    const dfmt = (m) => new Date(m).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ })
    const range = Number.isFinite(first)
      ? (new Date(first).toDateString() === new Date(last).toDateString() ? dfmt(first) : `${dfmt(first)} \u2192 ${dfmt(last)}`)
      : ''
    const upd = updated ? new Date(updated).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ }) : null
    return { stale, range, upd }
  }, [field])

  // draw/update velocity layer
  useEffect(() => {
    const map = mapRef.current
    if (!map || !velReady || !field || !window.L) return
    const L = window.L
    const data = toVelocityData(field.frames[idx], field.header, field.times[idx])
    if (!layerRef.current) {
      layerRef.current = L.velocityLayer({
        displayValues: false, data, maxVelocity: 2.6, velocityScale: 0.016,
        particleMultiplier: 1 / 250, lineWidth: 1.4, colorScale: CUR_COLORSCALE,
      }).addTo(map)
    } else {
      layerRef.current.setData(data)
    }
  }, [velReady, field, idx])

  useEffect(() => {
    if (!playing || !field) return
    const id = setInterval(() => setIdx((i) => (i + 1) % field.times.length), 700)
    return () => clearInterval(id)
  }, [playing, field])

  const reading = useMemo(() => {
    if (!cursor || !field) return null
    const r = sampleCurrent(field, idx, cursor.lat, cursor.lon)
    return r ? { ...r, ...cursor } : null
  }, [cursor, field, idx])

  // ── gates ──────────────────────────────────────────────────────────────────
  if (!p1) {
    return <Notice>Set <strong>point 1</strong> in Forecast to view tidal currents. Currents are available for the English Channel.</Notice>
  }
  if (!covered) {
    return <Notice>Point 1 isn’t in the Channel current coverage. Tidal currents are available for the English Channel (Cherbourg ↔ Isle of Wight).</Notice>
  }

  const times = field?.times || []
  return (
    <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: '#E2E8F0' }}>🌊 Tidal currents — English Channel</span>
        <span style={{ fontSize: 11, color: '#8A97A9' }}>
          CMEMS AMM15 {field?.res_km ? `· ~${field.res_km} km` : ''} · total current (tide + weather) · times UTC
        </span>
      </div>
      {freshness && (
        <div style={{ fontSize: 11, borderRadius: 8,
          color: freshness.stale ? '#FCA5A5' : '#94A3B8',
          background: freshness.stale ? '#3B0D0D' : 'transparent',
          border: freshness.stale ? '1px solid #7F1D1D' : 'none',
          padding: freshness.stale ? '6px 9px' : 0 }}>
          {freshness.stale ? '\u26A0 Tidal-current data is STALE' : 'Data'} \u00b7 covers {freshness.range}{freshness.upd ? ` \u00b7 generated ${freshness.upd}` : ''}
          {freshness.stale ? ' \u2014 the currents product has not refreshed (box pipeline; the live wind is separate). Treat with caution.' : ''}
        </div>
      )}
      {err && <div style={{ color: '#F87171', fontSize: 12 }}>{err}</div>}

      <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', border: '1px solid #1E3A5A' }}>
        <div ref={mapDivRef} style={{ height: 460, width: '100%', background: '#06101C' }} />
        <div style={{ position: 'absolute', right: 10, bottom: 10, zIndex: 500, background: '#0A1929E6', border: '1px solid #1E3A5A', borderRadius: 8, padding: '7px 9px' }}>
          <div style={{ fontSize: 10, color: '#94A3B8', marginBottom: 4 }}>current (kn)</div>
          {[1, 2, 3, 4, 5].map((kt) => {
            const c = curColor(kt)
            return (
              <div key={kt} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#CBD5E1' }}>
                <span style={{ width: 14, height: 8, borderRadius: 2, background: `rgb(${c[0]},${c[1]},${c[2]})` }} />{kt}
              </div>
            )
          })}
        </div>
        {reading && (
          <div style={{ position: 'absolute', left: 10, top: 10, zIndex: 500, background: '#0A1929E6', border: '1px solid #1E3A5A', borderRadius: 8, padding: '6px 9px', fontSize: 12, color: '#E2E8F0' }}>
            <strong>{reading.kt.toFixed(1)} kn</strong><span style={{ color: '#94A3B8' }}> → {Math.round(reading.toward)}°T</span>
          </div>
        )}
        <div style={{ position: 'absolute', left: 10, bottom: 10, zIndex: 500, fontSize: 10, color: tier === 'hires' ? '#7DD3FC' : '#64748B', background: '#0A1929E6', border: '1px solid #1E3A5A', borderRadius: 6, padding: '2px 6px' }}>
          {tier === 'hires' ? 'native ~1.5 km (20 km box)' : '~3 km overview · zoom in for detail'}
        </div>
      </div>

      {times.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => setPlaying((p) => !p)}
            style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 12, background: playing ? '#06B6D4' : '#0F2A45', color: playing ? '#000' : '#94A3B8' }}>
            {playing ? '❚❚' : '▶'}
          </button>
          <input type="range" min={0} max={times.length - 1} value={idx}
            onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)) }} style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: '#E2E8F0', minWidth: 116, textAlign: 'right' }}>{localLabel(times[idx])}</span>
        </div>
      )}

      <div style={{ fontSize: 10, color: '#64748B', lineHeight: 1.5 }}>
        Particles show flow direction; colour = speed (knots). Zoom in for the native ~1.5 km detail around point 1.
        Named tidal races (Raz Blanchard, Cap de la Hague) are <strong>model-smoothed</strong> — treat peak speeds there as
        conservative. Source: CMEMS NWS FOAM-AMM15, hourly, tide-coupled.
      </div>
    </div>
  )
}

function Notice({ children }) {
  return (
    <div style={{ padding: 30, textAlign: 'center', color: '#94A3B8', fontSize: 13, maxWidth: 520, margin: '0 auto', lineHeight: 1.6 }}>
      {children}
    </div>
  )
}

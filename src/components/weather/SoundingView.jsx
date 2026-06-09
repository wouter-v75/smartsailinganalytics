// Sounding sub-tab of WeatherTab — Phase 3.
//
// Native React port of the Skew-T Log-P sounding from the standalone weather
// tool (Smart Sailing Analytics/index.html, v1.3, ~lines 1308-1790). The chart
// itself is hand-rolled D3 v7 (no third-party skewt library) — isobars, skewed
// isotherms, dry adiabats, temperature / dew-point profiles, wind barbs, a
// Windy-style hover crosshair with a dynamically lifted parcel, and wheel/drag
// zoom. Surface-parcel convective indices (LCL / CCL / convective temperature)
// are printed under the chart.
//
// Data comes from the shared windData payload fetched in Forecast. The Skew-T
// follows the chosen source (GFS dense pressure ladder, or ICON / ECMWF upper
// air); a Leaflet picker lets the user drop a 4th "Selected sounding position"
// that is fetched on demand. D3 is lazy-loaded from CDN via useScriptsOnce —
// no new npm dep, matching the Leaflet / Plotly approach used elsewhere.
//
// The diagram is drawn on a white panel (classic meteorological convention,
// and what users see in v1.3); the surrounding controls/chrome stay on SSA's
// dark theme.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useScriptsOnce } from './useScriptOnce'
import {
  SOUNDING_SOURCES, SOUNDING_ORDER,
  fetchSoundingPoint, decimalToDMS,
} from './openMeteo'

const D3_JS = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js'
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'

const LOCATION_META = {
  '1': { emoji: '🔴', label: 'Location 1', color: '#e74c3c' },
  '2': { emoji: '🟢', label: 'Location 2', color: '#27ae60' },
  '3': { emoji: '🟠', label: 'Location 3', color: '#f39c12' },
  'S': { emoji: '📍', label: 'Selected sounding position', color: '#3498db' },
}

const SKEWT_PTOP = 500   // top of the diagram (hPa)
const SKEWT_PBOT = 1050  // bottom of the diagram (hPa)

// ── Thermodynamics / data shaping (ported verbatim from index.html) ──────────

function dewpointFromRH(tempC, rh) {
  const a = 17.625, b = 243.04
  const r = Math.max(1, Math.min(100, rh))
  const alpha = Math.log(r / 100) + (a * tempC) / (b + tempC)
  return (b * alpha) / (a - alpha)
}

// Does a source have usable sounding data at the selected time?
function hasSounding(point, srcKey, idx) {
  const src = SOUNDING_SOURCES[srcKey]
  const h = src && point && src.hourly(point)
  if (!h) return false
  return src.levels.some((p) => {
    const t = h[`temperature_${p}hPa`]
    return t && t[idx] != null
  })
}

// Build a GSD-style sounding array (surface → top) for a point/source/time.
function buildSounding(point, srcKey, idx) {
  const src = SOUNDING_SOURCES[srcKey]
  const h = src.hourly(point)
  const arr = []
  src.levels.forEach((p) => {
    const t = h[`temperature_${p}hPa`]?.[idx]
    const gh = h[`geopotential_height_${p}hPa`]?.[idx]
    if (t == null || gh == null) return
    const rh = h[`relative_humidity_${p}hPa`]?.[idx]
    const ws = h[`wind_speed_${p}hPa`]?.[idx]   // km/h
    const wd = h[`wind_direction_${p}hPa`]?.[idx]
    const dwpt = rh != null ? Math.min(dewpointFromRH(t, rh), t) : t
    arr.push({
      press: p,
      hght: gh,
      temp: t,
      dwpt,
      wdir: wd != null ? wd : 0,
      wspd: ws != null ? ws / 3.6 : 0,          // km/h → m/s
    })
  })
  return arr
}

// Pseudo-adiabatic lapse rate dT/dP (K per hPa) for a saturated parcel.
function moistLapseDtDp(Tk, pHpa) {
  const eps = 0.622, Lv = 2.501e6, Rd = 287.05, cpd = 1005.7
  const Tc = Tk - 273.15
  const es = 6.112 * Math.exp(17.67 * Tc / (Tc + 243.5))
  const rs = eps * es / Math.max(pHpa - es, 1e-6)
  const num = Rd * Tk + Lv * rs
  const den = cpd + (Lv * Lv * rs * eps) / (Rd * Tk * Tk)
  return (num / den) / pHpa
}

// Parcel through an anchor (Ta °C, Pa hPa): dry adiabat below, moist above.
function parcelThrough(Ta, Pa, P0) {
  if (!isFinite(Ta) || !isFinite(Pa)) return []
  const pts = []
  const thetaK = (Ta + 273.15) * Math.pow(1000 / Pa, 0.2854)
  for (let p = P0; p > Pa; p -= 5) pts.push({ press: p, temp: thetaK * Math.pow(p / 1000, 0.2854) - 273.15 })
  pts.push({ press: Pa, temp: Ta })
  let Tk = Ta + 273.15, p = Pa
  while (p > SKEWT_PTOP) {
    const dp = Math.min(5, p - SKEWT_PTOP)
    Tk = Tk - moistLapseDtDp(Tk, p) * dp
    p -= dp
    pts.push({ press: p, temp: Tk - 273.15 })
  }
  return pts
}

// Isotherm (constant temperature) from a point down to the surface.
function surfaceIsotherm(Tc, Plevel, P0) {
  return [{ press: Plevel, temp: Tc }, { press: P0, temp: Tc }]
}

// Surface-parcel convective indices: LCL, CCL and convective temperature.
function computeConvectiveIndices(data) {
  if (!data || data.length < 3) return null
  const sfc = data[0]
  const P0 = sfc.press, T0 = sfc.temp, Td0 = Math.min(sfc.dwpt, sfc.temp)
  const T0K = T0 + 273.15, Td0K = Td0 + 273.15
  if (!isFinite(T0K) || !isFinite(Td0K)) return null

  const interp = (Pt, key) => {
    if (Pt >= data[0].press) return data[0][key]
    if (Pt <= data[data.length - 1].press) return data[data.length - 1][key]
    for (let i = 0; i < data.length - 1; i++) {
      const a = data[i], b = data[i + 1]
      if (Pt <= a.press && Pt >= b.press) {
        const f = (Math.log(Pt) - Math.log(a.press)) / (Math.log(b.press) - Math.log(a.press))
        return a[key] + f * (b[key] - a[key])
      }
    }
    return null
  }

  const Tlcl = 1 / (1 / (Td0K - 56) + Math.log(T0K / Td0K) / 800) + 56
  const Plcl = P0 * Math.pow(Tlcl / T0K, 3.504)
  const Hlcl = interp(Plcl, 'hght')

  const es0 = 6.112 * Math.exp(17.67 * Td0 / (Td0 + 243.5))
  const w0 = 0.622 * es0 / Math.max(P0 - es0, 1e-6)
  const tIso = (p) => { const es = w0 * p / (0.622 + w0); const ln = Math.log(es / 6.112); return 243.5 * ln / (17.67 - ln) }
  let Pccl = null
  for (let i = 0; i < data.length - 1; i++) {
    const a = data[i], b = data[i + 1]
    if (a.press === b.press) continue
    const da = tIso(a.press) - a.temp, db = tIso(b.press) - b.temp
    if (da <= 0 && db >= 0) {
      const f = da / (da - db)
      Pccl = Math.exp(Math.log(a.press) + f * (Math.log(b.press) - Math.log(a.press)))
      break
    }
  }

  let Tcon = null, Hccl = null
  if (Pccl) {
    Hccl = interp(Pccl, 'hght')
    const TenvCCL = interp(Pccl, 'temp')
    const theta = (TenvCCL + 273.15) * Math.pow(1000 / Pccl, 0.2854)
    Tcon = theta * Math.pow(P0 / 1000, 0.2854) - 273.15
  }
  return { Plcl, Hlcl, Pccl, Hccl, Tcon }
}

// Standard meteorological wind barb (knots). Staff points toward wind source.
function drawBarb(g, cx, cy, dir, kt) {
  const grp = g.append('g').attr('class', 'sktx-barb').attr('transform', `translate(${cx},${cy}) rotate(${dir})`)
  if (kt < 2.5) { grp.append('circle').attr('r', 3).attr('fill', 'none'); return }
  const L = 24, step = 4
  grp.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', -L)
  let spd = Math.round(kt / 5) * 5, pos = -L
  const f50 = Math.floor(spd / 50); spd -= f50 * 50
  const f10 = Math.floor(spd / 10); spd -= f10 * 10
  const f5 = Math.floor(spd / 5)
  for (let i = 0; i < f50; i++) { grp.append('polygon').attr('points', `0,${pos} 10,${pos + 2} 0,${pos + 5}`); pos += 6 }
  for (let i = 0; i < f10; i++) { grp.append('line').attr('x1', 0).attr('y1', pos).attr('x2', 10).attr('y2', pos - 3); pos += step }
  for (let i = 0; i < f5; i++)  { grp.append('line').attr('x1', 0).attr('y1', pos).attr('x2', 5).attr('y2', pos - 2); pos += step }
}

// The full Skew-T draw — imperative D3 into `container`. Ported from drawSkewT.
function drawSkewT(container, data) {
  const d3 = window.d3
  const W = Math.max(360, Math.min(560, container.clientWidth || 520))
  const H = Math.round(W * 0.96)
  const m = { top: 16, right: 140, bottom: 38, left: 44 }
  const w = W - m.left - m.right, h = H - m.top - m.bottom

  const y = d3.scaleLog().domain([SKEWT_PBOT, SKEWT_PTOP]).range([h, 0])
  const x = d3.scaleLinear().domain([-10, 35]).range([0, w])
  const SK = (0.55 * w) / h
  const sx = (t, p) => x(t) + (h - y(p)) * SK

  const svg = d3.select(container).append('svg')
    .attr('width', W).attr('height', H)
    .attr('viewBox', `0 0 ${W} ${H}`).style('max-width', '100%').style('height', 'auto')
  const outer = svg.append('g').attr('transform', `translate(${m.left},${m.top})`)
  const g = outer.append('g')

  const clipId = 'sktxclip-' + Math.random().toString(36).slice(2, 8)
  g.append('clipPath').attr('id', clipId).append('rect').attr('width', w).attr('height', h)
  const plot = g.append('g').attr('clip-path', `url(#${clipId})`)

  // Isobars + pressure labels
  ;[1000, 950, 900, 850, 800, 750, 700, 650, 600, 550, 500].forEach((P) => {
    plot.append('line').attr('class', 'sktx-isobar').attr('x1', 0).attr('x2', w).attr('y1', y(P)).attr('y2', y(P))
    g.append('text').attr('class', 'sktx-label').attr('x', -6).attr('y', y(P)).attr('text-anchor', 'end').attr('dy', '0.32em').text(P)
  })

  // Skewed isotherms (every 10 °C)
  d3.range(-120, 61, 10).forEach((T) => {
    plot.append('line')
      .attr('class', T === 0 ? 'sktx-isotherm-zero' : 'sktx-isotherm')
      .attr('x1', sx(T, SKEWT_PBOT)).attr('y1', h)
      .attr('x2', sx(T, SKEWT_PTOP)).attr('y2', 0)
  })

  // Light dry adiabats
  const line = d3.line().x((d) => d[0]).y((d) => d[1])
  const pgrid = d3.range(SKEWT_PBOT, SKEWT_PTOP - 1, -10)
  d3.range(-20, 160, 20).forEach((theta) => {
    const pts = pgrid.map((p) => {
      const T = (theta + 273.15) * Math.pow(p / 1000, 0.286) - 273.15
      return [sx(T, p), y(p)]
    })
    plot.append('path').attr('class', 'sktx-dryadiabat').attr('d', line(pts))
  })

  // Temperature & dew-point profiles
  plot.append('path').datum(data).attr('class', 'sktx-temp')
    .attr('d', d3.line().x((d) => sx(d.temp, d.press)).y((d) => y(d.press)))
  plot.append('path').datum(data).attr('class', 'sktx-dwpt')
    .attr('d', d3.line().x((d) => sx(d.dwpt, d.press)).y((d) => y(d.press)))

  const parcelPath = plot.append('path').attr('class', 'sktx-parcel').style('display', 'none')
  const dewLine = plot.append('path').attr('class', 'sktx-dewline').style('display', 'none')

  // Temperature axis (bottom)
  g.append('g').attr('class', 'sktx-axis').attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(x).tickValues(d3.range(-10, 36, 5)).tickFormat((d) => d + '°'))
  g.append('text').attr('class', 'sktx-label').attr('x', w / 2).attr('y', h + 34).attr('text-anchor', 'middle').text('Temperature (°C)')

  // Wind barbs on the right margin
  const bx = w + 22
  g.append('text').attr('class', 'sktx-label').attr('x', bx).attr('y', -4).attr('text-anchor', 'middle').text('kt')
  data.forEach((d) => {
    if (d.wdir == null) return
    drawBarb(g, bx, y(d.press), d.wdir, d.wspd * 1.94384)
  })

  // Interactive crosshair (Windy-style)
  const focus = g.append('g').style('display', 'none')
  const hline = focus.append('line').attr('class', 'sktx-cursorline').attr('x1', 0).attr('x2', w)
  const mT = focus.append('circle').attr('class', 'sktx-marker-temp').attr('r', 4)
  const mD = focus.append('circle').attr('class', 'sktx-marker-dwpt').attr('r', 4)
  const tipG = focus.append('g')
  tipG.append('rect').attr('class', 'sktx-tip-box').attr('rx', 4).attr('width', 84).attr('height', 90)
  const tipText = tipG.append('text').attr('class', 'sktx-tip')

  const P0 = data[0].press
  const parcelLine = d3.line().x((o) => sx(o.temp, o.press)).y((o) => y(o.press))

  g.append('rect').attr('width', w).attr('height', h)
    .style('fill', 'none').style('pointer-events', 'all')
    .on('mouseover', () => { focus.style('display', null); parcelPath.style('display', null); dewLine.style('display', null) })
    .on('mouseout', () => { focus.style('display', 'none'); parcelPath.style('display', 'none'); dewLine.style('display', 'none') })
    .on('mousemove', function (ev) {
      const [mx, my] = d3.pointer(ev, this)
      const pCursor = y.invert(my)
      let d = data[0], best = Infinity
      data.forEach((o) => { const diff = Math.abs(o.press - pCursor); if (diff < best) { best = diff; d = o } })
      const yy = y(d.press)
      hline.attr('y1', yy).attr('y2', yy)
      mT.attr('cx', sx(d.temp, d.press)).attr('cy', yy)
      mD.attr('cx', sx(d.dwpt, d.press)).attr('cy', yy)

      const dewPts = surfaceIsotherm(d.temp, d.press, P0)
      dewLine.attr('d', parcelLine(dewPts))
      const sfcVal = dewPts.length ? dewPts[dewPts.length - 1].temp : d.temp

      const rows = [
        `${Math.round(d.press)} hPa`,
        `${Math.round(d.hght)} m`,
        `T ${d.temp.toFixed(1)}°`,
        `Td ${d.dwpt.toFixed(1)}°`,
        `${Math.round(d.wspd * 1.94384)}kt ${Math.round(d.wdir)}°`,
        `sfc ${Math.round(sfcVal)}°`,
      ]
      tipText.selectAll('tspan').remove()
      rows.forEach((r, i) => tipText.append('tspan').attr('x', 6).attr('y', 13 + i * 14).text(r))

      const boxH = 90
      const tx = w + 50
      const ty = Math.max(2, Math.min(yy - boxH / 2, h - boxH - 2))
      tipG.attr('transform', `translate(${tx},${ty})`)

      const Pa = Math.min(pCursor, P0)
      const Ta = x.invert(mx - (h - y(Pa)) * SK)
      const pp = parcelThrough(Ta, Pa, P0).filter((o) => o.press >= SKEWT_PTOP && o.press <= P0 + 1)
      parcelPath.attr('d', parcelLine(pp))
    })

  // Wheel zoom / drag pan / double-click reset
  const zoom = d3.zoom()
    .scaleExtent([1, 10])
    .translateExtent([[-60, -40], [w + 100, h + 50]])
    .on('zoom', (ev) => g.attr('transform', ev.transform))
  svg.call(zoom).on('dblclick.zoom', () =>
    svg.transition().duration(200).call(zoom.transform, d3.zoomIdentity))
}

// ── React component ──────────────────────────────────────────────────────────

export default function SoundingView({ windData = {}, resolvedTz = 'UTC' }) {
  const d3Ready = useScriptsOnce([D3_JS])
  const leafletReady = useScriptsOnce([LEAFLET_JS], [LEAFLET_CSS])

  // A user-picked 4th sounding point, fetched on demand (the 'S' key).
  const [extraPoint, setExtraPoint] = useState(null)
  const [source, setSource] = useState('GFS')
  const [locKey, setLocKey] = useState(null)
  const [timeIdx, setTimeIdx] = useState(0)
  const [note, setNote] = useState('Defaults to your analysis area; the picked point is added as "Selected sounding position".')
  const [fetching, setFetching] = useState(false)
  const [indices, setIndices] = useState('')
  const [chartW, setChartW] = useState(0)

  const mapDivRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef({})
  const selMarkerRef = useRef(null)
  const chartRef = useRef(null)

  const dataFor = (k) => (k === 'S' ? extraPoint : windData[k])

  // Selectable locations: fetched analysis points + the picked one.
  const locKeys = useMemo(
    () => [...Object.keys(windData), ...(extraPoint ? ['S'] : [])],
    [windData, extraPoint],
  )

  // Source list — only sources that have data somewhere; default order keeps GFS first.
  const availableSources = useMemo(() => {
    const avail = SOUNDING_ORDER.filter((k) => locKeys.some((loc) => hasSounding(dataFor(loc), k, timeIdx)))
    return avail.length ? avail : SOUNDING_ORDER
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locKeys, windData, extraPoint, timeIdx])

  // Keep selections valid as data changes.
  useEffect(() => {
    if (!locKeys.length) { setLocKey(null); return }
    if (!locKey || !locKeys.includes(locKey)) setLocKey(locKeys[0])
  }, [locKeys, locKey])
  useEffect(() => {
    if (!availableSources.includes(source)) setSource(availableSources[0])
  }, [availableSources, source])

  // Time axis for the active source/location (falls back to any source's grid).
  const times = useMemo(() => {
    const direct = locKey != null && SOUNDING_SOURCES[source].hourly(dataFor(locKey))?.time
    if (direct?.length) return direct
    for (const loc of locKeys) {
      for (const k of SOUNDING_ORDER) {
        const t = SOUNDING_SOURCES[k].hourly(dataFor(loc))?.time
        if (t?.length) return t
      }
    }
    return []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locKey, source, windData, extraPoint, locKeys])
  useEffect(() => { if (timeIdx >= times.length) setTimeIdx(0) }, [times, timeIdx])

  // ── Leaflet picker map ────────────────────────────────────────────────
  useEffect(() => {
    if (!leafletReady || !mapDivRef.current || mapRef.current) return
    const L = window.L
    if (!L) return
    const map = L.map(mapDivRef.current)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap', maxZoom: 18,
    }).addTo(map)
    map.on('click', (e) => addSoundingPoint(e.latlng.lat, e.latlng.lng))
    mapRef.current = map
    setTimeout(() => { try { map.invalidateSize() } catch { /* ignore */ } }, 120)
    return () => { try { map.remove() } catch { /* ignore */ } ; mapRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafletReady])

  // Place / refresh the analysis-point markers and frame them.
  useEffect(() => {
    const map = mapRef.current, L = window.L
    if (!map || !L) return
    Object.values(markersRef.current).forEach((mk) => map.removeLayer(mk))
    markersRef.current = {}
    const latlngs = []
    for (const k of Object.keys(windData)) {
      const c = windData[k]?.coords
      if (!c) continue
      const meta = LOCATION_META[k] || { color: '#3498db' }
      const cm = L.circleMarker([c.latitude, c.longitude], {
        radius: 7, color: '#fff', weight: 2, fillColor: meta.color, fillOpacity: 1,
      }).bindTooltip(`Location ${k}`).addTo(map)
      markersRef.current[k] = cm
      latlngs.push([c.latitude, c.longitude])
    }
    if (latlngs.length === 1) map.setView(latlngs[0], 9)
    else if (latlngs.length > 1) map.fitBounds(latlngs, { padding: [30, 30], maxZoom: 10 })
    else map.setView([48.8566, 2.3522], 5)
    setTimeout(() => { try { map.invalidateSize() } catch { /* ignore */ } }, 120)
  }, [windData, leafletReady])

  async function addSoundingPoint(lat, lon) {
    const map = mapRef.current, L = window.L
    if (!map || !L) return
    if (selMarkerRef.current) map.removeLayer(selMarkerRef.current)
    selMarkerRef.current = L.marker([lat, lon]).addTo(map).bindTooltip('Selected sounding').openTooltip()
    setFetching(true)
    setNote('Fetching sounding for the picked point…')
    try {
      const tz = resolvedTz || 'UTC'
      const pt = await fetchSoundingPoint({ latitude: lat, longitude: lon, timezone: tz })
      setExtraPoint(pt)
      setLocKey('S')
      setNote(`Selected: ${decimalToDMS(lat, false)}, ${decimalToDMS(lon, true)} — shown as "Selected sounding position".`)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Sounding point fetch failed:', err)
      setNote('Could not fetch the sounding for that point — try again.')
    } finally {
      setFetching(false)
    }
  }

  // ── Skew-T render ─────────────────────────────────────────────────────
  useEffect(() => {
    const el = chartRef.current
    if (!el) return
    el.innerHTML = ''
    setIndices('')
    if (!d3Ready || !window.d3) {
      el.innerHTML = placeholderHTML('⚠️', 'D3 failed to load', 'Check your connection and reload.')
      return
    }
    if (locKey == null || !dataFor(locKey)) {
      el.innerHTML = placeholderHTML('🎈', 'No sounding yet', 'Fetch wind data in Forecast, or pick a point on the map.')
      return
    }
    if (!hasSounding(dataFor(locKey), source, timeIdx)) {
      el.innerHTML = placeholderHTML('🚫', `No ${SOUNDING_SOURCES[source].label} data here`, 'Try a different source for this point/time.')
      return
    }
    const data = buildSounding(dataFor(locKey), source, timeIdx)
      .filter((d) => d.press >= SKEWT_PTOP)
      .sort((a, b) => b.press - a.press)
    if (data.length < 3) {
      el.innerHTML = placeholderHTML('❌', 'Not enough levels', 'This source has too few pressure levels here.')
      return
    }
    drawSkewT(el, data)

    const ci = computeConvectiveIndices(data)
    const fmtH = (v) => (v != null && isFinite(v)) ? `${Math.round(v)} m` : '—'
    const fmtT = (v) => (v != null && isFinite(v)) ? `${Math.round(v)} °C` : '—'
    setIndices(ci ? `TCON: ${fmtT(ci.Tcon)}  ·  CCL: ${fmtH(ci.Hccl)}  ·  LCL: ${fmtH(ci.Hlcl)}` : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d3Ready, locKey, source, timeIdx, extraPoint, windData, chartW])

  // Redraw when the chart container resizes (sub-tab open, window resize).
  useEffect(() => {
    const el = chartRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let last = el.clientWidth
    const ro = new ResizeObserver(() => {
      const wNow = el.clientWidth
      if (Math.abs(wNow - last) > 8) { last = wNow; setChartW(wNow) }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const tzLabel = resolvedTz === 'UTC' ? 'UTC' : resolvedTz
  const hasAny = locKeys.length > 0

  return (
    <div className="ssa-skewt" style={{ padding: '16px 20px 40px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{SKEWT_CSS}</style>

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0' }}>🎈 Atmospheric Sounding — Skew-T Log-P</span>
          <span style={{ fontSize: 11, color: '#64748B' }}>
            Hover for a parcel + readout · wheel to zoom · drag to pan · double-click resets
          </span>
        </div>

        {!hasAny && (
          <div style={{ fontSize: 13, color: '#94A3B8', textAlign: 'center', padding: 20 }}>
            No data yet. Open the <b>Forecast</b> tab, pick locations and hit <b>Fetch wind data</b> — or click the map
            below to fetch a one-off sounding point.
          </div>
        )}

        {/* Controls */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
          <Field label="📍 Location">
            <select value={locKey ?? ''} onChange={(e) => setLocKey(e.target.value)} style={inputStyle} disabled={!locKeys.length}>
              {locKeys.length === 0 && <option value="">—</option>}
              {locKeys.map((k) => (
                <option key={k} value={k}>{(LOCATION_META[k]?.emoji || '📍')} {LOCATION_META[k]?.label || `Location ${k}`}</option>
              ))}
            </select>
          </Field>
          <Field label="🛰️ Source">
            <select value={source} onChange={(e) => setSource(e.target.value)} style={inputStyle}>
              {availableSources.map((k) => <option key={k} value={k}>{SOUNDING_SOURCES[k].label}</option>)}
            </select>
          </Field>
          <Field label="📅 Time">
            <select value={timeIdx} onChange={(e) => setTimeIdx(Number(e.target.value))} style={inputStyle} disabled={!times.length}>
              {times.length === 0 && <option value={0}>No times</option>}
              {times.map((t, i) => (
                <option key={i} value={i}>
                  {new Date(t).toLocaleString('en-GB', { timeZone: resolvedTz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  {resolvedTz === 'UTC' ? ' UTC' : ''}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      {/* Two-column: picker map (left) + Skew-T (right) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14, alignItems: 'start' }}>
        <Card>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
            🗺 Pick a sounding point
          </div>
          <div
            ref={mapDivRef}
            style={{ width: '100%', height: 420, borderRadius: 10, overflow: 'hidden', border: '1px solid #1E3A5A', background: '#0A1929' }}
          />
          <div style={{ fontSize: 11, color: fetching ? '#F59E0B' : '#7f8c8d', textAlign: 'center', marginTop: 8 }}>{note}</div>
        </Card>

        <Card>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
            Skew-T — {locKey != null ? (LOCATION_META[locKey]?.label || `Location ${locKey}`) : '—'} · {SOUNDING_SOURCES[source]?.label} · {tzLabel}
          </div>
          {/* White meteorological panel for the diagram */}
          <div style={{ background: '#ffffff', borderRadius: 8, padding: 8, minHeight: 360, display: 'flex', justifyContent: 'center' }}>
            <div ref={chartRef} style={{ width: '100%', display: 'flex', justifyContent: 'center' }} />
          </div>
          {indices && (
            <div style={{ textAlign: 'center', fontSize: 13, color: '#E2E8F0', marginTop: 12, fontWeight: 700 }}>{indices}</div>
          )}
        </Card>
      </div>
    </div>
  )
}

// Placeholder block matching the standalone tool's empty states. Rendered on
// the white diagram panel, so the text colours are dark.
function placeholderHTML(icon, text, sub) {
  return (
    `<div style="text-align:center;color:#475569;padding:40px 16px">` +
    `<div style="font-size:30px;margin-bottom:8px">${icon}</div>` +
    `<div style="font-size:14px;font-weight:700;color:#334155">${text}</div>` +
    (sub ? `<div style="font-size:11px;margin-top:6px;color:#64748B">${sub}</div>` : '') +
    `</div>`
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

const inputStyle = {
  background: '#071624', border: '1px solid #1E3A5A', borderRadius: 6,
  color: '#E2E8F0', padding: '6px 9px', fontSize: 13,
}

// Skew-T SVG styling — ported from the .sktx-* rules in index.html. Scoped under
// .ssa-skewt so it cannot leak into the rest of the app.
const SKEWT_CSS = `
.ssa-skewt .sktx-isobar { stroke: #dfe3e6; stroke-width: 0.75px; }
.ssa-skewt .sktx-isotherm { stroke: #ececec; stroke-width: 0.75px; }
.ssa-skewt .sktx-isotherm-zero { stroke: #bbb; stroke-width: 1.1px; }
.ssa-skewt .sktx-dryadiabat { fill: none; stroke: #f0c9a0; stroke-width: 0.6px; stroke-dasharray: 3 3; opacity: 0.65; }
.ssa-skewt .sktx-temp { fill: none; stroke: #e74c3c; stroke-width: 2.5px; }
.ssa-skewt .sktx-dwpt { fill: none; stroke: #2980b9; stroke-width: 2.5px; }
.ssa-skewt .sktx-parcel { fill: none; stroke: #27ae60; stroke-width: 1.8px; stroke-dasharray: 6 4; }
.ssa-skewt .sktx-dewline { fill: none; stroke: #111; stroke-width: 1.2px; }
.ssa-skewt .sktx-axis text { font-size: 11px; fill: #2c3e50; }
.ssa-skewt .sktx-axis path, .ssa-skewt .sktx-axis line { stroke: #95a5a6; }
.ssa-skewt .sktx-barb { stroke: #2c3e50; stroke-width: 1px; fill: #2c3e50; }
.ssa-skewt .sktx-label { font-size: 10px; fill: #7f8c8d; }
.ssa-skewt .sktx-cursorline { stroke: #7f8c8d; stroke-width: 1px; stroke-dasharray: 2 3; }
.ssa-skewt .sktx-marker-temp { fill: #e74c3c; }
.ssa-skewt .sktx-marker-dwpt { fill: #2980b9; }
.ssa-skewt .sktx-tip { font-size: 10px; fill: #2c3e50; }
.ssa-skewt .sktx-tip-box { fill: rgba(255,255,255,0.95); stroke: #ccc; }
`

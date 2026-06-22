// ForecastDeck.jsx
// ----------------------------------------------------------------------------
// Admin-only "Generate forecast" panel at the top of the Forecast tab. Builds the
// 4-slide racing-weather deck (General weather, Outlook, Details for today, Model
// comparison) as an EDITABLE .pptx via pptxgenjs. All winds at MAST HEIGHT (+MOS).
//
//  • Wind field @ 12:00 over a detailed LIGHT coastline (CARTO light tiles stitched
//    to a canvas + Beaufort-shaded field + arrows) — day mode.
//  • Outlook: per day, Morning/Midday/Afternoon = 10:00/12:00/15:00 local, each a
//    weighted TWD range + TWS range — ALL models for day 1&2, ARPEGE+ECMWF beyond.
//  • Model-comparison + a 4-day TWS/TWD plot: day-mode Plotly with a grey ±2σ band.
// ----------------------------------------------------------------------------
import React, { useMemo, useState } from 'react'
import { useScriptsOnce } from './useScriptOnce'
import { MODELS, interpolateSpeedAtHeight, hasValidSpeed } from './openMeteo'
import { matchVenue, specFor, mosSeries } from './mos'
import { BEAUFORT_BANDS, PALETTE_MAX_KT, fetchWindField, fetchIconRaceField } from './windField'

const PPTX_JS = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js'
const PLOTLY_JS = 'https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.24.1/plotly.min.js'
const KN = 0.539957
const OUTLOOK_MODELS = ['ARPEGE', 'ECMWF']
const OUTLOOK_DAYS = 4
const ALL_TODAY = ['ICONRACE', 'ICONRACE_1KM', 'AROME', 'ECMWF', 'ICON', 'ARPEGE', 'ITALIA', 'DMI']
const WEIGHTS = { ICONRACE: 1.0, ICONRACE_1KM: 1.0, AROME: 1.0, ECMWF: 0.8, ICON: 0.8, ARPEGE: 0.5, ITALIA: 0.7, DMI: 0.6 }
const RACE_HOURS = [10, 11, 12, 13, 14, 15, 16]
const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
const cardinal = (deg) => (deg == null || Number.isNaN(deg) ? '' : CARD[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16])

function circMean(degs) {
  if (!degs.length) return null
  let s = 0; let c = 0
  for (const d of degs) { const r = (d * Math.PI) / 180; s += Math.sin(r); c += Math.cos(r) }
  return (((Math.atan2(s, c) * 180) / Math.PI) % 360 + 360) % 360
}
function circStd(degs) {
  if (degs.length < 2) return 0
  let s = 0; let c = 0
  for (const d of degs) { const r = (d * Math.PI) / 180; s += Math.sin(r); c += Math.cos(r) }
  const R = Math.hypot(s, c) / degs.length
  return R <= 0 ? 180 : (Math.sqrt(-2 * Math.log(Math.min(1, R))) * 180) / Math.PI
}
function circRange(degs) {
  if (!degs.length) return null
  const m = circMean(degs); let lo = Infinity; let hi = -Infinity
  for (const d of degs) { const x = (((d - m + 540) % 360) - 180); if (x < lo) lo = x; if (x > hi) hi = x }
  return [Math.round(((m + lo) % 360 + 360) % 360), Math.round(((m + hi) % 360 + 360) % 360)]
}
function beaufort(kn) {
  const N = BEAUFORT_BANDS.length
  const x = Math.max(0, Math.min(0.999999, (kn || 0) / PALETTE_MAX_KT))
  const pos = x * (N - 1); const i = Math.floor(pos); const t = pos - i
  const a = BEAUFORT_BANDS[i].c; const b = BEAUFORT_BANDS[Math.min(N - 1, i + 1)].c
  const r = Math.round(a[0] + (b[0] - a[0]) * t); const g = Math.round(a[1] + (b[1] - a[1]) * t); const bl = Math.round(a[2] + (b[2] - a[2]) * t)
  return { hex: ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1).toUpperCase(), dark: (0.299 * r + 0.587 * g + 0.114 * bl) < 128 }
}
export function weightedBand(items) {
  const xs = items.filter((x) => x.v != null && Number.isFinite(x.v) && x.w > 0)
  if (!xs.length) return null
  const sw = xs.reduce((a, x) => a + x.w, 0)
  const mu = xs.reduce((a, x) => a + x.w * x.v, 0) / sw
  const wmax = Math.max(...xs.map((x) => x.w))
  const pulled = xs.map((x) => mu + (x.v - mu) * (x.w / wmax))
  return [Math.round(Math.min(mu, ...pulled)), Math.round(Math.max(mu, ...pulled))]
}

const heightsFromHourly = (h) => { const hs = []; for (const k of Object.keys(h || {})) { const m = k.match(/^wind_speed_(\d+)m$/); if (m) hs.push(+m[1]) } return hs.sort((a, b) => a - b) }
function mastKn(hourly, heights, mastH, i, mosArr) {
  if (mosArr && mosArr[i] != null) return mosArr[i]
  const kmh = interpolateSpeedAtHeight(hourly, heights, mastH, i)
  return kmh != null ? kmh * KN : null
}
const idxAt = (h, dateStr, hh) => (h.time || []).findIndex((t) => t.startsWith(`${dateStr}T${String(hh).padStart(2, '0')}:`))
async function fetchModelDays(modelKey, lat, lon, tz, days) {
  const m = MODELS[modelKey]; if (!m || !m.endpoint) throw new Error(`${modelKey} no endpoint`)
  const params = []; for (const h of (m.heights || [10])) params.push(`wind_speed_${h}m`, `wind_direction_${h}m`)
  let url = `${m.endpoint}?latitude=${lat}&longitude=${lon}&hourly=${params.join(',')}&wind_speed_unit=kmh&timezone=${encodeURIComponent(tz)}&forecast_days=${days}`
  if (m.modelParam) url += `&models=${m.modelParam}`
  const res = await fetch(url); if (!res.ok) throw new Error(`${modelKey} ${res.status}`); return res.json()
}

// ── today's detail rows (mast height + MOS) with a weighted TWS band ──────────
function buildDaily(short, mastH, bandModels) {
  const h = short.hourly; if (!h?.time) return []
  const heights = MODELS[short.key]?.heights || heightsFromHourly(h)
  const today = h.time[0]?.slice(0, 10); const rows = []
  for (let i = 0; i < h.time.length; i++) {
    const t = h.time[i]; if (t.slice(0, 10) !== today) break
    const hh = parseInt(t.slice(11, 13), 10); if (hh < 7 || hh > 19) continue
    const s = mastKn(h, heights, mastH, i, short.mos); if (s == null) continue
    const kn = Math.round(s)
    const d = h.wind_direction_10m?.[i] ?? h[`wind_direction_${heights[0]}m`]?.[i]
    const items = bandModels.map((bm) => { const j = bm.hourly.time.indexOf(t); return { v: j >= 0 ? mastKn(bm.hourly, bm.heights, mastH, j, bm.mos) : null, w: bm.weight } })
    items.push({ v: s, w: WEIGHTS[short.key] || 1 })
    const band = weightedBand(items) || [Math.max(0, kn - 2), kn + 2]
    rows.push({ time: `${String(hh).padStart(2, '0')}:00`, twd: cardinal(d), tws: `${kn}kn`, lo: band[0], hi: band[1] })
  }
  return rows
}

// ── outlook: TWD range + TWS range per bucket; all models day 1&2, globals beyond ─
function buildOutlook(dates, modelsFor, mastH) {
  return dates.map((d, di) => {
    const models = modelsFor(di)
    const bucket = (hh) => {
      const tws = []; const dirs = []
      for (const m of models) {
        const i = idxAt(m.hourly, d, hh); if (i < 0) continue
        const s = mastKn(m.hourly, m.heights, mastH, i, m.mos); if (s != null) tws.push({ v: s, w: m.weight })
        const dd = m.hourly.wind_direction_10m?.[i] ?? m.hourly[`wind_direction_${m.heights[0]}m`]?.[i]
        if (dd != null) dirs.push(dd)
      }
      const tb = weightedBand(tws); const db = circRange(dirs)
      if (!tb) return null
      return { twd: db, tws: tb, mid: (tb[0] + tb[1]) / 2 }
    }
    return { day: new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long' }), mor: bucket(10), mid: bucket(12), aft: bucket(15) }
  })
}

// ── day-mode wind field over a detailed light coastline (CARTO light tiles) ──
function loadImg(url) { return new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = rej; im.src = url }) }
async function windfieldCoast(field) {
  const box = field?.box; if (!box || typeof document === 'undefined' || !field.frames?.length) return null
  const W = Math.max(0.05, box.east - box.west)
  let z = Math.round(Math.log2((4 * 360) / W)); z = Math.max(8, Math.min(13, z))
  const n = 2 ** z
  const xT = (lon) => ((lon + 180) / 360) * n
  const yT = (lat) => { const s = Math.sin((lat * Math.PI) / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n }
  const xMin = Math.floor(xT(box.west)); const xMax = Math.floor(xT(box.east))
  const yMin = Math.floor(yT(box.north)); const yMax = Math.floor(yT(box.south))
  const cw = (xMax - xMin + 1) * 256; const ch = (yMax - yMin + 1) * 256
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch; const ctx = cv.getContext('2d')
  ctx.fillStyle = '#eef3f8'; ctx.fillRect(0, 0, cw, ch)
  const jobs = []
  for (let tx = xMin; tx <= xMax; tx++) for (let ty = yMin; ty <= yMax; ty++) {
    jobs.push(loadImg(`https://a.basemaps.cartocdn.com/light_all/${z}/${tx}/${ty}.png`).then((im) => ctx.drawImage(im, (tx - xMin) * 256, (ty - yMin) * 256)).catch(() => {}))
  }
  await Promise.all(jobs)
  let idx = (field.stamps || []).findIndex((s) => s && s.hh === 12); if (idx < 0) idx = Math.floor(field.frames.length / 2)
  const fr = field.frames[idx]; const { nx, ny, lo1, la1, dx, dy } = field.header
  if (!fr?.u) return { data: cv.toDataURL(), w: cw, h: ch }
  const px = (lon) => (xT(lon) - xMin) * 256; const py = (lat) => (yT(lat) - yMin) * 256
  const cwid = Math.abs(px(lo1 + dx) - px(lo1)); const chei = Math.abs(py(la1 - dy) - py(la1))
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const u = fr.u[j * nx + i] || 0; const v = fr.v[j * nx + i] || 0; const kn = Math.hypot(u, v) * 1.94384; const bf = beaufort(kn)
    const X = px(lo1 + i * dx); const Y = py(la1 - j * dy)
    ctx.globalAlpha = 0.5; ctx.fillStyle = `#${bf.hex}`; ctx.fillRect(X - cwid / 2, Y - chei / 2, cwid + 1, chei + 1); ctx.globalAlpha = 1
    const mag = Math.hypot(u, v) || 1; const len = Math.min(cwid, chei) * 0.42; const ddx = (u / mag) * len; const ddy = -(v / mag) * len
    ctx.strokeStyle = bf.dark ? '#fff' : '#1a2530'; ctx.lineWidth = 1.3
    ctx.beginPath(); ctx.moveTo(X - ddx, Y - ddy); ctx.lineTo(X + ddx, Y + ddy); ctx.stroke()
  }
  return { data: cv.toDataURL(), w: cw, h: ch }
}

// ── Plotly captures (day mode, ±2σ grey band) ───────────────────────────────
function bandStats(series, k = 2) {
  const n = series[0]?.length || 0; const mean = []; const lo = []; const hi = []
  for (let i = 0; i < n; i++) {
    const vs = series.map((s) => s[i]).filter((v) => v != null && Number.isFinite(v))
    if (vs.length < 2) { mean.push(vs[0] ?? null); lo.push(null); hi.push(null); continue }
    const m = vs.reduce((a, b) => a + b, 0) / vs.length
    const sd = Math.sqrt(vs.reduce((a, b) => a + (b - m) ** 2, 0) / vs.length)
    mean.push(m); lo.push(m - k * sd); hi.push(m + k * sd)
  }
  return { mean, lo, hi }
}
const bandTraces = (xs, b) => ([
  { x: xs, y: b.lo, type: 'scatter', mode: 'lines', line: { width: 0 }, showlegend: false, hoverinfo: 'skip', connectgaps: true },
  { x: xs, y: b.hi, type: 'scatter', mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(120,120,120,0.18)', name: '±2σ', hoverinfo: 'skip', connectgaps: true },
])
async function plotPNG(div, data, layout, w = 1000, h = 600) {
  const base = { paper_bgcolor: 'white', plot_bgcolor: 'white', font: { color: '#222', size: 13 }, margin: { t: 36, b: 50, l: 56, r: 20 } }
  await window.Plotly.newPlot(div, data, { ...base, ...layout }, { staticPlot: true })
  return window.Plotly.toImage(div, { format: 'png', width: w, height: h })
}
function offDiv() { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:-9999px;top:0;width:1000px;height:600px;background:#fff'; document.body.appendChild(d); return d }

// today's model-comparison: mast-height speed + direction, each with a ±2σ band
async function captureComparison(models, mastH) {
  if (!window.Plotly || !models.length) return [null, null]
  const div = offDiv(); const out = []
  const times = models[0].hourly.time
  const xs = times.map((t) => new Date(t))
  // speed
  const spdSeries = models.map((m) => times.map((t) => { const i = m.hourly.time.indexOf(t); return i >= 0 ? mastKn(m.hourly, m.heights, mastH, i, m.mos) : null }))
  const spdLines = models.map((m, k) => ({ x: xs, y: spdSeries[k], name: MODELS[m.key]?.label || m.key, type: 'scatter', mode: 'lines+markers', line: { color: MODELS[m.key]?.color, width: 2 }, marker: { size: 4, color: MODELS[m.key]?.color }, connectgaps: true }))
  try {
    out.push(await plotPNG(div, [...bandTraces(xs, bandStats(spdSeries)), ...spdLines],
      { title: { text: `Wind speed @ ${mastH} m`, font: { size: 15, color: '1F4E79' } }, legend: { orientation: 'h', y: -0.2 }, xaxis: { title: 'Time', gridcolor: '#e5e7eb' }, yaxis: { title: 'knots', rangemode: 'tozero', gridcolor: '#e5e7eb' } }))
  } catch { out.push(null) }
  // direction
  const dirSeries = models.map((m) => times.map((t) => { const i = m.hourly.time.indexOf(t); return i >= 0 ? (m.hourly.wind_direction_10m?.[i] ?? null) : null }))
  const dband = { mean: [], lo: [], hi: [] }
  for (let i = 0; i < times.length; i++) { const ds = dirSeries.map((s) => s[i]).filter((v) => v != null); if (ds.length < 2) { dband.mean.push(ds[0] ?? null); dband.lo.push(null); dband.hi.push(null); continue } const mu = circMean(ds); const sd = circStd(ds); dband.mean.push(mu); dband.lo.push(mu - 2 * sd); dband.hi.push(mu + 2 * sd) }
  const dirLines = models.map((m, k) => ({ x: xs, y: dirSeries[k], name: MODELS[m.key]?.label || m.key, type: 'scatter', mode: 'markers', marker: { size: 5, color: MODELS[m.key]?.color } }))
  try {
    out.push(await plotPNG(div, [...bandTraces(xs, dband), ...dirLines],
      { title: { text: 'Wind direction (TWD)', font: { size: 15, color: '1F4E79' } }, legend: { orientation: 'h', y: -0.2 }, xaxis: { title: 'Time', gridcolor: '#e5e7eb' }, yaxis: { title: '°', range: [0, 360], dtick: 45, gridcolor: '#e5e7eb' } }))
  } catch { out.push(null) }
  try { window.Plotly.purge(div) } catch { /* */ }
  div.remove(); return out
}

// 4-day TWS + TWD with ±2σ shading (ARPEGE + ECMWF), two stacked subplots
async function captureLongRange(globals, mastH) {
  if (!window.Plotly || globals.length < 1) return null
  const div = offDiv()
  const times = globals[0].hourly.time; const xs = times.map((t) => new Date(t))
  const spd = globals.map((m) => times.map((t) => { const i = m.hourly.time.indexOf(t); return i >= 0 ? mastKn(m.hourly, m.heights, mastH, i, null) : null }))
  const dir = globals.map((m) => times.map((t) => { const i = m.hourly.time.indexOf(t); return i >= 0 ? (m.hourly.wind_direction_10m?.[i] ?? null) : null }))
  const sb = bandStats(spd)
  const db = { mean: [], lo: [], hi: [] }
  for (let i = 0; i < times.length; i++) { const ds = dir.map((s) => s[i]).filter((v) => v != null); if (ds.length < 2) { db.mean.push(ds[0] ?? null); db.lo.push(null); db.hi.push(null); continue } const mu = circMean(ds); const sd = circStd(ds); db.mean.push(mu); db.lo.push(mu - 2 * sd); db.hi.push(mu + 2 * sd) }
  const data = [
    ...bandTraces(xs, sb).map((tr) => ({ ...tr, xaxis: 'x', yaxis: 'y' })),
    { x: xs, y: sb.mean, name: 'TWS mean', type: 'scatter', mode: 'lines', line: { color: '1F4E79', width: 2 }, xaxis: 'x', yaxis: 'y', connectgaps: true },
    ...bandTraces(xs, db).map((tr) => ({ ...tr, xaxis: 'x2', yaxis: 'y2', showlegend: false })),
    { x: xs, y: db.mean, name: 'TWD mean', type: 'scatter', mode: 'lines', line: { color: 'B85042', width: 2 }, xaxis: 'x2', yaxis: 'y2', connectgaps: true },
  ]
  const layout = {
    grid: { rows: 2, columns: 1, pattern: 'independent', roworder: 'top to bottom' },
    title: { text: '4-day outlook — TWS & TWD (±2σ)', font: { size: 15, color: '1F4E79' } },
    legend: { orientation: 'h', y: -0.12 }, margin: { t: 40, b: 40, l: 56, r: 20 },
    yaxis: { title: 'TWS (kn)', rangemode: 'tozero', gridcolor: '#e5e7eb' },
    yaxis2: { title: 'TWD (°)', range: [0, 360], dtick: 90, gridcolor: '#e5e7eb' },
    xaxis: { gridcolor: '#eef2f6' }, xaxis2: { gridcolor: '#eef2f6' },
  }
  let png = null
  try { png = await plotPNG(div, data, layout, 1400, 520) } catch { png = null }
  try { window.Plotly.purge(div) } catch { /* */ }
  div.remove(); return png
}

// ── deck builder ─────────────────────────────────────────────────────────────
const NAVY = '1F4E79'; const INK = '202020'; const GREY = '6B7280'; const HEADER = 'D6DCE5'; const LIGHTF = 'F2F4F7'; const FONT = 'Helvetica Neue'
function spdCell(text) {
  const nums = (text.match(/\d+/g) || []).map(Number)
  const tws = nums.filter((x) => x <= 60)            // ignore TWD degrees when colouring
  if (!tws.length) return { text, options: { color: INK, fontFace: FONT, fontSize: 12, valign: 'middle', align: 'left' } }
  const bf = beaufort(tws.reduce((a, b) => a + b, 0) / tws.length)
  return { text, options: { fill: { color: bf.hex }, color: bf.dark ? 'FFFFFF' : '0F1723', fontFace: FONT, fontSize: 12, valign: 'middle', align: 'left' } }
}
const txtCell = (text, o = {}) => ({ text, options: { color: INK, fontFace: FONT, fontSize: 12, valign: 'middle', align: 'left', ...o } })
const hdrCell = (text) => ({ text, options: { fill: { color: HEADER }, color: INK, bold: true, fontFace: FONT, fontSize: 12, valign: 'middle' } })
function addTitle(s, title, sub) { s.addText(title, { x: 0.5, y: 0.3, w: 12.3, h: 0.7, fontFace: FONT, fontSize: 34, bold: true, color: NAVY }); if (sub) s.addText(sub, { x: 0.52, y: 1.0, w: 12.3, h: 0.35, fontFace: FONT, fontSize: 12, color: GREY }) }
function ph(s, x, y, w, h, label) { s.addShape('roundRect', { x, y, w, h, fill: { color: LIGHTF }, line: { color: 'C2C9D4', width: 1 }, rectRadius: 0.1 }); s.addText(label, { x, y, w, h, align: 'center', valign: 'middle', fontFace: FONT, fontSize: 14, color: GREY }) }
const fit = (iw, ih, x, y, w, h) => { const r = Math.min(w / (iw || 1), h / (ih || 1)); const dw = (iw || 1) * r; const dh = (ih || 1) * r; return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh } }
const ocell = (b) => (b ? `${b.twd ? `${b.twd[0]}-${b.twd[1]}° ` : ''}${b.tws[0]}-${b.tws[1]}kn` : '—')

function buildDeck(P, d) {
  const pptx = new P(); pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 }); pptx.layout = 'WIDE'
  // 1) General weather + wind field @ 12:00 (coastline)
  let s = pptx.addSlide(); addTitle(s, 'General weather', d.subtitle)
  s.addText(d.generalBullets.map((t) => ({ text: t, options: { bullet: true, breakLine: true, paraSpaceAfter: 10 } })), { x: 0.5, y: 1.6, w: 5.2, h: 5.0, fontFace: FONT, fontSize: 17, color: INK })
  if (d.windfieldImg) { s.addImage({ data: d.windfieldImg.data, ...fit(d.windfieldImg.w, d.windfieldImg.h, 6.1, 1.6, 6.8, 4.7) }); s.addText('Wind field — 12:00 local', { x: 6.1, y: 6.4, w: 6.8, h: 0.3, align: 'center', fontFace: FONT, fontSize: 11, color: GREY }) } else ph(s, 6.1, 1.6, 6.8, 4.7, 'Wind field — 12:00 local\n(coastline capture unavailable)')
  // 2) Outlook table (top) + 4-day TWS/TWD plot (bottom)
  s = pptx.addSlide(); addTitle(s, `Outlook — ${d.outlookModelLabel}`)
  const oHead = [hdrCell('Time'), hdrCell('Morning (10:00)'), hdrCell('Midday (12:00)'), hdrCell('Afternoon (15:00)')]
  const oRows = d.outlookRows.map((r) => [txtCell(r.day, { bold: true, fill: { color: LIGHTF } }), spdCell(ocell(r.mor)), spdCell(ocell(r.mid)), spdCell(ocell(r.aft))])
  s.addTable([oHead, ...oRows], { x: 0.5, y: 1.4, w: 12.33, colW: [1.8, 3.51, 3.51, 3.51], rowH: 0.42, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, valign: 'middle' })
  if (d.longRange) s.addImage({ data: d.longRange, ...fit(1400, 520, 0.5, 3.5, 12.33, 3.3) })
  else ph(s, 0.5, 3.5, 12.33, 3.3, '4-day TWS & TWD (±2σ)')
  s.addText('AM/Mid/PM = 10:00/12:00/15:00 local · TWD & TWS ranges = weighted models (all day 1-2, ARPEGE+ECMWF beyond)', { x: 0.5, y: 7.04, w: 12.3, h: 0.32, fontFace: FONT, fontSize: 9.5, color: GREY })
  // 3) Details for today
  s = pptx.addSlide(); addTitle(s, 'Details for today')
  s.addText(d.dailyBullets.map((t) => ({ text: t, options: { bullet: true, breakLine: true, paraSpaceAfter: 10 } })), { x: 0.5, y: 1.6, w: 4.7, h: 5.2, fontFace: FONT, fontSize: 17, color: INK })
  const dHead = [hdrCell('Time'), hdrCell('TWD'), hdrCell(`TWS ${d.venue}`), hdrCell('TWS min&max')]
  const dRows = d.dailyRows.map((r) => [txtCell(r.time, { bold: true, fill: { color: LIGHTF } }), txtCell(r.twd), spdCell(r.tws), spdCell(`${r.lo}-${r.hi}kn`)])
  s.addTable([dHead, ...dRows], { x: 5.5, y: 1.5, w: 7.33, colW: [1.5, 1.9, 2.0, 1.93], rowH: 0.42, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, valign: 'middle' })
  s.addText(`TWS at mast height (${d.mastH} m), MOS where available · Model: ${d.shortModelLabel} · min&max = weighted blend`, { x: 0.5, y: 7.04, w: 12.3, h: 0.32, fontFace: FONT, fontSize: 9.5, color: GREY })
  // 4) Model comparison
  s = pptx.addSlide(); addTitle(s, 'Model comparison — wind speed & TWD (±2σ)')
  if (d.cmpSpeed) s.addImage({ data: d.cmpSpeed, ...fit(1000, 600, 0.4, 1.5, 6.3, 4.9) }); else ph(s, 0.4, 1.5, 6.3, 4.9, 'Wind-speed comparison')
  if (d.cmpDir) s.addImage({ data: d.cmpDir, ...fit(1000, 600, 6.9, 1.5, 6.0, 4.9) }); else ph(s, 6.9, 1.5, 6.0, 4.9, 'Wind-direction (TWD) comparison')
  return pptx
}

// ── component ───────────────────────────────────────────────────────────────
export default function ForecastDeck({ p1lat, p1lon, windData, mastHeight = 20, resolvedTz = 'UTC' }) {
  const pptxReady = useScriptsOnce([PPTX_JS]); useScriptsOnce([PLOTLY_JS])
  const point1 = windData?.['1']
  const haveP1 = p1lat != null && p1lon != null && !!point1
  const shortModels = useMemo(() => { const sb = point1?.surfaceByModel || {}; return Object.keys(MODELS).filter((k) => sb[k] && hasValidSpeed(sb[k].hourly)) }, [point1])
  const [outlookModel, setOutlookModel] = useState('ECMWF')
  const [shortModel, setShortModel] = useState('')
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  const shortSel = shortModel && shortModels.includes(shortModel) ? shortModel : (shortModels.find((k) => k.startsWith('ICONRACE')) || shortModels[0] || '')

  async function generate() {
    setErr(''); setBusy(true)
    try {
      const P = window.PptxGenJS; if (!P) throw new Error('engine loading — retry shortly')
      const venueName = (matchVenue(p1lat, p1lon) || 'venue').replace(/_/g, ' '); const tz = resolvedTz || 'UTC'
      const venueKey = matchVenue(p1lat, p1lon); const spec = venueKey ? specFor(venueKey) : null
      const mosFor = (key, hourly) => { const id = MODELS[key]?.mosModel; return spec && id ? mosSeries(hourly, MODELS[key]?.heights || [10], spec, id, tz) : null }
      const sb = point1.surfaceByModel
      const todayModels = ALL_TODAY.filter((k) => sb[k] && hasValidSpeed(sb[k].hourly))
        .map((k) => ({ key: k, hourly: sb[k].hourly, heights: MODELS[k]?.heights || [10], mos: mosFor(k, sb[k].hourly), weight: WEIGHTS[k] || 0.5 }))
      const short = { key: shortSel, hourly: sb[shortSel].hourly, heights: MODELS[shortSel]?.heights || [10], mos: mosFor(shortSel, sb[shortSel].hourly) }
      const dailyRows = buildDaily(short, mastHeight, todayModels.filter((m) => m.key !== shortSel))

      // outlook: globals fetched 4-day; days 1-2 use ALL models, beyond use globals
      const gJsons = await Promise.all(OUTLOOK_MODELS.map((k) => fetchModelDays(k, p1lat, p1lon, tz, OUTLOOK_DAYS).catch(() => null)))
      const globals = OUTLOOK_MODELS.map((k, i) => ({ k, json: gJsons[i] })).filter((x) => x.json?.hourly?.time)
        .map((x) => ({ key: x.k, hourly: x.json.hourly, heights: heightsFromHourly(x.json.hourly), mos: null, weight: WEIGHTS[x.k] || 0.7 }))
      const centralJson = gJsons[OUTLOOK_MODELS.indexOf(outlookModel)] || globals[0]?.json || gJsons.find(Boolean)
      const dates = centralJson?.hourly?.time ? [...new Set(centralJson.hourly.time.map((t) => t.slice(0, 10)))].slice(0, OUTLOOK_DAYS) : []
      const outlookRows = buildOutlook(dates, (di) => (di < 2 ? [...todayModels, ...globals] : globals), mastHeight)

      // images (best-effort)
      let cmp = [null, null]; let longRange = null; let windfieldImg = null
      try { cmp = await captureComparison(todayModels, mastHeight) } catch { /* */ }
      try { longRange = await captureLongRange(globals, mastHeight) } catch { /* */ }
      try {
        const field = shortSel.startsWith('ICONRACE')
          ? await fetchIconRaceField({ lat: p1lat, lon: p1lon, height: mastHeight, timezone: tz, modelKey: shortSel })
          : (MODELS[shortSel]?.endpoint ? await fetchWindField({ modelKey: shortSel, lat: p1lat, lon: p1lon, height: mastHeight, timezone: tz }) : null)
        if (field) windfieldImg = await windfieldCoast(field)
      } catch { /* */ }

      const peak = dailyRows.reduce((m, r) => (r.hi > (m?.hi ?? -1) ? r : m), null)
      const deck = buildDeck(P, {
        venue: venueName,
        subtitle: `${venueName} — issued ${new Date().toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz })}`,
        outlookModelLabel: MODELS[outlookModel]?.label || outlookModel, shortModelLabel: MODELS[shortSel]?.label || shortSel,
        mastH: mastHeight, outlookRows, dailyRows, cmpSpeed: cmp[0], cmpDir: cmp[1], longRange, windfieldImg,
        generalBullets: ['Synoptic setup — edit', 'Sea-breeze timing & strength — edit', 'Local effects / hazards — edit'],
        dailyBullets: [peak ? `Peak breeze ~${peak.hi}kn around ${peak.time}` : 'Breeze build through the day — edit', 'Morning: light/variable — edit', 'Local effects — edit'],
      })
      await deck.writeFile({ fileName: `forecast_${venueName.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pptx` })
    } catch (e) { setErr(e?.message || 'generation failed') } finally { setBusy(false) }
  }

  return (
    <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 12, marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0', alignSelf: 'center' }}>📊 Generate forecast deck</div>
        <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
          <span style={lbl}>Outlook model</span>
          <select value={outlookModel} onChange={(e) => setOutlookModel(e.target.value)} style={input} disabled={busy}>
            {OUTLOOK_MODELS.map((k) => <option key={k} value={k}>{MODELS[k]?.label || k}</option>)}
          </select>
        </label>
        <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
          <span style={lbl}>Short-term model (point 1)</span>
          <select value={shortSel} onChange={(e) => setShortModel(e.target.value)} style={input} disabled={busy || !shortModels.length}>
            {!shortModels.length && <option value="">— set point 1 —</option>}
            {shortModels.map((k) => <option key={k} value={k}>{MODELS[k]?.label || k}</option>)}
          </select>
        </label>
        <button onClick={generate} disabled={!haveP1 || busy || !shortSel || !pptxReady} style={{ ...btn, opacity: (!haveP1 || busy || !shortSel) ? 0.5 : 1 }}>
          {busy ? 'Generating…' : 'Generate forecast'}
        </button>
        <span style={{ fontSize: 11, color: err ? '#F87171' : '#64748B', alignSelf: 'center' }}>
          {err || (!haveP1 ? 'Set point 1 to enable' : 'Editable .pptx · mast-height · day-mode · Keynote-ready')}
        </span>
      </div>
    </div>
  )
}
const lbl = { fontSize: 10, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1 }
const input = { background: '#071624', border: '1px solid #1E3A5A', borderRadius: 6, color: '#E2E8F0', padding: '6px 9px', fontSize: 13 }
const btn = { background: '#06B6D4', border: 'none', borderRadius: 6, color: '#001018', fontWeight: 700, fontSize: 13, padding: '8px 16px', cursor: 'pointer' }

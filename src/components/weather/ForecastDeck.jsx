// ForecastDeck.jsx
// ----------------------------------------------------------------------------
// Admin-only "Generate forecast" panel at the top of the Forecast tab. Builds the
// 4-slide racing-weather deck as an EDITABLE .pptx via pptxgenjs. All winds at MAST
// HEIGHT (+MOS). Every model is aligned on a common LOCAL-time grid (SSA-Race is UTC,
// Open-Meteo is venue-local — without this the comparison only showed the SSA lines).
//
//  • Wind field @ 12:00 over a detailed LIGHT coastline (CARTO tiles), cropped to the
//    domain (data fills the frame), with a 5 nm racing-area circle on point 1.
//  • Outlook: Morning/Midday/Afternoon = 10:00/12:00/15:00 local, weighted CARDINAL TWD
//    range + TWS range (all models day 1-2, ARPEGE+ECMWF beyond).
//  • Details for today (08:00-18:00): TWD numeric range + weighted TWS min&max.
//  • Comparison + 4-day plots: day-mode Plotly, grey ±1σ band, racing-window (10-17) shading.
// ----------------------------------------------------------------------------
import React, { useMemo, useState } from 'react'
import { useScriptsOnce } from './useScriptOnce'
import { MODELS, interpolateSpeedAtHeight, hasValidSpeed, fetchIconRaceSounding, SSARACE_SOUNDING_LEVELS, ECMWF_SOUNDING_LEVELS } from './openMeteo'
import { matchVenue, specFor, mosSeries } from './mos'
import { BEAUFORT_BANDS, PALETTE_MAX_KT, fetchWindField, fetchIconRaceField } from './windField'
import { getWeatherSession } from './weatherSession'
import {
  mean as dMean, ensureHeights, stabilityFromSounding, stabilityGate,
  thermalBend, seaBreezeIndex, crossShoreComponent, quadrantModifier,
  seaBreezeScore, typeOfDay as dTypeOfDay, cloudTrend, confidence,
  modelSpread, funnelDiagnostics, funnelFlag, clamp01,
} from './forecastDiagnostics'
import { coastNormalForPoint } from './coastline'
import { MAPLIBRE_JS, MAPLIBRE_CSS, DECK_JS, captureField3DSeries } from './field3dUtils'

const PPTX_JS = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js'
const PLOTLY_JS = 'https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.24.1/plotly.min.js'
const KN = 0.539957
const OUTLOOK_MODELS = ['ARPEGE', 'ECMWF']; const OUTLOOK_DAYS = 4
const ALL_TODAY = ['ICONRACE', 'ICONRACE_1KM', 'AROME', 'ECMWF', 'ICON', 'ARPEGE', 'ITALIA', 'DMI']
const WEIGHTS = { ICONRACE: 1.0, ICONRACE_1KM: 1.0, AROME: 1.0, ECMWF: 0.8, ICON: 0.8, ARPEGE: 0.5, ITALIA: 0.7, DMI: 0.6 }
const RACE_HOURS = [10, 11, 12, 13, 14, 15, 16, 17]; const RACE0 = 10; const RACE1 = 17
const RACE_FILL = 'rgba(56,189,248,0.13)'
const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
const cardinal = (deg) => (deg == null || Number.isNaN(deg) ? '' : CARD[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16])
const pad2 = (n) => String(n).padStart(2, '0')
const round5 = (x) => (x == null ? null : Math.round(x / 5) * 5)
// 8-way SOLID BLACK arrow pointing the way the wind BLOWS (toward = TWD+180).
// Heavy/filled glyphs (U+2B06 family + U+27A1); U+FE0E forces the monochrome
// black text form rather than a coloured emoji. Fixed size for every direction.
const ARROWS = ['⬆', '⬈', '➡', '⬊', '⬇', '⬋', '⬅', '⬉']
const ARROW_SIZE = 15
const arrowGlyph = (twd) => (twd == null ? '' : ARROWS[Math.round((((twd + 180) % 360) + 360) % 360 / 45) % 8] + '\uFE0E')

function circMean(d) { if (!d.length) return null; let s = 0; let c = 0; for (const x of d) { const r = (x * Math.PI) / 180; s += Math.sin(r); c += Math.cos(r) } return (((Math.atan2(s, c) * 180) / Math.PI) % 360 + 360) % 360 }
function circStd(d) { if (d.length < 2) return 0; let s = 0; let c = 0; for (const x of d) { const r = (x * Math.PI) / 180; s += Math.sin(r); c += Math.cos(r) } const R = Math.hypot(s, c) / d.length; return R <= 0 ? 180 : (Math.sqrt(-2 * Math.log(Math.min(1, R))) * 180) / Math.PI }
function circRange(d) { if (!d.length) return null; const m = circMean(d); let lo = Infinity; let hi = -Infinity; for (const x of d) { const y = (((x - m + 540) % 360) - 180); if (y < lo) lo = y; if (y > hi) hi = y } return [Math.round(((m + lo) % 360 + 360) % 360), Math.round(((m + hi) % 360 + 360) % 360)] }
function beaufort(kn) { const N = BEAUFORT_BANDS.length; const x = Math.max(0, Math.min(0.999999, (kn || 0) / PALETTE_MAX_KT)); const pos = x * (N - 1); const i = Math.floor(pos); const t = pos - i; const a = BEAUFORT_BANDS[i].c; const b = BEAUFORT_BANDS[Math.min(N - 1, i + 1)].c; const r = Math.round(a[0] + (b[0] - a[0]) * t); const g = Math.round(a[1] + (b[1] - a[1]) * t); const bl = Math.round(a[2] + (b[2] - a[2]) * t); return { hex: ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1).toUpperCase(), dark: (0.299 * r + 0.587 * g + 0.114 * bl) < 128 } }
export function weightedBand(items) { const xs = items.filter((x) => x.v != null && Number.isFinite(x.v) && x.w > 0); if (!xs.length) return null; const sw = xs.reduce((a, x) => a + x.w, 0); const mu = xs.reduce((a, x) => a + x.w * x.v, 0) / sw; const wmax = Math.max(...xs.map((x) => x.w)); const pulled = xs.map((x) => mu + (x.v - mu) * (x.w / wmax)); return [Math.round(Math.min(mu, ...pulled)), Math.round(Math.max(mu, ...pulled))] }

// UTC 'Z' time -> 'YYYY-MM-DDTHH:MM' venue-local; Open-Meteo strings are already local.
function toLocal(t, tz) { const d = new Date(t.endsWith('Z') ? t : `${t}Z`); const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d); const g = (ty) => p.find((x) => x.type === ty).value; return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}` }
const localTimes = (h, tz) => { const u = (h.time?.[0] || '').endsWith('Z'); return (h.time || []).map((t) => (u ? toLocal(t, tz) : t.slice(0, 16))) }
const heightsFromHourly = (h) => { const hs = []; for (const k of Object.keys(h || {})) { const m = k.match(/^wind_speed_(\d+)m$/); if (m) hs.push(+m[1]) } return hs.sort((a, b) => a - b) }
function mastKn(hourly, heights, mastH, i, mosArr) { if (mosArr && mosArr[i] != null) return mosArr[i]; const kmh = interpolateSpeedAtHeight(hourly, heights, mastH, i); return kmh != null ? kmh * KN : null }
const dirAt = (m, i) => m.hourly.wind_direction_10m?.[i] ?? m.hourly[`wind_direction_${m.heights[0]}m`]?.[i]
const idxAtL = (m, dateStr, hh) => m.lt.findIndex((t) => t.startsWith(`${dateStr}T${pad2(hh)}:`))
const idxByKey = (m, key) => m.lt.findIndex((t) => t.slice(0, 13) === key)

// Ask the server-side Claude proxy for the executive brief. Returns null on any
// failure (no key, network, parse) so the deck still builds with editable blanks.
async function aiSummary(payload) {
  try {
    const res = await fetch('/api/ai/forecast-summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: payload }) })
    if (!res.ok) return null
    const j = await res.json()
    return j && !j.error ? j : null
  } catch { return null }
}

async function fetchModelDays(modelKey, lat, lon, tz, days) { const m = MODELS[modelKey]; if (!m || !m.endpoint) throw new Error(`${modelKey} no endpoint`); const params = []; for (const h of (m.heights || [10])) params.push(`wind_speed_${h}m`, `wind_direction_${h}m`); let url = `${m.endpoint}?latitude=${lat}&longitude=${lon}&hourly=${params.join(',')}&wind_speed_unit=kmh&timezone=${encodeURIComponent(tz)}&forecast_days=${days}`; if (m.modelParam) url += `&models=${m.modelParam}`; const res = await fetch(url); if (!res.ok) throw new Error(`${modelKey} ${res.status}`); return res.json() }

// ── today's detail rows (mast +MOS): numeric TWD range + weighted TWS band ───
function buildDaily(short, mastH, bandModels) {
  const lt = short.lt; if (!lt.length) return []
  const today = lt[0].slice(0, 10); const rows = []
  for (let i = 0; i < lt.length; i++) {
    if (lt[i].slice(0, 10) !== today) break
    const hh = parseInt(lt[i].slice(11, 13), 10); if (hh < 8 || hh > 18) continue
    const s = mastKn(short.hourly, short.heights, mastH, i, short.mos); if (s == null) continue
    const kn = Math.round(s)
    const tws = [{ v: s, w: WEIGHTS[short.key] || 1 }]; const dirs = []
    const d0 = dirAt(short, i); if (d0 != null) dirs.push(d0)
    for (const bm of bandModels) { const j = idxByKey(bm, lt[i].slice(0, 13)); if (j < 0) continue; const v = mastKn(bm.hourly, bm.heights, mastH, j, bm.mos); if (v != null) tws.push({ v, w: bm.weight }); const dd = dirAt(bm, j); if (dd != null) dirs.push(dd) }
    const band = weightedBand(tws) || [Math.max(0, kn - 2), kn + 2]
    const dr = circRange(dirs); const twdMean = circMean(dirs)
    const twd = dr ? `${round5(dr[0])}-${round5(dr[1])}` : (twdMean != null ? `${round5(twdMean)}` : '')
    rows.push({ time: `${pad2(hh)}:00`, twdMean, twd, tws: `${kn}kn`, kn, lo: band[0], hi: band[1] })
  }
  // hour-over-hour trend: TWD shift (right=veer / left=back) + TWS (increasing/dropping)
  for (let r = 1; r < rows.length; r++) {
    const a = rows[r - 1]; const b = rows[r]; let dt = ''; let st = ''
    if (a.twdMean != null && b.twdMean != null) { const dd = (((b.twdMean - a.twdMean + 540) % 360) - 180); if (dd > 6) dt = 'Right'; else if (dd < -6) dt = 'Left' }
    const dk = b.kn - a.kn; if (dk >= 1) st = 'increasing'; else if (dk <= -1) st = 'dropping'
    b.trend = [dt, st].filter(Boolean).join(' · ') || 'steady'
  }
  if (rows[0]) rows[0].trend = ''
  return rows
}

// ── outlook: cardinal TWD range + TWS range; all models day 1-2, globals beyond ─
function buildOutlook(dates, modelsFor, mastH) {
  return dates.map((d, di) => {
    const models = modelsFor(di)
    const bucket = (hh) => {
      const tws = []; const dirs = []
      for (const m of models) { const i = idxAtL(m, d, hh); if (i < 0) continue; const s = mastKn(m.hourly, m.heights, mastH, i, m.mos); if (s != null) tws.push({ v: s, w: m.weight }); const dd = dirAt(m, i); if (dd != null) dirs.push(dd) }
      const tb = weightedBand(tws); if (!tb) return null
      return { twd: circRange(dirs), twdMean: circMean(dirs), tws: tb, twsMid: (tb[0] + tb[1]) / 2 }
    }
    return { day: new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long' }), mor: bucket(10), mid: bucket(12), aft: bucket(15) }
  })
}

// ── day-mode wind field over a detailed light coastline, cropped to the domain ─
function loadImg(url) { return new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = rej; im.src = url }) }
async function windfieldCoast(field, p1lat, p1lon) {
  const box = field?.box; if (!box || typeof document === 'undefined' || !field.frames?.length) return null
  const W = Math.max(0.05, box.east - box.west); let z = Math.round(Math.log2((4 * 360) / W)); z = Math.max(8, Math.min(13, z)); const n = 2 ** z
  const xT = (lon) => ((lon + 180) / 360) * n
  const yT = (lat) => { const s = Math.sin((lat * Math.PI) / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n }
  const xMin = Math.floor(xT(box.west)); const xMax = Math.floor(xT(box.east)); const yMin = Math.floor(yT(box.north)); const yMax = Math.floor(yT(box.south))
  const cw = (xMax - xMin + 1) * 256; const ch = (yMax - yMin + 1) * 256
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch; const ctx = cv.getContext('2d')
  ctx.fillStyle = '#eef3f8'; ctx.fillRect(0, 0, cw, ch)
  const jobs = []
  for (let tx = xMin; tx <= xMax; tx++) for (let ty = yMin; ty <= yMax; ty++) jobs.push(loadImg(`https://a.basemaps.cartocdn.com/light_all/${z}/${tx}/${ty}.png`).then((im) => ctx.drawImage(im, (tx - xMin) * 256, (ty - yMin) * 256)).catch(() => {}))
  await Promise.all(jobs)
  const px = (lon) => (xT(lon) - xMin) * 256; const py = (lat) => (yT(lat) - yMin) * 256
  let idx = (field.stamps || []).findIndex((s) => s && s.hh === 12); if (idx < 0) idx = Math.floor(field.frames.length / 2)
  const fr = field.frames[idx]; const { nx, ny, lo1, la1, dx, dy } = field.header
  if (fr?.u) {
    const cwid = Math.abs(px(lo1 + dx) - px(lo1)); const chei = Math.abs(py(la1 - dy) - py(la1))
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const u = fr.u[j * nx + i] || 0; const v = fr.v[j * nx + i] || 0; const kn = Math.hypot(u, v) * 1.94384; const bf = beaufort(kn)
      const X = px(lo1 + i * dx); const Y = py(la1 - j * dy)
      ctx.globalAlpha = 0.5; ctx.fillStyle = `#${bf.hex}`; ctx.fillRect(X - cwid / 2, Y - chei / 2, cwid + 1, chei + 1); ctx.globalAlpha = 1
      const mag = Math.hypot(u, v) || 1; const len = Math.min(cwid, chei) * 0.42; const ddx = (u / mag) * len; const ddy = -(v / mag) * len
      ctx.strokeStyle = bf.dark ? '#fff' : '#1a2530'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(X - ddx, Y - ddy); ctx.lineTo(X + ddx, Y + ddy); ctx.stroke()
    }
  }
  // 5 nm racing-area circle on point 1
  if (p1lat != null && p1lon != null) {
    const cx = px(p1lon); const cy = py(p1lat); const rpx = Math.abs(py(p1lat + 5 / 60) - py(p1lat))
    ctx.strokeStyle = '#D40000'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(cx, cy, rpx, 0, 2 * Math.PI); ctx.stroke()
    ctx.fillStyle = '#D40000'; ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, 2 * Math.PI); ctx.fill()
  }
  // crop to the data box so the wind field fills the frame
  const cx0 = Math.max(0, Math.round(px(box.west))); const cy0 = Math.max(0, Math.round(py(box.north)))
  const cx1 = Math.min(cw, Math.round(px(box.east))); const cy1 = Math.min(ch, Math.round(py(box.south)))
  const w2 = Math.max(8, cx1 - cx0); const h2 = Math.max(8, cy1 - cy0)
  const cc = document.createElement('canvas'); cc.width = w2; cc.height = h2
  cc.getContext('2d').drawImage(cv, cx0, cy0, w2, h2, 0, 0, w2, h2)
  return { data: cc.toDataURL(), w: w2, h: h2 }
}

// ── Plotly captures (day mode, ±1σ band, racing-window shading) ──────────────
function bandStats(series, k = 1) { const n = series[0]?.length || 0; const mean = []; const lo = []; const hi = []; for (let i = 0; i < n; i++) { const vs = series.map((s) => s[i]).filter((v) => v != null && Number.isFinite(v)); if (vs.length < 2) { mean.push(vs[0] ?? null); lo.push(null); hi.push(null); continue } const m = vs.reduce((a, b) => a + b, 0) / vs.length; const sd = Math.sqrt(vs.reduce((a, b) => a + (b - m) ** 2, 0) / vs.length); mean.push(m); lo.push(m - k * sd); hi.push(m + k * sd) } return { mean, lo, hi } }
function dirBand(series) { const n = series[0]?.length || 0; const mean = []; const lo = []; const hi = []; for (let i = 0; i < n; i++) { const ds = series.map((s) => s[i]).filter((v) => v != null); if (ds.length < 2) { mean.push(ds[0] ?? null); lo.push(null); hi.push(null); continue } const mu = circMean(ds); const sd = circStd(ds); mean.push(mu); lo.push(mu - sd); hi.push(mu + sd) } return { mean, lo, hi } }
const bandTraces = (xs, b, ax = 'x', ay = 'y') => ([
  { x: xs, y: b.lo, type: 'scatter', mode: 'lines', line: { width: 0 }, showlegend: false, hoverinfo: 'skip', connectgaps: true, xaxis: ax, yaxis: ay },
  { x: xs, y: b.hi, type: 'scatter', mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(120,120,120,0.18)', name: '±1σ', hoverinfo: 'skip', connectgaps: true, xaxis: ax, yaxis: ay },
])
function raceShapes(keys, pairs) {            // pairs: [[xref, yref]...]
  const dates = [...new Set(keys.map((k) => k.slice(0, 10)))]
  const out = []
  for (const d of dates) for (const [xr, yr] of pairs) out.push({ type: 'rect', xref: xr, yref: yr, x0: new Date(`${d}T${pad2(RACE0)}:00`), x1: new Date(`${d}T${pad2(RACE1)}:00`), y0: 0, y1: 1, fillcolor: RACE_FILL, line: { width: 0 }, layer: 'below' })
  return out
}
async function plotPNG(div, data, layout, w = 1000, h = 600) { const base = { paper_bgcolor: 'white', plot_bgcolor: 'white', font: { color: '#222', size: 13 }, margin: { t: 36, b: 50, l: 56, r: 20 } }; await window.Plotly.newPlot(div, data, { ...base, ...layout }, { staticPlot: true }); return window.Plotly.toImage(div, { format: 'png', width: w, height: h }) }
function offDiv() { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:-9999px;top:0;width:1000px;height:600px;background:#fff'; document.body.appendChild(d); return d }

// common local-hour key grid across models, so EVERY model aligns (SSA UTC vs OM local)
function keyGrid(models) { const ks = new Set(); models.forEach((m) => m.lt.forEach((t) => ks.add(t.slice(0, 13)))); return [...ks].sort() }

async function captureComparison(models, mastH) {
  if (!window.Plotly || !models.length) return [null, null]
  const div = offDiv(); const keys = keyGrid(models); const xs = keys.map((k) => new Date(`${k}:00`)); const out = []
  const today = keys[0]?.slice(0, 10)
  const xax = { title: 'Time', gridcolor: '#e5e7eb', ...(today ? { range: [new Date(`${today}T08:00`), new Date(`${today}T20:00`)], autorange: false } : {}) }
  const ser = (m, kind) => keys.map((key) => { const i = idxByKey(m, key); if (i < 0) return null; return kind === 'spd' ? mastKn(m.hourly, m.heights, mastH, i, m.mos) : (dirAt(m, i) ?? null) })
  const spd = models.map((m) => ser(m, 'spd')); const dir = models.map((m) => ser(m, 'dir'))
  const lines = (series, mode) => models.map((m, k) => ({ x: xs, y: series[k], name: MODELS[m.key]?.label || m.key, type: 'scatter', mode, line: { color: MODELS[m.key]?.color, width: 2 }, marker: { size: 4, color: MODELS[m.key]?.color }, connectgaps: true }))
  try { out.push(await plotPNG(div, [...bandTraces(xs, bandStats(spd)), ...lines(spd, 'lines+markers')], { title: { text: `Wind speed @ ${mastH} m`, font: { size: 15, color: '1F4E79' } }, legend: { orientation: 'h', y: -0.2 }, xaxis: xax, yaxis: { title: 'knots', rangemode: 'tozero', gridcolor: '#e5e7eb' }, shapes: raceShapes(keys, [['x', 'y domain']]) })) } catch { out.push(null) }
  try { out.push(await plotPNG(div, [...bandTraces(xs, dirBand(dir)), ...lines(dir, 'markers')], { title: { text: 'Wind direction (TWD)', font: { size: 15, color: '1F4E79' } }, legend: { orientation: 'h', y: -0.2 }, xaxis: xax, yaxis: { title: '°', range: [0, 360], dtick: 45, gridcolor: '#e5e7eb' }, shapes: raceShapes(keys, [['x', 'y domain']]) })) } catch { out.push(null) }
  try { window.Plotly.purge(div) } catch { /* */ } div.remove(); return out
}

async function captureLongRange(globals, mastH) {
  if (!window.Plotly || globals.length < 1) return null
  const div = offDiv(); const keys = keyGrid(globals); const xs = keys.map((k) => new Date(`${k}:00`))
  const spd = globals.map((m) => keys.map((key) => { const i = idxByKey(m, key); return i >= 0 ? mastKn(m.hourly, m.heights, mastH, i, null) : null }))
  const dir = globals.map((m) => keys.map((key) => { const i = idxByKey(m, key); return i >= 0 ? (dirAt(m, i) ?? null) : null }))
  const sb = bandStats(spd); const db = dirBand(dir)
  const data = [
    ...bandTraces(xs, sb, 'x', 'y'),
    { x: xs, y: sb.mean, name: 'TWS mean', type: 'scatter', mode: 'lines', line: { color: '1F4E79', width: 2 }, xaxis: 'x', yaxis: 'y', connectgaps: true },
    ...bandTraces(xs, db, 'x2', 'y2').map((tr) => ({ ...tr, showlegend: false })),
    { x: xs, y: db.mean, name: 'TWD mean', type: 'scatter', mode: 'lines', line: { color: 'B85042', width: 2 }, xaxis: 'x2', yaxis: 'y2', connectgaps: true },
  ]
  const layout = { grid: { rows: 2, columns: 1, pattern: 'independent', roworder: 'top to bottom' }, title: { text: '4-day outlook — TWS & TWD (±1σ, racing window shaded)', font: { size: 15, color: '1F4E79' } }, legend: { orientation: 'h', y: -0.12 }, margin: { t: 40, b: 40, l: 56, r: 20 }, yaxis: { title: 'TWS (kn)', rangemode: 'tozero', gridcolor: '#e5e7eb' }, yaxis2: { title: 'TWD (°)', range: [0, 360], dtick: 90, gridcolor: '#e5e7eb' }, xaxis: { gridcolor: '#eef2f6' }, xaxis2: { gridcolor: '#eef2f6' }, shapes: raceShapes(keys, [['x', 'y domain'], ['x2', 'y2 domain']]) }
  let png = null; try { png = await plotPNG(div, data, layout, 1400, 520) } catch { png = null }
  try { window.Plotly.purge(div) } catch { /* */ } div.remove(); return png
}

// boundary-layer-height development (point 1): SSA hpbl if present, else GFS; today 08-20
async function captureHpbl(point1, tz) {
  if (!window.Plotly || !point1) return null
  let h = null; let label = ''
  for (const k of ['ICONRACE', 'ICONRACE_1KM']) { const hh = point1.surfaceByModel?.[k]?.hourly; if (hh?.boundary_layer_height?.some((v) => v != null)) { h = hh; label = MODELS[k]?.label || k; break } }
  if (!h) { const hh = point1.gfs?.hourly; if (hh?.boundary_layer_height?.some((v) => v != null)) { h = hh; label = 'GFS' } }
  if (!h) return null
  const lt = localTimes(h, tz); const today = lt[0]?.slice(0, 10)
  const xs = lt.map((t) => new Date(`${t.slice(0, 16)}`)); const ys = h.boundary_layer_height
  const div = offDiv()
  const xr = today ? [new Date(`${today}T08:00`), new Date(`${today}T20:00`)] : undefined
  const shapes = today ? [{ type: 'rect', xref: 'x', yref: 'y domain', x0: new Date(`${today}T${pad2(RACE0)}:00`), x1: new Date(`${today}T${pad2(RACE1)}:00`), y0: 0, y1: 1, fillcolor: RACE_FILL, line: { width: 0 }, layer: 'below' }] : []
  const data = [{ x: xs, y: ys, type: 'scatter', mode: 'lines+markers', name: `hpbl (${label})`, line: { color: '1F4E79', width: 2.5 }, marker: { size: 4 }, connectgaps: true }]
  const layout = { title: { text: `Boundary-layer height — ${label}`, font: { size: 15, color: '1F4E79' } }, legend: { orientation: 'h', y: -0.18 }, xaxis: { title: 'Time', gridcolor: '#e5e7eb', ...(xr ? { range: xr, autorange: false } : {}) }, yaxis: { title: 'height (m)', rangemode: 'tozero', gridcolor: '#e5e7eb' }, shapes }
  let png = null; try { png = await plotPNG(div, data, layout, 1000, 560) } catch { png = null }
  try { window.Plotly.purge(div) } catch { /* */ } div.remove(); return png
}

// low-level vertical sounding @ 13:00 local (T/Td vs pressure + wind), zoomed like the SSA sounding
function dewpoint(tc, rh) { const a = 17.625; const b = 243.04; const r = Math.max(1, Math.min(100, rh)); const al = Math.log(r / 100) + (a * tc) / (b + tc); return (b * al) / (a - al) }
function soundingArr(h, levels, idx) {
  const arr = []
  for (const p of levels) { const t = h[`temperature_${p}hPa`]?.[idx]; if (t == null) continue; const rh = h[`relative_humidity_${p}hPa`]?.[idx]; const ws = h[`wind_speed_${p}hPa`]?.[idx]; const wd = h[`wind_direction_${p}hPa`]?.[idx]; arr.push({ press: p, temp: t, dwpt: rh != null ? Math.min(dewpoint(t, rh), t) : t, wspd: ws != null ? ws * 0.539957 : null, wdir: wd }) }
  return arr
}
// Standard meteorological wind barb as Plotly paper-space shapes — ported from
// SoundingView.drawBarb so the deck matches the SSA Skew-T. Staff points toward
// the wind SOURCE; 50 kt = filled flag, 10 kt = full barb, 5 kt = half barb.
// Local geometry is in px (SVG y-down), rotated by `dir`, mapped to paper coords
// (y-up) using the plot-area pixel size.
function barbShapes(kt, dir, yfrac, plotW, plotH, x0frac) {
  const shapes = []; const col = '#2c3e50'
  if (kt == null || dir == null || !Number.isFinite(yfrac)) return shapes
  const th = (dir * Math.PI) / 180; const cos = Math.cos(th); const sin = Math.sin(th)
  const toP = (lx, ly) => { const rx = lx * cos - ly * sin; const ry = lx * sin + ly * cos; return [x0frac + rx / plotW, yfrac - ry / plotH] }
  const line = (a, b) => { const [x0, y0] = toP(a[0], a[1]); const [x1, y1] = toP(b[0], b[1]); shapes.push({ type: 'line', xref: 'paper', yref: 'paper', x0, y0, x1, y1, line: { color: col, width: 1.2 } }) }
  const poly = (pts) => { const p = pts.map((q) => toP(q[0], q[1])); shapes.push({ type: 'path', xref: 'paper', yref: 'paper', path: `M ${p[0][0]},${p[0][1]} L ${p[1][0]},${p[1][1]} L ${p[2][0]},${p[2][1]} Z`, fillcolor: col, line: { color: col, width: 0.5 } }) }
  if (kt < 2.5) { const c = toP(0, 0); const r = 3; shapes.push({ type: 'circle', xref: 'paper', yref: 'paper', x0: c[0] - r / plotW, y0: c[1] - r / plotH, x1: c[0] + r / plotW, y1: c[1] + r / plotH, line: { color: col, width: 1 } }); return shapes }
  const L = 24; const step = 4
  line([0, 0], [0, -L])
  let spd = Math.round(kt / 5) * 5; let pos = -L
  const f50 = Math.floor(spd / 50); spd -= f50 * 50
  const f10 = Math.floor(spd / 10); spd -= f10 * 10
  const f5 = Math.floor(spd / 5)
  for (let i = 0; i < f50; i++) { poly([[0, pos], [10, pos + 2], [0, pos + 5]]); pos += 6 }
  for (let i = 0; i < f10; i++) { line([0, pos], [10, pos - 3]); pos += step }
  for (let i = 0; i < f5; i++) { line([0, pos], [5, pos - 2]); pos += step }
  return shapes
}
async function captureSounding(p1lat, p1lon, windData1, tz) {
  if (!window.Plotly) return null
  const sp = getWeatherSession()?.soundingPoint; const isP1 = !sp
  const lat = sp?.lat ?? p1lat; const lon = sp?.lon ?? p1lon
  let h = null; let levels = null; let label = null; let ptop = 650
  try { const ss = await fetchIconRaceSounding({ latitude: lat, longitude: lon }); if (ss?.time) { h = ss; levels = SSARACE_SOUNDING_LEVELS; label = 'SSA-Race 2 km'; ptop = 650 } } catch { /* */ }
  if (!h && isP1) { const e = windData1?.surfaceByModel?.ECMWF?.hourly; if (e && (e.temperature_1000hPa || e.temperature_850hPa)) { h = e; levels = ECMWF_SOUNDING_LEVELS; label = 'ECMWF'; ptop = 500 } }
  if (!h) return null
  const lt = localTimes(h, tz); const day0 = lt[0]?.slice(0, 10)
  let idx = lt.findIndex((t) => t.slice(0, 10) === day0 && t.slice(11, 13) === '13')
  if (idx < 0) idx = lt.findIndex((t) => t.slice(11, 13) === '13'); if (idx < 0) idx = Math.floor(lt.length / 2)
  const arr = soundingArr(h, levels, idx).filter((o) => o.press >= ptop).sort((a, b) => b.press - a.press)
  if (arr.length < 3) return null
  const div = offDiv()
  const ticks = [1000, 950, 900, 850, 800, 750, 700, 650, 600, 550, 500].filter((p) => p >= ptop && p <= 1050)
  // wind barbs down the right margin (matches the SSA Skew-T). Paper-space, so we
  // compute the plot-area pixel size from the image dims + margins below.
  const IMG_W = 820; const IMG_H = 900; const MARG = { t: 40, b: 44, l: 54, r: 128 }
  const plotW = IMG_W - MARG.l - MARG.r; const plotH = IMG_H - MARG.t - MARG.b
  const x0frac = 1.0 + 48 / plotW
  const lo10 = Math.log10(1050); const hi10 = Math.log10(ptop)
  const yFrac = (p) => (Math.log10(p) - lo10) / (hi10 - lo10)
  const barbAll = []
  for (const o of arr) { if (o.wspd == null && o.wdir == null) continue; barbAll.push(...barbShapes(o.wspd, o.wdir, yFrac(o.press), plotW, plotH, x0frac)) }
  const whead = { xref: 'paper', x: x0frac, yref: 'paper', y: 1.03, text: 'Wind (kn)', showarrow: false, font: { size: 11, color: '6B7280' }, xanchor: 'center' }
  const data = [
    { x: arr.map((o) => o.temp), y: arr.map((o) => o.press), type: 'scatter', mode: 'lines+markers', name: 'Temp', line: { color: '#d62728', width: 2.5 }, marker: { size: 5 } },
    { x: arr.map((o) => o.dwpt), y: arr.map((o) => o.press), type: 'scatter', mode: 'lines+markers', name: 'Dewpt', line: { color: '#2ca02c', width: 2.5 }, marker: { size: 5 } },
  ]
  const layout = { title: { text: `Sounding 13:00 — ${label} (${isP1 ? 'point 1' : 'sounding pt'})`, font: { size: 15, color: '1F4E79' } }, legend: { orientation: 'h', y: -0.1 }, margin: MARG, xaxis: { title: '°C', gridcolor: '#e5e7eb', zeroline: true, zerolinecolor: '#cbd5e1' }, yaxis: { title: 'hPa', type: 'log', range: [Math.log10(1050), Math.log10(ptop)], gridcolor: '#e5e7eb', tickvals: ticks, ticktext: ticks.map(String) }, annotations: [whead], shapes: barbAll }
  let png = null; try { png = await plotPNG(div, data, layout, 820, 900) } catch { png = null }
  try { window.Plotly.purge(div) } catch { /* */ } div.remove()
  return { png, h, levels, idx, lat, lon, label }
}

// Build a {press,tempC,z,rh,wspdKt,wdir} profile (surface→up) from a sounding
// hourly for the diagnostics. Uses geopotential height when present; else heights
// are filled hypsometrically downstream (ensureHeights).
function buildSoundingProfile(h, levels, idx) {
  const out = []
  for (const p of levels) {
    const t = h[`temperature_${p}hPa`]?.[idx]; if (t == null) continue
    const z = h[`geopotential_height_${p}hPa`]?.[idx]
    const rh = h[`relative_humidity_${p}hPa`]?.[idx]
    const ws = h[`wind_speed_${p}hPa`]?.[idx]
    const wd = h[`wind_direction_${p}hPa`]?.[idx]
    out.push({ press: p, tempC: t, z: z != null ? z : undefined, rh, wspdKt: ws != null ? ws * KN : null, wdir: wd })
  }
  return out
}
const nearestByZ = (prof, targetZ) => prof.reduce((best, o) => (o.z != null && (best == null || Math.abs(o.z - targetZ) < Math.abs(best.z - targetZ)) ? o : best), null)

// Inland land-sector probe: cloud_cover (oktas) AM/midday + 2 m air Tmax over the
// land upwind of the course (toward land = coast normal + 180°). Small Open-Meteo
// call; returns { cloudAm, cloudMid, airTmaxC } (oktas 0-8), or nulls on failure.
async function fetchLandSector(p1lat, p1lon, coastNormalDeg, tz) {
  const out = { cloudAm: null, cloudMid: null, airTmaxC: null }
  if (coastNormalDeg == null) return out
  const inland = (coastNormalDeg + 180) * (Math.PI / 180)   // bearing toward land
  const cosLat = Math.max(0.2, Math.cos(p1lat * Math.PI / 180))
  // sample three points ~5/10/15 km inland and average
  const pts = [0.045, 0.09, 0.135].map((d) => ({
    lat: p1lat + d * Math.cos(inland), lon: p1lon + (d / cosLat) * Math.sin(inland),
  }))
  try {
    const lat = pts.map((p) => p.lat.toFixed(4)).join(',')
    const lon = pts.map((p) => p.lon.toFixed(4)).join(',')
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=cloud_cover,temperature_2m&timezone=${encodeURIComponent(tz)}&forecast_days=1`
    const res = await fetch(url, { signal: AbortSignal.timeout?.(6000) }); if (!res.ok) return out
    const j = await res.json()
    const arr = Array.isArray(j) ? j : [j]
    const okta = (pct) => (pct == null ? null : (pct / 100) * 8)
    const hourIdx = (h, hh) => (h.time || []).findIndex((t) => t.slice(11, 13) === pad2(hh))
    const am = []; const mid = []; const tmax = []
    for (const g of arr) {
      const h = g.hourly; if (!h) continue
      const ia = hourIdx(h, 10); const im = hourIdx(h, 12)
      if (ia >= 0) am.push(okta(h.cloud_cover?.[ia]))
      if (im >= 0) mid.push(okta(h.cloud_cover?.[im]))
      if (Array.isArray(h.temperature_2m)) tmax.push(Math.max(...h.temperature_2m.filter((x) => x != null)))
    }
    out.cloudAm = dMean(am); out.cloudMid = dMean(mid); out.airTmaxC = dMean(tmax)
  } catch { /* */ }
  return out
}

// SST for ΔT: read from a box-published SSA-Race field if present (CMEMS SST is
// already ingested on the box). Graceful null until the box publishes it (task #24).
function readVenueSST(point1) {
  const c = point1 || {}
  return c.ssaSst ?? c.sst ?? c.ssaSounding?.sst ?? null
}

// Resolve `fallback` if `promise` hasn't settled within `ms` — so no single
// network call can hang deck generation. The underlying fetch keeps running but
// we stop awaiting it.
function withTimeout(promise, ms, fallback = null) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((res) => setTimeout(() => res(fallback), ms)),
  ])
}

// ── diagnostics orchestrator ─────────────────────────────────────────────────
// Assembles the deterministic racing diagnostics from the already-fetched data.
// All terms degrade gracefully to null (the scores treat missing inputs neutrally).
async function buildDiagnostics(o) {
  const { snd, todayModels, mastH, tz, p1lat, p1lon, venueKey, hemisphere, field, sst, landSector } = o
  // coast normal (override → DEM mask) — reuse a precomputed value when given
  let coast = o.coast
  if (!coast) { try { coast = await coastNormalForPoint(venueKey, p1lat, p1lon) } catch { coast = { deg: null, source: 'none' } } }
  const θ = coast?.deg ?? null

  // sounding-derived stability + low-level / gradient winds, averaged over the
  // CLASSIFICATION WINDOW 13:00-15:00 local (peak sea-breeze) — a single 13:00
  // snapshot under-reads a breeze that is still filling.
  let stab = { lapseRateCkm: null, capBaseM: null, capStrengthC: null, nearDryAdiabatic: false, hasLowCap: false }
  let lowLevelKt = null; let gradDir = null; let gradKt = null; let blTopDir = null; let surfDir = null
  if (snd?.h) {
    const lt = localTimes(snd.h, tz)
    const day0 = (lt[snd.idx] || lt[0] || '').slice(0, 10)
    const widx = [13, 14, 15].map((hh) => lt.findIndex((t) => t.slice(0, 10) === day0 && t.slice(11, 13) === pad2(hh))).filter((k) => k >= 0)
    if (!widx.length) widx.push(snd.idx)
    const surfDirs = []; const gradDirs = []; const blTopDirs = []; const gradKts = []; const lowKts = []
    let stabProf = null
    const midIx = widx[Math.floor(widx.length / 2)]
    for (const ix of widx) {
      const prof = ensureHeights(buildSoundingProfile(snd.h, snd.levels, ix)
        .filter((x) => x.tempC != null).sort((a, b) => b.press - a.press))
      if (prof.length < 2) continue
      if (ix === midIx || !stabProf) stabProf = prof
      const band = prof.filter((x) => x.z >= 100 && x.z <= 900 && x.wspdKt != null)
      if (band.length) lowKts.push(dMean(band.map((x) => x.wspdKt)))
      const g = nearestByZ(prof, 600); if (g?.wdir != null) gradDirs.push(g.wdir); if (g?.wspdKt != null) gradKts.push(g.wspdKt)
      const bt = nearestByZ(prof, 900); if (bt?.wdir != null) blTopDirs.push(bt.wdir)
      if (prof[0]?.wdir != null) surfDirs.push(prof[0].wdir)
    }
    if (stabProf) stab = stabilityFromSounding(stabProf)
    surfDir = surfDirs.length ? circMean(surfDirs) : null
    gradDir = gradDirs.length ? circMean(gradDirs) : null
    blTopDir = blTopDirs.length ? circMean(blTopDirs) : null
    gradKt = gradKts.length ? dMean(gradKts) : null
    lowLevelKt = lowKts.length ? dMean(lowKts) : null
  }

  // hpbl (mixed-layer depth) — peak over the racing window for the gate
  let hMix = null
  for (const k of ['ICONRACE', 'ICONRACE_1KM']) {
    const hh = o.point1?.surfaceByModel?.[k]?.hourly?.boundary_layer_height
    if (Array.isArray(hh)) { const m = Math.max(...hh.filter((v) => v != null)); if (Number.isFinite(m)) { hMix = m; break } }
  }
  if (hMix == null) { const hh = o.point1?.gfs?.hourly?.boundary_layer_height; if (Array.isArray(hh)) { const m = Math.max(...hh.filter((v) => v != null)); if (Number.isFinite(m)) hMix = m } }

  // coast-relative wind primitives
  const thermalBendDeg = (surfDir != null && gradDir != null) ? thermalBend(surfDir, gradDir) : null
  const sbi = (θ != null && surfDir != null && blTopDir != null) ? seaBreezeIndex(surfDir, blTopDir, θ) : null
  const crossKt = (θ != null && gradDir != null && gradKt != null) ? crossShoreComponent(gradDir, gradKt, θ) : null
  const quad = (θ != null && gradDir != null && gradKt != null) ? quadrantModifier(θ, gradDir, gradKt, hemisphere) : null

  // insolation gate + thermal contrast
  const cloud = cloudTrend({ landCloudAm: landSector?.cloudAm, landCloudMid: landSector?.cloudMid })
  const gSolar = landSector?.cloudAm != null ? clamp01(1 - 0.8 * (landSector.cloudAm / 8)) : 1
  const deltaT = (landSector?.airTmaxC != null && sst != null) ? landSector.airTmaxC - sst : null

  // gates + score
  const gStab = stabilityGate({ hMix, capBaseM: stab.capBaseM, capStrengthC: stab.capStrengthC, nearDryAdiabatic: stab.nearDryAdiabatic })
  const gateHealthy = (gStab * gSolar) >= 0.35
  const quadFav = !!(quad && quad.scoreMod > 0)
  // ONSHORE gradient days (Q3/Q4-type) get thermal enhancement that reinforces the
  // onshore flow — there is NO closed circulation (low/zero SBI) and often little
  // veering bend, so the enhancement signal is simply "onshore gradient + heating".
  const onshoreEnhance = gateHealthy && crossKt != null && crossKt < -1
  const thermalActive = (sbi != null && sbi > 0.08) || (thermalBendDeg != null && Math.abs(thermalBendDeg) > 20) || quadFav || onshoreEnhance
  const favourable = gateHealthy && thermalActive
  const sbScore = seaBreezeScore({ gStab, gSolar, offshoreKt: crossKt ?? 0, deltaT, lapseRateCkm: stab.lapseRateCkm, hMix, quadMod: quad?.scoreMod ?? 0 })

  // funnelling on the wind field (frame nearest 12:00 local)
  let funnel = null; let funnelHit = false
  if (field?.frames?.length) {
    const labels = field.stamps || field.labels || []
    let fi = labels.findIndex((s) => String(s).includes('12:00'))
    if (fi < 0) fi = Math.floor(field.frames.length / 2)
    const fr = field.frames[fi]
    if (fr) {
      try {
        funnel = funnelDiagnostics({ ...field.header, u: fr.u, v: fr.v })
        funnelHit = funnelFlag(funnel, p1lat, p1lon, 6)
      } catch { /* */ }
    }
  }

  // type of day (4 classes) — gate-healthy + thermal signal (bend/sbi/quadrant)
  const tod = dTypeOfDay({ lowLevelKt, favourable: gateHealthy, thermalActive, quadFav, thermalBendDeg, sbi, funnelFlag: funnelHit })

  // multi-model spread + confidence over the racing window (13:00-15:00 local)
  const dirs = []; const spds = []
  for (const m of todayModels || []) {
    const day0 = m.lt[0]?.slice(0, 10)
    const md = []; const ms = []
    for (const hh of [13, 14, 15]) {
      const j = idxAtL(m, day0, hh); if (j < 0) continue
      const d = dirAt(m, j); if (d != null) md.push(d)
      const s = mastKn(m.hourly, m.heights, mastH, j, m.mos); if (s != null) ms.push(s)
    }
    if (md.length) dirs.push(circMean(md))
    if (ms.length) spds.push(dMean(ms))
  }
  const spread = modelSpread(dirs, spds)
  const twsKn = spds.length ? dMean(spds) : null
  const marginality = clamp01(0.4 + 0.6 * Math.abs((sbScore.score ?? 5) - 5) / 5)
  const conf = confidence({ seaBreezeMarginality: marginality, sigmaTwd: spread.sigmaTwd, sigmaTws: spread.sigmaTws, twsKn })

  return {
    coast: { deg: θ != null ? Math.round(θ) : null, source: coast.source },
    typeOfDay: tod.label, typeClass: tod.cls,
    seaBreeze: {
      score: sbScore.score,
      quadrant: quad?.quadrant ?? null,
      expectedDirFrom: quad?.dirOnsetFrom ?? null,
      veerToFrom: quad?.dirPeakFrom ?? null,
      timing: quad?.timing ?? null,
      sbi: sbi != null ? Math.round(sbi * 100) / 100 : null,
      crossShoreKt: crossKt != null ? Math.round(crossKt * 10) / 10 : null,
      thermalBendDeg: thermalBendDeg != null ? Math.round(thermalBendDeg) : null,
      lowLevelKt: lowLevelKt != null ? Math.round(lowLevelKt) : null,
      deltaT: deltaT != null ? Math.round(deltaT * 10) / 10 : null,
      favourable,
    },
    stability: {
      hMixM: hMix != null ? Math.round(hMix) : null,
      capBaseM: stab.capBaseM != null ? Math.round(stab.capBaseM) : null,
      capStrengthC: stab.capStrengthC != null ? Math.round(stab.capStrengthC * 10) / 10 : null,
      lapseRateCkm: stab.lapseRateCkm != null ? Math.round(stab.lapseRateCkm * 10) / 10 : null,
      gate: Math.round(gStab * 100) / 100,
      hasLowCap: stab.hasLowCap,
    },
    cloud,
    confidence: conf,
    funnelling: { flag: funnelHit, cores: funnel ? funnel.cores.length : 0, rMax: funnel ? Math.round((funnel.sMax / funnel.sRef) * 100) / 100 : null },
  }
}

// ── deck builder ─────────────────────────────────────────────────────────────
const NAVY = '1F4E79'; const INK = '202020'; const GREY = '6B7280'; const HEADER = 'D6DCE5'; const LIGHTF = 'F2F4F7'; const FONT = 'Helvetica Neue'
function spdCell(text) { const nums = (text.match(/\d+/g) || []).map(Number).filter((x) => x <= 60); if (!nums.length) return { text, options: { color: INK, fontFace: FONT, fontSize: 12, valign: 'middle', align: 'left' } }; const bf = beaufort(nums.reduce((a, b) => a + b, 0) / nums.length); return { text, options: { fill: { color: bf.hex }, color: bf.dark ? 'FFFFFF' : '0F1723', fontFace: FONT, fontSize: 12, valign: 'middle', align: 'left' } } }
const txtCell = (text, o = {}) => ({ text, options: { color: INK, fontFace: FONT, fontSize: 12, valign: 'middle', align: 'left', ...o } })
const hdrCell = (text) => ({ text, options: { fill: { color: HEADER }, color: INK, bold: true, fontFace: FONT, fontSize: 12, valign: 'middle' } })
function addTitle(s, title, sub) { s.addText(title, { x: 0.5, y: 0.3, w: 12.3, h: 0.7, fontFace: FONT, fontSize: 34, bold: true, color: NAVY }); if (sub) s.addText(sub, { x: 0.52, y: 1.0, w: 12.3, h: 0.35, fontFace: FONT, fontSize: 12, color: GREY }) }
function ph(s, x, y, w, h, label) { s.addShape('roundRect', { x, y, w, h, fill: { color: LIGHTF }, line: { color: 'C2C9D4', width: 1 }, rectRadius: 0.1 }); s.addText(label, { x, y, w, h, align: 'center', valign: 'middle', fontFace: FONT, fontSize: 14, color: GREY }) }
const fit = (iw, ih, x, y, w, h) => { const r = Math.min(w / (iw || 1), h / (ih || 1)); const dw = (iw || 1) * r; const dh = (ih || 1) * r; return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh } }
// TWD cell = trailing text only (Beaufort fill kept). The wind arrow is NOT a
// glyph here — it's a single PNG overlaid on the cell and ROTATED continuously
// (constant size, any angle) by overlayWindArrows() after the table is laid out.
function arrowCell(twdMean, kn, trailing, fill, dark) {
  const color = fill ? (dark ? 'FFFFFF' : '0F1723') : INK
  return { text: trailing || '', options: { ...(fill ? { fill: { color: fill } } : {}), valign: 'middle', align: 'center', color, fontFace: FONT, fontSize: 12 } }
}
const oCell = (b) => { if (!b) return txtCell('—'); const bf = beaufort(b.twsMid); return arrowCell(b.twdMean, b.twsMid, `${b.tws[0]}-${b.tws[1]}kn`, bf.hex, bf.dark) }
// daily TWD cell: the mean TWD (rounded to 5 deg), no fill; arrow overlaid.
const twdCell = (twdMean) => arrowCell(twdMean, null, twdMean != null ? `${round5(twdMean)}` : '')

// One reusable wind-arrow PNG (points UP / north at 0°). Dark fill + white halo
// so it reads on both light and Beaufort-coloured cells. Built once.
let _windArrowPng = null
function windArrowPng() {
  if (_windArrowPng) return _windArrowPng
  if (typeof document === 'undefined') return null
  const N = 96, cv = document.createElement('canvas'); cv.width = cv.height = N
  const ctx = cv.getContext('2d'); if (!ctx) return null
  ctx.translate(N / 2, N / 2)
  const s = N * 0.36, hw = N * 0.18, sw = N * 0.065, neck = -s + hw * 1.25
  ctx.beginPath()
  ctx.moveTo(0, -s)            // tip (north)
  ctx.lineTo(hw, neck); ctx.lineTo(sw, neck); ctx.lineTo(sw, s)
  ctx.lineTo(-sw, s); ctx.lineTo(-sw, neck); ctx.lineTo(-hw, neck)
  ctx.closePath()
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = N * 0.085; ctx.stroke()  // halo
  ctx.fillStyle = '#16263A'; ctx.fill()
  _windArrowPng = cv.toDataURL('image/png')
  return _windArrowPng
}

// Overlay rotated wind arrows on a just-added table. `cols` maps a table column
// to a centre-x and a row→TWD accessor. Arrow points the way the wind BLOWS
// (toward = TWD+180), rotated clockwise from north. rowH must be honoured by the
// table (single-line cells), which the deck's tables are.
function overlayWindArrows(s, rows, { y, rowH, headerRows = 1, cols, size = 0.22 }) {
  const png = windArrowPng(); if (!png) return
  rows.forEach((row, i) => {
    const cy = y + rowH * (headerRows + i) + rowH / 2
    cols.forEach((col) => {
      const twd = col.twdOf(row)
      if (twd == null) return
      const toward = Math.round(((((twd + 180) % 360) + 360) % 360))
      s.addImage({ data: png, x: col.cx - size / 2, y: cy - size / 2, w: size, h: size, rotate: toward })
    })
  })
}
// one-line diagnostics chips (sea-breeze score, confidence, BL, cap, funnelling)
function diagChips(dg) {
  if (!dg) return []
  const ch = []
  if (dg.seaBreeze?.score != null) ch.push(`Sea-breeze ${dg.seaBreeze.score}/10${dg.seaBreeze.quadrant ? ` (${dg.seaBreeze.quadrant})` : ''}`)
  if (dg.confidence?.label) ch.push(`Confidence ${dg.confidence.label}${dg.confidence.sigmaTwd != null ? ` (σTWD ${dg.confidence.sigmaTwd}°)` : ''}`)
  if (dg.stability?.hMixM != null) ch.push(`BL ${dg.stability.hMixM} m`)
  ch.push(dg.stability?.hasLowCap ? 'capped' : 'no low cap')
  if (dg.funnelling?.flag) ch.push('funnelling ⚑')
  return ch
}

function buildDeck(P, d) {
  const pptx = new P(); pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 }); pptx.layout = 'WIDE'
  // 0) Title + executive brief
  let s = pptx.addSlide()
  s.addText('Weather and strategy brief', { x: 0.6, y: 0.5, w: 12.1, h: 0.9, fontFace: FONT, fontSize: 40, bold: true, color: NAVY })
  const meta = [d.typeOfDay, d.raceDay ? `Race day ${d.raceDay}` : null].filter(Boolean).join('   ·   ')
  s.addText([{ text: d.venue, options: { fontFace: FONT, fontSize: 18, bold: true, color: INK, breakLine: true } }, { text: meta, options: { fontFace: FONT, fontSize: 13, color: GREY } }], { x: 0.6, y: 1.55, w: 12.1, h: 0.55, valign: 'top' })
  const dg = d.diag
  // Key Numbers box (TWS range / peak / TWD net change) — like the team report
  const rws = d.dailyRows || []
  if (rws.length) {
    const los = rws.map((r) => r.lo).filter((x) => x != null)
    const his = rws.map((r) => r.hi).filter((x) => x != null)
    const twsMin = los.length ? Math.min(...los) : null
    const twsMax = his.length ? Math.max(...his) : null
    const tm0 = rws.find((r) => r.twdMean != null)?.twdMean
    const tm1 = [...rws].reverse().find((r) => r.twdMean != null)?.twdMean
    const netd = (tm0 != null && tm1 != null) ? ((((tm1 - tm0) % 360) + 540) % 360) - 180 : null
    s.addShape('roundRect', { x: 0.6, y: 2.1, w: 12.1, h: 0.62, fill: { color: LIGHTF }, line: { color: 'C2C9D4', width: 1 }, rectRadius: 0.08 })
    const kv = (k, v) => ([{ text: `${k} `, options: { color: GREY, fontFace: FONT, fontSize: 12 } }, { text: v, options: { color: NAVY, bold: true, fontFace: FONT, fontSize: 13 } }, { text: '        ', options: {} }])
    const parts = []
    if (twsMin != null) parts.push(...kv('TWS range', `${twsMin}–${twsMax} kn`))
    if (twsMax != null) parts.push(...kv('Peak', `${twsMax} kn`))
    if (netd != null) parts.push(...kv('TWD net', `${netd >= 0 ? '+' : ''}${Math.round(netd)}° (${round5(tm0)}→${round5(tm1)})`))
    if (parts.length) s.addText(parts, { x: 0.85, y: 2.1, w: 11.6, h: 0.62, valign: 'middle', fontFace: FONT })
  }
  s.addText('Executive summary', { x: 0.6, y: 2.9, w: 12, h: 0.4, fontFace: FONT, fontSize: 16, bold: true, color: NAVY })
  const sec = (label, txt) => ([{ text: `${label}:  `, options: { bold: true, color: NAVY, fontFace: FONT, fontSize: 14 } }, { text: txt || '—', options: { color: INK, fontFace: FONT, fontSize: 14, breakLine: true } }])
  s.addText([...sec('Situation', d.ai?.situation), ...sec("Today's wind", d.ai?.todaysWind), ...sec('Stability', d.ai?.stability), ...sec('Outlook', d.ai?.outlook), ...sec('Confidence', d.ai?.confidenceNote)], { x: 0.6, y: 3.35, w: 12.1, h: 3.3, fontFace: FONT, valign: 'top', paraSpaceAfter: 12 })
  if (!d.ai) s.addText('AI summary unavailable — set ANTHROPIC_API_KEY (or edit these lines directly).', { x: 0.6, y: 6.95, w: 12, h: 0.3, fontFace: FONT, fontSize: 10, color: GREY })
  s = pptx.addSlide(); addTitle(s, 'General weather', d.subtitle)
  if (d.ai?.generalWeather) s.addText(d.ai.generalWeather, { x: 0.5, y: 1.6, w: 12.3, h: 5.2, fontFace: FONT, fontSize: 15, color: INK, valign: 'top', paraSpaceAfter: 12 })
  else s.addText(d.generalBullets.map((t) => ({ text: t, options: { bullet: true, breakLine: true, paraSpaceAfter: 12 } })), { x: 0.5, y: 1.6, w: 12.3, h: 5.2, fontFace: FONT, fontSize: 18, color: INK })

  // Second General weather page — the 4× 3D wind-field snapshots (30 m wind),
  // SSA-Race 1 km when available. Full-slide 2×2 grid.
  if (d.views3d && d.views3d.length) {
    s = pptx.addSlide(); addTitle(s, 'General weather', d.subtitle)
    const cells = [[0.7, 1.5], [6.95, 1.5], [0.7, 4.45], [6.95, 4.45]]
    d.views3d.slice(0, 4).forEach((v, i) => {
      const [cx, cy] = cells[i]
      s.addImage({ data: v.png, ...fit(760, 460, cx, cy, 5.65, 2.6) })
      s.addText(`${v.label} local`, { x: cx, y: cy + 2.62, w: 5.65, h: 0.26, align: 'center', fontFace: FONT, fontSize: 11, bold: true, color: NAVY })
    })
    const h3d = d.views3d[0].height
    s.addText(`3D wind field — ${d.views3d[0].model}${h3d ? ` · ${h3d} m wind` : ''} · oriented upwind · 5 nm racing area`, { x: 0.7, y: 7.08, w: 12.3, h: 0.3, align: 'center', fontFace: FONT, fontSize: 10, color: GREY })
  } else if (d.windfieldImg) {
    s = pptx.addSlide(); addTitle(s, 'General weather', d.subtitle)
    s.addImage({ data: d.windfieldImg.data, ...fit(d.windfieldImg.w, d.windfieldImg.h, 2.8, 1.6, 7.7, 5.3) })
    s.addText('Wind field — 12:00 local · 5 nm racing area', { x: 2.8, y: 7.0, w: 7.7, h: 0.3, align: 'center', fontFace: FONT, fontSize: 11, color: GREY })
  }
  s = pptx.addSlide(); addTitle(s, 'Outlook')
  // Transposed: days across the top (columns), time-of-day down the side (rows).
  const oDays = d.outlookRows
  const oX = 0.5, oY = 1.4, oFirstW = 1.9, oRowH = 0.5
  const oDayW = (12.33 - oFirstW) / Math.max(1, oDays.length)
  const oPeriods = [['Morning (10:00)', 'mor'], ['Midday (12:00)', 'mid'], ['Afternoon (15:00)', 'aft']]
  const oHead = [hdrCell(''), ...oDays.map((r) => hdrCell(r.day))]
  const oRows = oPeriods.map(([label, key]) => [txtCell(label, { bold: true, fill: { color: LIGHTF } }), ...oDays.map((r) => oCell(r[key]))])
  s.addTable([oHead, ...oRows], { x: oX, y: oY, w: 12.33, colW: [oFirstW, ...oDays.map(() => oDayW)], rowH: oRowH, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, valign: 'middle' })
  // One arrow per (period row × day column). Period rows are the table "rows";
  // each day column gets its own centre-x and reads that period's TWD.
  overlayWindArrows(s, oPeriods.map(([, key]) => ({ key })), {
    y: oY, rowH: oRowH,
    cols: oDays.map((r, j) => ({ cx: oX + oFirstW + j * oDayW + 0.30, twdOf: (p) => r[p.key]?.twdMean ?? null })),
  })
  if (d.longRange) s.addImage({ data: d.longRange, ...fit(1400, 520, 0.5, 3.5, 12.33, 3.3) }); else ph(s, 0.5, 3.5, 12.33, 3.3, '4-day TWS & TWD (±1σ, racing window)')
  s.addText('AM/Mid/PM = 10:00/12:00/15:00 local · TWD (cardinal) & TWS ranges = weighted models (all day 1-2, ARPEGE+ECMWF beyond)', { x: 0.5, y: 7.04, w: 12.3, h: 0.32, fontFace: FONT, fontSize: 9.5, color: GREY })
  s = pptx.addSlide(); addTitle(s, 'Details for today')
  s.addText(d.dailyBullets.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })), { x: 0.5, y: 1.05, w: 12.3, h: 0.7, fontFace: FONT, fontSize: 12, color: INK })
  const dHead = [hdrCell('Time'), hdrCell('TWD'), hdrCell(`TWS ${d.venue}`), hdrCell('TWD range'), hdrCell('TWS min&max'), hdrCell('Trend'), hdrCell('Notes')]
  const dRows = d.dailyRows.map((r) => [txtCell(r.time, { bold: true, fill: { color: LIGHTF } }), twdCell(r.twdMean), spdCell(r.tws), txtCell(r.twd), spdCell(`${r.lo}-${r.hi}kn`), txtCell(r.trend), txtCell('')])
  s.addTable([dHead, ...dRows], { x: 0.5, y: 1.85, w: 12.33, colW: [1.0, 1.5, 1.2, 1.5, 1.6, 2.4, 3.13], rowH: 0.4, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, valign: 'middle' })
  // TWD col left = 0.5+1.0 = 1.5 (width 1.5); arrow near its left, number centred.
  overlayWindArrows(s, d.dailyRows, { y: 1.85, rowH: 0.4, cols: [
    { cx: 1.5 + 0.30, twdOf: (r) => r.twdMean ?? null },
  ] })
  s.addText(`TWS at mast height (${d.mastH} m), MOS where available · Model: ${d.shortModelLabel} · min&max = weighted blend`, { x: 0.5, y: 7.04, w: 12.3, h: 0.32, fontFace: FONT, fontSize: 9.5, color: GREY })
  // Stability — boundary-layer height + 13:00 sounding
  s = pptx.addSlide(); addTitle(s, 'Stability')
  if (dg) {
    const st = dg.stability || {}; const sbb = dg.seaBreeze || {}
    const cap = st.hasLowCap ? `low cap +${st.capStrengthC}°C @ ${st.capBaseM} m` : (st.capBaseM != null ? `cap aloft @ ${st.capBaseM} m` : 'no cap')
    const line = `Stability: ${cap} · lapse ${st.lapseRateCkm ?? '—'} °C/km · h_mix ${st.hMixM ?? '—'} m · gate ${st.gate ?? '—'}     |     `
      + `Sea-breeze ${sbb.score ?? '—'}/10${sbb.quadrant ? ` (${sbb.quadrant})` : ''}: SBI ${sbb.sbi ?? '—'}, cross-shore ${sbb.crossShoreKt ?? '—'} kt, bend ${sbb.thermalBendDeg ?? '—'}°${sbb.deltaT != null ? `, ΔT ${sbb.deltaT} °C` : ''}`
    s.addText(line, { x: 0.4, y: 0.98, w: 12.55, h: 0.34, fontFace: FONT, fontSize: 10.5, color: NAVY })
  }
  if (d.hpblImg) s.addImage({ data: d.hpblImg, ...fit(1000, 560, 0.4, 1.7, 6.4, 4.6) }); else ph(s, 0.4, 1.7, 6.4, 4.6, 'Boundary-layer height\n(no SSA / GFS hpbl data)')
  if (d.soundingImg) s.addImage({ data: d.soundingImg, ...fit(820, 900, 7.0, 1.3, 5.9, 5.5) }); else ph(s, 7.0, 1.3, 5.9, 5.5, 'Vertical sounding @ 13:00\n(no sounding data here)')
  s.addText('hpbl: point 1, racing window shaded · sounding: 13:00 local, low-level zoom', { x: 0.5, y: 7.04, w: 12.3, h: 0.32, fontFace: FONT, fontSize: 9.5, color: GREY })
  s = pptx.addSlide(); addTitle(s, 'Model comparison — wind speed & TWD (±1σ)')
  if (d.cmpSpeed) s.addImage({ data: d.cmpSpeed, ...fit(1000, 600, 0.4, 1.5, 6.3, 4.7) }); else ph(s, 0.4, 1.5, 6.3, 4.7, 'Wind-speed comparison')
  if (d.cmpDir) s.addImage({ data: d.cmpDir, ...fit(1000, 600, 6.9, 1.5, 6.0, 4.7) }); else ph(s, 6.9, 1.5, 6.0, 4.7, 'Wind-direction (TWD) comparison')
  if (d.ai?.modelComparison) s.addText(d.ai.modelComparison, { x: 0.4, y: 6.4, w: 12.5, h: 0.95, fontFace: FONT, fontSize: 11.5, color: INK, valign: 'top' })

  // Confidence & side notes — diagnostics chip line + local-effects / triggers prose
  s = pptx.addSlide(); addTitle(s, 'Confidence & side notes')
  const chips = diagChips(dg)
  if (chips.length) s.addText(chips.join('    ·    '), { x: 0.5, y: 1.25, w: 12.3, h: 0.4, fontFace: FONT, fontSize: 13, bold: true, color: NAVY })
  s.addText(d.ai?.sideNotes || 'Local effects, terrain channelling and tactical triggers — edit. (AI side notes unavailable.)',
    { x: 0.5, y: 1.95, w: 12.3, h: 4.7, fontFace: FONT, fontSize: 14, color: INK, valign: 'top', paraSpaceAfter: 10 })
  return pptx
}

// ── component ───────────────────────────────────────────────────────────────
export default function ForecastDeck({ p1lat, p1lon, windData, mastHeight = 20, resolvedTz = 'UTC', raceDay = null }) {
  const campaignRaceDay = raceDay
  const pptxReady = useScriptsOnce([PPTX_JS]); useScriptsOnce([PLOTLY_JS]); useScriptsOnce([MAPLIBRE_JS, DECK_JS], [MAPLIBRE_CSS])
  const point1 = windData?.['1']; const haveP1 = p1lat != null && p1lon != null && !!point1
  const shortModels = useMemo(() => { const sb = point1?.surfaceByModel || {}; return Object.keys(MODELS).filter((k) => sb[k] && hasValidSpeed(sb[k].hourly)) }, [point1])
  // Default outlook model: ARPEGE (falls back to ECMWF at generate time if its
  // extended data isn't available). Default short-term model preference:
  // SSA-Race 1 km → SSA-Race 2 km → AROME → ECMWF.
  const SHORT_PREF = ['ICONRACE_1KM', 'ICONRACE', 'AROME', 'ECMWF']
  const [outlookModel, setOutlookModel] = useState('ARPEGE'); const [shortModel, setShortModel] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  const shortSel = shortModel && shortModels.includes(shortModel) ? shortModel : (SHORT_PREF.find((k) => shortModels.includes(k)) || shortModels[0] || '')

  async function generate() {
    setErr(''); setBusy(true)
    try {
      const P = window.PptxGenJS; if (!P) throw new Error('engine loading — retry shortly')
      const venueName = (matchVenue(p1lat, p1lon) || 'venue').replace(/_/g, ' '); const tz = resolvedTz || 'UTC'
      const venueKey = matchVenue(p1lat, p1lon); const spec = venueKey ? specFor(venueKey) : null
      const mosFor = (key, hourly) => { const id = MODELS[key]?.mosModel; return spec && id ? mosSeries(hourly, MODELS[key]?.heights || [10], spec, id, tz) : null }
      const mk = (k, hourly, heights) => ({ key: k, hourly, lt: localTimes(hourly, tz), heights: heights || MODELS[k]?.heights || [10], mos: mosFor(k, hourly), weight: WEIGHTS[k] || 0.5 })
      const sb = point1.surfaceByModel
      const todayModels = ALL_TODAY.filter((k) => sb[k] && hasValidSpeed(sb[k].hourly)).map((k) => mk(k, sb[k].hourly))
      const short = mk(shortSel, sb[shortSel].hourly)
      const dailyRows = buildDaily(short, mastHeight, todayModels.filter((m) => m.key !== shortSel))

      const gJsons = await Promise.all(OUTLOOK_MODELS.map((k) => fetchModelDays(k, p1lat, p1lon, tz, OUTLOOK_DAYS).catch(() => null)))
      const globals = OUTLOOK_MODELS.map((k, i) => ({ k, json: gJsons[i] })).filter((x) => x.json?.hourly?.time).map((x) => mk(x.k, x.json.hourly, heightsFromHourly(x.json.hourly)))
      const centralJson = gJsons[OUTLOOK_MODELS.indexOf(outlookModel)] || gJsons.find(Boolean)
      const centralLt = centralJson ? localTimes(centralJson.hourly, tz) : []
      const dates = [...new Set(centralLt.map((t) => t.slice(0, 10)))].slice(0, OUTLOOK_DAYS)
      const outlookRows = buildOutlook(dates, (di) => (di < 2 ? [...todayModels, ...globals] : globals), mastHeight)

      let cmp = [null, null]; let longRange = null; let windfieldImg = null; let hpblImg = null; let soundingImg = null
      try { cmp = await captureComparison(todayModels, mastHeight) } catch { /* */ }
      try { longRange = await captureLongRange(globals, mastHeight) } catch { /* */ }
      try { hpblImg = await captureHpbl(point1, tz) } catch { /* */ }
      let snd = null
      try { snd = await captureSounding(p1lat, p1lon, point1, tz); soundingImg = snd?.png } catch { /* */ }
      let field = null
      try {
        field = shortSel.startsWith('ICONRACE')
          ? await fetchIconRaceField({ lat: p1lat, lon: p1lon, height: mastHeight, timezone: tz, modelKey: shortSel })
          : (MODELS[shortSel]?.endpoint ? await fetchWindField({ modelKey: shortSel, lat: p1lat, lon: p1lon, height: mastHeight, timezone: tz }) : null)
        if (field) windfieldImg = await windfieldCoast(field, p1lat, p1lon)
      } catch { /* */ }

      // ── 4× 3D snapshots (SSA-Race 1 km if available, else AROME) @ 10/12/14/16 ──
      // for the General weather slide. Captured at 30 m wind. Time-bounded; falls
      // back to the 2D windfield.
      const VIEW3D_HEIGHT_M = 30
      let views3d = []
      try {
        const m3dKey = (sb.ICONRACE_1KM && hasValidSpeed(sb.ICONRACE_1KM.hourly)) ? 'ICONRACE_1KM' : 'AROME'
        const f3d = m3dKey.startsWith('ICONRACE')
          ? await fetchIconRaceField({ lat: p1lat, lon: p1lon, height: VIEW3D_HEIGHT_M, timezone: tz, modelKey: m3dKey })
          : await fetchWindField({ modelKey: m3dKey, lat: p1lat, lon: p1lon, height: VIEW3D_HEIGHT_M, timezone: tz })
        const stamps = f3d?.stamps || []
        const frameIndices = [10, 12, 14, 16].map((H) => stamps.findIndex((s) => s && s.hh === H)).filter((i) => i >= 0)
        const ML = window.maplibregl
        if (ML && f3d?.frames?.length && frameIndices.length) {
          // Zoomed tighter (≈ 5 nm racing radius) than the live viewer's 10.4.
          const caps = await withTimeout(captureField3DSeries(ML, f3d, { lat: p1lat, lon: p1lon, width: 760, height: 460, exaggeration: 3, frameIndices, zoom: 11.6 }), 55000, [])
          views3d = (caps || []).map((c) => { const s = stamps[c.idx]; return { label: s ? `${pad2(s.hh)}:00` : '', model: MODELS[m3dKey]?.label || m3dKey, height: VIEW3D_HEIGHT_M, png: c.png } }).filter((v) => v.png)
        }
      } catch { /* */ }

      // ── deterministic racing diagnostics (feed the slides + the AI brief) ──
      // TIME-BOUNDED: the diagnostics make extra network calls (elevation /
      // land-sector). They must NEVER block the deck — if they stall, the deck
      // still builds (diag = null → slides just omit the diagnostic chips).
      let diag = null
      try {
        diag = await withTimeout((async () => {
          const coast = await coastNormalForPoint(venueKey, p1lat, p1lon)
          const landSector = await fetchLandSector(p1lat, p1lon, coast.deg, tz)
          return buildDiagnostics({
            snd, todayModels, mastH: mastHeight, tz, p1lat, p1lon, point1, venueKey, coast,
            hemisphere: p1lat >= 0 ? 'N' : 'S', field, sst: readVenueSST(point1), landSector,
          })
        })(), 9000, null)
      } catch { /* */ }

      const peak = dailyRows.reduce((m, r) => (r.hi > (m?.hi ?? -1) ? r : m), null)

      // ── executive summary: AI brief grounded in the diagnostics (heuristic fallback) ──
      const morn = dailyRows.find((r) => r.time === '09:00') || dailyRows[0]
      const aftn = dailyRows.find((r) => r.time === '15:00') || dailyRows[dailyRows.length - 1]
      const typeHeur = (morn && aftn && aftn.kn - morn.kn >= 3) ? 'Sea-breeze day' : 'Gradient day'
      const aiPayload = {
        venue: venueName,
        date: new Date().toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', timeZone: tz }),
        outlook: outlookRows.map((r) => ({ day: r.day, morning: r.mor && { twd: r.mor.twd, tws: r.mor.tws }, midday: r.mid && { twd: r.mid.twd, tws: r.mid.tws }, afternoon: r.aft && { twd: r.aft.twd, tws: r.aft.tws } })),
        today: dailyRows.map((r) => ({ time: r.time, twd: r.twd, twsKn: r.kn, range: `${r.lo}-${r.hi}kn`, trend: r.trend })),
        diagnostics: diag,
      }
      let ai = null; try { ai = await withTimeout(aiSummary(aiPayload), 20000, null) } catch { /* */ }

      const deck = buildDeck(P, {
        venue: venueName,
        typeOfDay: diag?.typeOfDay || ai?.typeOfDay || typeHeur, raceDay: campaignRaceDay, ai, diag,
        subtitle: `${venueName} — issued ${new Date().toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz })}`,
        outlookModelLabel: MODELS[outlookModel]?.label || outlookModel, shortModelLabel: MODELS[shortSel]?.label || shortSel,
        mastH: mastHeight, outlookRows, dailyRows, cmpSpeed: cmp[0], cmpDir: cmp[1], longRange, windfieldImg, hpblImg, soundingImg, views3d,
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

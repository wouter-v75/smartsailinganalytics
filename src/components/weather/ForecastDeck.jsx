// ForecastDeck.jsx
// ----------------------------------------------------------------------------
// Admin-only "Generate forecast" panel at the top of the Forecast tab. Builds the
// 4-slide racing-weather deck as an EDITABLE .pptx via pptxgenjs. All winds at MAST
// HEIGHT (+MOS). Every model is aligned on a common LOCAL-time grid (SSA-Race is UTC,
// Open-Meteo is venue-local — without this the comparison only showed the SSA lines).
//
// PAGE IS PORTRAIT 9:16 (7.5 × 13.333 in) — the deck is read on a phone on the dock,
// not projected. One column throughout; see the PAGE block above buildDeck.
//
//  • Wind field @ 12:00 over a detailed LIGHT coastline (CARTO tiles), cropped to the
//    domain (data fills the frame), with a 5 nm racing-area circle on point 1.
//  • ALL TWS/TWD ranges are the weighted-model mean ±1σ — the same statistic the
//    comparison charts shade. (They used to be the min/max envelope, so one bad model
//    set the width of the band; the table and the plots now agree.)
//  • Outlook: Morning/Midday/Afternoon = 10:00/12:00/15:00 local (all models day 1-2,
//    ARPEGE+ECMWF beyond).
//  • Slide order: Title · Summary · General weather · Outlook · Details · Model guidance ·
//    Model comparison · Strategic considerations · Stability & wind weight · Confidence.
//    Strategy sits AFTER the model evidence it is drawn from.
//  • Comparison + 4-day plots: day-mode Plotly, grey ±1σ band, racing-window (10-17) shading.
// ----------------------------------------------------------------------------
import React, { useMemo, useState } from 'react'
import { useScriptsOnce } from './useScriptOnce'
import { MODELS, interpolateSpeedAtHeight, hasValidSpeed, fetchIconRaceSounding, fetchWindweightNearest, SSARACE_SOUNDING_LEVELS, ICON_SOUNDING_LEVELS, ECMWF_SOUNDING_LEVELS, GFS_SOUNDING_LEVELS } from './openMeteo'
import { matchVenue, specFor, mosSeries } from './mos'
import { BEAUFORT_BANDS, PALETTE_MAX_KT, fetchWindField, fetchIconRaceField, sampleField } from './windField'
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
// TWD range = circular mean ± 1σ (was: full min/max envelope, which one outlier
// model could blow open). σ from the circular standard deviation, floored at 3°
// so a single-model hour still shows a usable band rather than a bare number.
function circRange(d) {
  if (!d.length) return null
  const m = circMean(d)
  const sd = Math.max(3, circStd(d))
  const wrap = (x) => Math.round(((x % 360) + 360) % 360)
  return [wrap(m - sd), wrap(m + sd)]
}
function beaufort(kn) { const N = BEAUFORT_BANDS.length; const x = Math.max(0, Math.min(0.999999, (kn || 0) / PALETTE_MAX_KT)); const pos = x * (N - 1); const i = Math.floor(pos); const t = pos - i; const a = BEAUFORT_BANDS[i].c; const b = BEAUFORT_BANDS[Math.min(N - 1, i + 1)].c; const r = Math.round(a[0] + (b[0] - a[0]) * t); const g = Math.round(a[1] + (b[1] - a[1]) * t); const bl = Math.round(a[2] + (b[2] - a[2]) * t); return { hex: ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1).toUpperCase(), dark: (0.299 * r + 0.587 * g + 0.114 * bl) < 128 } }
// TWS range = weighted mean ± 1 weighted σ. Previously this was the weighted
// min/max envelope, so the band was as wide as the worst model of the day; ±1σ is
// the same statistic the comparison charts already shade, so the table and the
// plots now say the same thing. σ is floored at 1 kt (a single model, or perfect
// agreement, still gets a band you can race to).
export function weightedBand(items) {
  const xs = items.filter((x) => x.v != null && Number.isFinite(x.v) && x.w > 0)
  if (!xs.length) return null
  const sw = xs.reduce((a, x) => a + x.w, 0)
  const mu = xs.reduce((a, x) => a + x.w * x.v, 0) / sw
  const varW = xs.reduce((a, x) => a + x.w * (x.v - mu) ** 2, 0) / sw
  const sd = Math.max(1, Math.sqrt(varW))
  // 3rd element = the weighted mean itself, so callers can label the band's
  // CENTRE consistently (the point value must lie inside [lo, hi]).
  return [Math.max(0, Math.round(mu - sd)), Math.round(mu + sd), mu]
}

// UTC 'Z' time -> 'YYYY-MM-DDTHH:MM' venue-local; Open-Meteo strings are already local.
function toLocal(t, tz) { const d = new Date(t.endsWith('Z') ? t : `${t}Z`); const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d); const g = (ty) => p.find((x) => x.type === ty).value; return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}` }
const localTimes = (h, tz) => { const u = (h.time?.[0] || '').endsWith('Z'); return (h.time || []).map((t) => (u ? toLocal(t, tz) : t.slice(0, 16))) }
const heightsFromHourly = (h) => { const hs = []; for (const k of Object.keys(h || {})) { const m = k.match(/^wind_speed_(\d+)m$/); if (m) hs.push(+m[1]) } return hs.sort((a, b) => a - b) }
function mastKn(hourly, heights, mastH, i, mosArr, mosZ = 30) {
  // MOS is bias-fitted at its venue reference height (mosZ, 30 m). Re-anchor it
  // to the mast height using THIS model's own shear — the ratio of the raw
  // interpolated speed at mastH vs at mosZ — so the MOS and raw-interpolated
  // paths both report at the same height. Ratio is unit-free (km/h ÷ km/h), so
  // the MOS knots are preserved. Single-level models return ratio 1 (no shear
  // to scale by), leaving MOS at its fit height.
  if (mosArr && mosArr[i] != null) {
    const mos = mosArr[i]
    if (mastH == null || mastH === mosZ) return mos
    const vMast = interpolateSpeedAtHeight(hourly, heights, mastH, i)
    const vFit = interpolateSpeedAtHeight(hourly, heights, mosZ, i)
    return (vMast != null && vFit != null && vFit > 0) ? mos * (vMast / vFit) : mos
  }
  const kmh = interpolateSpeedAtHeight(hourly, heights, mastH, i)
  return kmh != null ? kmh * KN : null
}
const dirAt = (m, i) => m.hourly.wind_direction_10m?.[i] ?? m.hourly[`wind_direction_${m.heights[0]}m`]?.[i]
const idxAtL = (m, dateStr, hh) => m.lt.findIndex((t) => t.startsWith(`${dateStr}T${pad2(hh)}:`))
const idxByKey = (m, key) => m.lt.findIndex((t) => t.slice(0, 13) === key)

// Ask the server-side Claude proxy for the executive brief. Returns the parsed
// brief, or { __error } describing why it failed (so the deck still builds with
// editable blanks AND the panel can show the real reason).
async function aiSummary(payload) {
  try {
    const res = await fetch('/api/ai/forecast-summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: payload }) })
    const j = await res.json().catch(() => null)
    if (!res.ok || (j && j.error)) return { __error: (j && j.error) || `HTTP ${res.status}` }
    return j || { __error: 'empty response' }
  } catch (e) { return { __error: e?.message || 'network error' } }
}

async function fetchModelDays(modelKey, lat, lon, tz, days) { const m = MODELS[modelKey]; if (!m || !m.endpoint) throw new Error(`${modelKey} no endpoint`); const params = []; for (const h of (m.heights || [10])) params.push(`wind_speed_${h}m`, `wind_direction_${h}m`); let url = `${m.endpoint}?latitude=${lat}&longitude=${lon}&hourly=${params.join(',')}&wind_speed_unit=kmh&timezone=${encodeURIComponent(tz)}&forecast_days=${days}`; if (m.modelParam) url += `&models=${m.modelParam}`; const res = await fetch(url); if (!res.ok) throw new Error(`${modelKey} ${res.status}`); return res.json() }

// ── today's detail rows (mast +MOS): numeric TWD range + weighted TWS band ───
function buildDaily(short, mastH, bandModels) {
  const lt = short.lt; if (!lt.length) return []
  const today = lt[0].slice(0, 10); const rows = []
  for (let i = 0; i < lt.length; i++) {
    if (lt[i].slice(0, 10) !== today) break
    const hh = parseInt(lt[i].slice(11, 13), 10); if (hh < 8 || hh > 18) continue
    const s = mastKn(short.hourly, short.heights, mastH, i, short.mos, short.mosZ); if (s == null) continue
    const tws = [{ v: s, w: WEIGHTS[short.key] || 1 }]; const dirs = []
    const d0 = dirAt(short, i); if (d0 != null) dirs.push(d0)
    for (const bm of bandModels) { const j = idxByKey(bm, lt[i].slice(0, 13)); if (j < 0) continue; const v = mastKn(bm.hourly, bm.heights, mastH, j, bm.mos, bm.mosZ); if (v != null) tws.push({ v, w: bm.weight }); const dd = dirAt(bm, j); if (dd != null) dirs.push(dd) }
    const band = weightedBand(tws) || [Math.max(0, Math.round(s) - 2), Math.round(s) + 2, s]
    // Headline TWS = the band CENTRE (weighted-model mean), clamped into [lo,hi],
    // so the printed value can never sit outside its own ±1σ range. (Previously
    // this printed the single primary model's value, which drifted above the band
    // whenever that model ran hotter than the ensemble.)
    const kn = Math.min(band[1], Math.max(band[0], Math.round(band[2] != null ? band[2] : s)))
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
      for (const m of models) { const i = idxAtL(m, d, hh); if (i < 0) continue; const s = mastKn(m.hourly, m.heights, mastH, i, m.mos, m.mosZ); if (s != null) tws.push({ v: s, w: m.weight }); const dd = dirAt(m, i); if (dd != null) dirs.push(dd) }
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
  const ser = (m, kind) => keys.map((key) => { const i = idxByKey(m, key); if (i < 0) return null; return kind === 'spd' ? mastKn(m.hourly, m.heights, mastH, i, m.mos, m.mosZ) : (dirAt(m, i) ?? null) })
  const spd = models.map((m) => ser(m, 'spd')); const dir = models.map((m) => ser(m, 'dir'))
  // Emphasise the primary models — SSA-Race 1 km + AROME — with bold lines, and
  // connect their TWD points (other models stay thin / markers-only).
  const EMPH = ['ICONRACE_1KM', 'AROME']
  const isEmph = (k) => EMPH.includes(k)
  const lines = (series, modeFn, widthFn) => models.map((m, k) => ({
    x: xs, y: series[k], name: MODELS[m.key]?.label || m.key, type: 'scatter',
    mode: typeof modeFn === 'function' ? modeFn(m.key) : modeFn,
    line: { color: MODELS[m.key]?.color, width: widthFn(m.key) },
    marker: { size: isEmph(m.key) ? 5 : 4, color: MODELS[m.key]?.color }, connectgaps: true,
  }))
  try { out.push(await plotPNG(div, [...bandTraces(xs, bandStats(spd)), ...lines(spd, 'lines+markers', (k) => (isEmph(k) ? 4 : 1.6))], { title: { text: `Wind speed @ ${mastH} m`, font: { size: 15, color: '1F4E79' } }, legend: { orientation: 'h', y: -0.2 }, xaxis: xax, yaxis: { title: 'knots', rangemode: 'tozero', gridcolor: '#e5e7eb' }, shapes: raceShapes(keys, [['x', 'y domain']]) })) } catch { out.push(null) }
  try { out.push(await plotPNG(div, [...bandTraces(xs, dirBand(dir)), ...lines(dir, (k) => (isEmph(k) ? 'lines+markers' : 'markers'), (k) => (isEmph(k) ? 3 : 1))], { title: { text: 'Wind direction (TWD)', font: { size: 15, color: '1F4E79' } }, legend: { orientation: 'h', y: -0.2 }, xaxis: xax, yaxis: { title: '°', range: [0, 360], dtick: 45, gridcolor: '#e5e7eb' }, shapes: raceShapes(keys, [['x', 'y domain']]) })) } catch { out.push(null) }
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

// ── WIND WEIGHT (rig load vs a standard day) ────────────────────────────────
// The box publishes icon-race/<domain>/<venue>/windweight.json: hourly
// { t (UTC), WW, V_eff, V_H, cls, factors, profile:[{z,V}] }. Same product the
// Stability tab's WindWeightPanel reads — the deck must not invent a second one.
const WW_HOURS = [10, 11, 12, 13, 14, 15, 16, 17]
function wwRowsFor(ww, tz, todayLocal) {
  const hrs = Array.isArray(ww?.hours) ? ww.hours : []
  const byHour = {}
  for (const h of hrs) {
    if (!h?.t) continue
    const lt = toLocal(String(h.t), tz)          // 'YYYY-MM-DDTHH:MM' venue-local
    if (lt.slice(0, 10) !== todayLocal) continue
    byHour[parseInt(lt.slice(11, 13), 10)] = h
  }
  return WW_HOURS.map((hr) => ({ hr, h: byHour[hr] || null })).filter((r) => r.h)
}
// The "standard day" the index is measured against: a neutral open-sea log
// profile anchored at the same masthead speed. Ported from WindWeightPanel so the
// deck's picture is the deck's picture, not a second interpretation.
function stdLogProfile(prof, H) {
  if (!Array.isArray(prof) || prof.length < 2) return null
  const z0 = 2e-4
  const top = prof.reduce((a, p) => (p.z > a.z ? p : a), prof[0])
  const zTop = Math.max(top.z, 1); const vTop = top.V
  if (!(vTop > 0)) return null
  const zs = [1, 3, 5, 8, 12, 18, 25, Math.min(zTop, H)]
  const uniq = [...new Set(zs.filter((z) => z >= 0.5 && z <= Math.min(zTop, H)))].sort((a, b) => a - b)
  return uniq.map((z) => ({ z, V: (vTop * Math.log(z / z0)) / Math.log(zTop / z0) }))
}
// V(z) over the rig for the mid-window hour: forecast vs the standard profile.
// The GAP between the two lines is the wind weight — that is the whole point of
// the picture, so both lines always plot together or not at all.
async function captureWindweightProfile(row, mastH) {
  if (!window.Plotly || !row?.h?.profile?.length) return null
  const prof = row.h.profile.filter((p) => p && p.z != null && p.V != null).sort((a, b) => a.z - b.z)
  if (prof.length < 2) return null
  const ref = stdLogProfile(prof, mastH)
  const div = offDiv()
  const data = []
  if (ref) data.push({ x: ref.map((p) => p.V), y: ref.map((p) => p.z), type: 'scatter', mode: 'lines', name: 'standard day', line: { color: '9AA5B1', width: 2, dash: 'dash' } })
  data.push({ x: prof.map((p) => p.V), y: prof.map((p) => p.z), type: 'scatter', mode: 'lines+markers', name: 'forecast', line: { color: '1F4E79', width: 2.5 }, marker: { size: 5 } })
  const layout = {
    title: { text: `Rig profile V(z) — ${pad2(row.hr)}:00`, font: { size: 15, color: '1F4E79' } },
    legend: { orientation: 'h', y: -0.16 },
    xaxis: { title: 'V (m/s)', rangemode: 'tozero', gridcolor: '#e5e7eb' },
    yaxis: { title: 'height (m)', range: [0, mastH], gridcolor: '#e5e7eb' },
    margin: { t: 40, b: 60, l: 56, r: 16 },
  }
  let png = null; try { png = await plotPNG(div, data, layout, 620, 620) } catch { png = null }
  try { window.Plotly.purge(div) } catch { /* */ } div.remove()
  return png
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
  // Fallback chain (point-1 only, since these come from point 1's fetched data):
  // SSA-Race 2 km → ECMWF → GFS (→ ICON last). ECMWF pressure levels come from the
  // 0.25° ecmwf_ifs025 fetch (ecmwfSounding) — the 9 km ecmwf_ifs surface model
  // has none.
  if (!h && isP1) {
    const hasT = (x) => x && (x.temperature_1000hPa || x.temperature_850hPa)
    const ecmwf = windData1?.ecmwfSounding?.hourly
    const gfs = windData1?.gfs?.hourly
    const icon = windData1?.surfaceByModel?.ICON?.hourly
    if (hasT(ecmwf)) { h = ecmwf; levels = ECMWF_SOUNDING_LEVELS; label = 'ECMWF'; ptop = 500 }
    else if (hasT(gfs)) { h = gfs; levels = GFS_SOUNDING_LEVELS; label = 'GFS'; ptop = 500 }
    else if (hasT(icon)) { h = icon; levels = ICON_SOUNDING_LEVELS; label = 'ICON'; ptop = 500 }
  }
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
      const s = mastKn(m.hourly, m.heights, mastH, j, m.mos, m.mosZ); if (s != null) ms.push(s)
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
// Body/table font sizes are bumped up from the original desk-projected deck: this
// is read as a PDF on a phone on the dock, where 11-12 pt was a squint. Only the
// slide TITLES (26/30/36) and their grey SUBTITLES stay put.
function spdCell(text) { const nums = (text.match(/\d+/g) || []).map(Number).filter((x) => x <= 60); if (!nums.length) return { text, options: { color: INK, fontFace: FONT, fontSize: 14, valign: 'middle', align: 'left' } }; const bf = beaufort(nums.reduce((a, b) => a + b, 0) / nums.length); return { text, options: { fill: { color: bf.hex }, color: bf.dark ? 'FFFFFF' : '0F1723', fontFace: FONT, fontSize: 14, valign: 'middle', align: 'left' } } }
const txtCell = (text, o = {}) => ({ text, options: { color: INK, fontFace: FONT, fontSize: 14, valign: 'middle', align: 'left', ...o } })
const hdrCell = (text) => ({ text, options: { fill: { color: HEADER }, color: INK, bold: true, fontFace: FONT, fontSize: 14, valign: 'middle' } })
// ── PAGE: 9:16 PORTRAIT, sized for a phone ───────────────────────────────────
// The deck is read on a phone on the dock, not projected in a room — so the page
// is the phone: 7.5 × 13.333 in (the old 16:9 slide, stood up). Everything is one
// column at full content width; nothing is side-by-side unless both halves still
// read at ~370 px wide. Body text stays at the old point sizes (the page is
// narrower, so text is effectively LARGER on screen); only the big titles shrink.
const PW = 7.5; const PH = 13.333
const M = 0.4                        // page margin
const CW = PW - 2 * M                // 6.7 in of content
const FOOT = PH - 0.42               // footnote baseline
function addTitle(s, title, sub) { s.addText(title, { x: M, y: 0.32, w: CW, h: 0.62, fontFace: FONT, fontSize: 26, bold: true, color: NAVY }); if (sub) s.addText(sub, { x: M + 0.02, y: 0.92, w: CW, h: 0.32, fontFace: FONT, fontSize: 11, color: GREY }) }
function ph(s, x, y, w, h, label) { s.addShape('roundRect', { x, y, w, h, fill: { color: LIGHTF }, line: { color: 'C2C9D4', width: 1 }, rectRadius: 0.1 }); s.addText(label, { x, y, w, h, align: 'center', valign: 'middle', fontFace: FONT, fontSize: 15, color: GREY }) }
const fit = (iw, ih, x, y, w, h) => { const r = Math.min(w / (iw || 1), h / (ih || 1)); const dw = (iw || 1) * r; const dh = (ih || 1) * r; return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh } }
// TWD cell = trailing text only (Beaufort fill kept). The wind arrow is NOT a
// glyph here — it's a single PNG overlaid on the cell and ROTATED continuously
// (constant size, any angle) by overlayWindArrows() after the table is laid out.
function arrowCell(twdMean, kn, trailing, fill, dark) {
  const color = fill ? (dark ? 'FFFFFF' : '0F1723') : INK
  return { text: trailing || '', options: { ...(fill ? { fill: { color: fill } } : {}), valign: 'middle', align: 'center', color, fontFace: FONT, fontSize: 14 } }
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

// ── Racecourse wind analysis ────────────────────────────────────────────────
// Bend + TWS gradient over a windward/leeward course of side 2·legNm (default
// 2 nm) centred on point 1, from the actual wind field. This is DETERMINISTIC —
// the AI can't see the spatial field, only summarised point data, so we compute
// it here and feed it to both the deck and the AI brief.
function offsetLL(lat, lon, nm, brgDeg) {
  const R = nm / 60
  const b = (brgDeg * Math.PI) / 180
  return [lat + R * Math.cos(b), lon + (R * Math.sin(b)) / Math.max(0.2, Math.cos((lat * Math.PI) / 180))]
}
// Average the field over a grid of points across a `sideNm`-square box (default
// 4 nm) centred on point 1, rotated into the wind axis (along = upwind, cross =
// right looking upwind). Gives robust TWS gradients (left/right, top/bottom) and
// a vector-averaged TWD bend from many gridpoints rather than 4 single samples.
function analyseCourse(field, lat, lon, frameIdx, sideNm = 4) {
  if (!field) return null
  const c0 = sampleField(field, frameIdx, lat, lon)
  if (!c0 || c0.kt == null || c0.dirTrue == null) return null
  const twd = c0.dirTrue
  const tr = (twd * Math.PI) / 180; const D2R = Math.PI / 180
  const cosLat = Math.max(0.2, Math.cos(lat * D2R))
  const half = sideNm / 2; const n = 4; const step = half / n   // 9×9 grid
  let L = 0, Lk = 0, R = 0, Rk = 0, T = 0, Tk = 0, B = 0, Bk = 0
  let Tu = 0, Tv = 0, Tn = 0, Bu = 0, Bv = 0, Bn = 0
  for (let ia = -n; ia <= n; ia++) for (let ic = -n; ic <= n; ic++) {
    const a = ia * step, cc = ic * step          // along (upwind+) / cross (right+) nm
    const dlat = (a * Math.cos(tr) - cc * Math.sin(tr)) / 60
    const dlon = (a * Math.sin(tr) + cc * Math.cos(tr)) / (60 * cosLat)
    const s = sampleField(field, frameIdx, lat + dlat, lon + dlon)
    if (!s || s.kt == null) continue
    if (cc > 0) { R += s.kt; Rk++ }
    else if (cc < 0) { L += s.kt; Lk++ }
    if (a > 0) { T += s.kt; Tk++; if (s.dirTrue != null) { Tu += Math.sin(s.dirTrue * D2R); Tv += Math.cos(s.dirTrue * D2R); Tn++ } }
    else if (a < 0) { B += s.kt; Bk++; if (s.dirTrue != null) { Bu += Math.sin(s.dirTrue * D2R); Bv += Math.cos(s.dirTrue * D2R); Bn++ } }
  }
  const r1 = (x) => Math.round(x * 10) / 10
  const out = { twd: Math.round(twd), centreKt: r1(c0.kt), sideNm }
  if (Rk && Lk) out.twsLeftRight = r1(R / Rk - L / Lk)   // + = more wind right
  if (Tk && Bk) out.twsTopBottom = r1(T / Tk - B / Bk)   // + = more wind windward (top)
  // Wind bend looking upwind: compare mean TWD at the TOP (windward) vs BOTTOM
  // (leeward) of the course. TWD veering up the beat (e.g. 180→220) = right bend;
  // backing up the beat (e.g. 090→060) = left bend.
  if (Tn && Bn) {
    const td = (Math.atan2(Tu / Tn, Tv / Tn) * 180 / Math.PI + 360) % 360 // mean TWD top
    const bdir = (Math.atan2(Bu / Bn, Bv / Bn) * 180 / Math.PI + 360) % 360 // mean TWD bottom
    const bd = Math.round((((td - bdir + 540) % 360) - 180))   // + = veers up the course = right
    out.bendDeg = bd
    out.bend = bd > 4 ? 'right' : bd < -4 ? 'left' : 'straight'
  }
  return out
}
// Human text for the TWS gradient across the course.
function gradientText(course) {
  if (!course) return null
  const parts = []
  if (course.twsLeftRight != null && Math.abs(course.twsLeftRight) >= 0.5) parts.push(`+${Math.abs(course.twsLeftRight)} kt ${course.twsLeftRight > 0 ? 'right' : 'left'}`)
  if (course.twsTopBottom != null && Math.abs(course.twsTopBottom) >= 0.5) parts.push(`+${Math.abs(course.twsTopBottom)} kt ${course.twsTopBottom > 0 ? 'top' : 'bottom'}`)
  return parts.length ? parts.join(' · ') : 'even across course'
}

// Split prose into sentence-ish paragraphs (rough: break after . ! ? before a capital/digit).
function toSentences(text) {
  if (!text) return []
  return String(text).split(/(?<=[.!?])\s+(?=[A-Z0-9“"])/).map((s) => s.trim()).filter(Boolean)
}
// pptxgenjs runs: one paragraph per item, with inter-paragraph spacing.
function paraRuns(items, { color, size = 13, spaceAfter = 12 } = {}) {
  const arr = (items || []).filter(Boolean)
  return arr.map((t) => ({ text: t, options: { breakLine: true, paraSpaceAfter: spaceAfter, color, fontFace: FONT, fontSize: size } }))
}
// Accept either an AI array field or a legacy string (split to sentences).
function asItems(val) {
  if (Array.isArray(val)) return val.filter(Boolean)
  if (typeof val === 'string' && val.trim()) return toSentences(val)
  return []
}
// pptxgenjs runs: short bullet list. `spacer` (pt) inserts a real EMPTY paragraph
// between bullets — survives the Keynote import (paraSpaceAfter often doesn't).
function bulletRuns(items, { color, size = 13, spaceAfter = 7, spacer = 0 } = {}) {
  const arr = (items || []).filter(Boolean)
  const out = []
  arr.forEach((t, i) => {
    out.push({ text: t, options: { bullet: { indent: 16 }, breakLine: true, paraSpaceAfter: spaceAfter, color, fontFace: FONT, fontSize: size } })
    if (spacer && i < arr.length - 1) out.push({ text: ' ', options: { breakLine: true, fontSize: spacer } })
  })
  return out
}

function buildDeck(P, d) {
  const pptx = new P(); pptx.defineLayout({ name: 'PHONE', width: PW, height: PH }); pptx.layout = 'PHONE'
  const dg = d.diag
  const rws = d.dailyRows || []
  // Headline numbers are for the RACING window only (10:00–16:00) — early-morning
  // light/variable air is not relevant to the start.
  const race = rws.filter((r) => r.time >= '10:00' && r.time <= '16:00')
  const stat = race.length ? race : rws
  const los = stat.map((r) => r.lo).filter((x) => x != null)
  const his = stat.map((r) => r.hi).filter((x) => x != null)
  const twsMin = los.length ? Math.min(...los) : null
  const twsMax = his.length ? Math.max(...his) : null
  const tm0 = stat.find((r) => r.twdMean != null)?.twdMean
  const tm1 = [...stat].reverse().find((r) => r.twdMean != null)?.twdMean
  const netd = (tm0 != null && tm1 != null) ? ((((tm1 - tm0) % 360) + 540) % 360) - 180 : null
  const midRow = stat.find((r) => r.time === '13:00') || stat.find((r) => r.time === '12:00') || stat[Math.floor(stat.length / 2)] || null
  // Team-comms classifications (AI first, deterministic fallback from diagnostics).
  const gate = dg?.stability?.gate; const hMix = dg?.stability?.hMixM
  const windTrend = d.ai?.windTrend || (netd != null ? (netd > 8 ? 'right' : netd < -8 ? 'left' : 'steady') : null)
  // Bend is computed from the field over the course (preferred); AI is fallback.
  const courseBend = d.course?.bend
    ? (d.course.bend === 'straight' ? 'straight' : `${d.course.bend}${d.course.bendDeg != null ? ` ${Math.abs(d.course.bendDeg)}°` : ''}`)
    : null
  const windBend = courseBend || d.ai?.windBend || null
  const twsGrad = gradientText(d.course)
  const mixing = d.ai?.mixing || (gate != null ? (gate >= 0.66 ? 'well mixed' : gate >= 0.33 ? 'moderate' : 'poor')
    : (hMix != null ? (hMix > 800 ? 'well mixed' : hMix > 400 ? 'moderate' : 'poor') : null))
  const dayType = d.ai?.dayType || (d.typeOfDay
    ? (/funnel/i.test(d.typeOfDay) ? 'funnelled' : /cloud/i.test(d.typeOfDay) ? 'cloud-dominated'
      : /sea.?breeze/i.test(d.typeOfDay) ? 'oscillating' : 'irregular') : null)

  // ── 1) TITLE (dark navy, per template) ──────────────────────────────────────
  let s = pptx.addSlide(); s.background = { color: '003462' }
  s.addText(`Weather & strategy brief - ${d.day}`, { x: M + 0.15, y: 3.4, w: CW - 0.3, h: 3.0, fontFace: FONT, fontSize: 36, bold: true, color: 'FFFFFF', valign: 'top' })
  s.addText(`${d.boatName || '<Boatname>'}   ${d.eventName || '<Event>'}   ${d.year}`, { x: M + 0.15, y: 6.6, w: CW - 0.3, h: 0.8, fontFace: FONT, fontSize: 18, bold: true, color: '8FB8E6' })
  s.addText(`Wouter · ${d.day}`, { x: M + 0.15, y: 12.3, w: CW - 0.3, h: 0.35, fontFace: FONT, fontSize: 11, color: 'AFC4DE' })

  // ── 2) Weather and strategy brief (executive) ───────────────────────────────
  s = pptx.addSlide()
  s.addText('Summary', { x: M, y: 0.35, w: CW, h: 0.7, fontFace: FONT, fontSize: 30, bold: true, color: NAVY })
  // Wind-summary card — full width across the top (portrait has no "right rail").
  s.addShape('roundRect', { x: M, y: 1.2, w: CW, h: 1.55, fill: { color: LIGHTF }, line: { color: 'C2C9D4', width: 1 }, rectRadius: 0.06 })
  s.addText('Wind summary', { x: M + 0.16, y: 1.3, w: CW - 0.32, h: 0.28, fontFace: FONT, fontSize: 14, bold: true, color: NAVY })
  const kv = (k, v, brk) => ([{ text: `${k} `, options: { color: GREY, fontFace: FONT, fontSize: 13 } }, { text: v, options: { color: NAVY, bold: true, fontFace: FONT, fontSize: 14 } }, { text: brk ? '' : '     ', options: brk ? { breakLine: true } : {} }])
  const kn = []
  if (midRow?.kn != null) kn.push(...kv('TWS avg', `${midRow.kn} kn`))
  if (twsMin != null) kn.push(...kv('range', `${twsMin}–${twsMax} kn`))
  if (twsMax != null) kn.push(...kv('peak', `${twsMax} kn`, true))
  if (midRow?.twdMean != null) kn.push(...kv('TWD avg', `${round5(midRow.twdMean)}°`))
  if (midRow?.twd) kn.push(...kv('range', `${midRow.twd}`, true))
  if (kn.length) s.addText(kn, { x: M + 0.16, y: 1.62, w: CW - 0.32, h: 0.72, fontFace: FONT, valign: 'top', paraSpaceAfter: 5 })
  const kv2 = (k, v) => ([{ text: `${k}: `, options: { color: GREY, fontFace: FONT, fontSize: 12.5 } }, { text: String(v), options: { color: NAVY, bold: true, fontFace: FONT, fontSize: 12.5 } }, { text: '   ', options: {} }])
  const box4 = []
  if (windBend) box4.push(...kv2('bend', windBend))
  if (windTrend) box4.push(...kv2('trend', windTrend))
  if (mixing) box4.push(...kv2('mixing', mixing))
  if (dayType) box4.push(...kv2('type', dayType))
  if (box4.length) s.addText(box4, { x: M + 0.16, y: 2.35, w: CW - 0.32, h: 0.34, fontFace: FONT, valign: 'top' })
  // Type-of-day header line, then the bulleted summary (real empty line between each).
  const summaryItems = [
    ['Situation', d.ai?.situation], ["Today's wind", d.ai?.todaysWind], ['Strategy', d.ai?.strategyNote],
    ['Stability', d.ai?.stability], ['Outlook', d.ai?.outlook], ['Confidence', d.ai?.confidenceNote],
  ].filter(([, v]) => v)
  const sumRuns = []
  if (d.typeOfDay) {
    sumRuns.push({ text: 'Type of day:  ', options: { bold: true, color: NAVY, fontFace: FONT, fontSize: 18 } })
    sumRuns.push({ text: d.typeOfDay, options: { breakLine: true, bold: true, color: INK, fontFace: FONT, fontSize: 18 } })
    sumRuns.push({ text: ' ', options: { breakLine: true, fontSize: 13 } })
  }
  summaryItems.forEach(([label, txt], i) => {
    sumRuns.push({ text: `${label}: `, options: { bullet: { indent: 18 }, bold: true, color: NAVY, fontFace: FONT, fontSize: 15 } })
    sumRuns.push({ text: txt, options: { breakLine: true, color: INK, fontFace: FONT, fontSize: 15 } })
    if (i < summaryItems.length - 1) sumRuns.push({ text: ' ', options: { breakLine: true, fontSize: 12 } })
  })
  if (sumRuns.length) s.addText(sumRuns, { x: M, y: 3.05, w: CW, h: 9.7, fontFace: FONT, valign: 'top' })
  else s.addText('AI summary unavailable — generate with the key set, or edit these lines directly.', { x: M, y: 3.05, w: CW, h: 0.4, fontFace: FONT, fontSize: 14, color: GREY })

  // ── 3) General weather (bullets above, hero 3D field below) ──────────────────
  s = pptx.addSlide(); addTitle(s, 'General weather', d.subtitle)
  const gwItems = [d.ai?.situation, ...asItems(d.ai?.generalWeather)].filter(Boolean)
  s.addText(gwItems.length ? bulletRuns(gwItems, { color: INK, size: 16, spaceAfter: 9 })
    : d.generalBullets.map((t) => ({ text: t, options: { bullet: { indent: 16 }, breakLine: true, paraSpaceAfter: 9, color: INK, fontFace: FONT, fontSize: 16 } })),
    { x: M, y: 1.45, w: CW, h: 5.0, fontFace: FONT, valign: 'top' })
  const hero = d.heroView || (d.views3d || []).find((v) => v.label === '12:00') || (d.views3d || [])[0] || null
  const heroY = 6.7, heroH = 4.4
  if (hero) {
    s.addImage({ data: hero.png, ...fit(900, 540, M, heroY, CW, heroH) })
    s.addText(`3D wind field — ${hero.model}${hero.height ? ` · ${hero.height} m` : ''} · ${hero.label} local · 20 nm view · 10 nm ring`, { x: M, y: heroY + heroH + 0.05, w: CW, h: 0.3, align: 'center', fontFace: FONT, fontSize: 12, color: GREY })
  } else if (d.windfieldImg) {
    s.addImage({ data: d.windfieldImg.data, ...fit(d.windfieldImg.w, d.windfieldImg.h, M, heroY, CW, heroH) })
    s.addText('Wind field — 12:00 local · 5 nm racing area', { x: M, y: heroY + heroH + 0.05, w: CW, h: 0.3, align: 'center', fontFace: FONT, fontSize: 12, color: GREY })
  } else ph(s, M, heroY, CW, heroH, '3D wind field — 12:00\n(capture unavailable)')

  // ── 4) Outlook (table, then long-range chart, then the AI day bullets) ───────
  s = pptx.addSlide(); addTitle(s, 'Outlook')
  const oDays = d.outlookRows
  const oX = M, oY = 1.35, oW = CW, oFirstW = 1.3, oRowH = 0.5
  const oDayW = (oW - oFirstW) / Math.max(1, oDays.length)
  const oPeriods = [['Morning', 'mor'], ['Midday', 'mid'], ['Afternoon', 'aft']]
  const oHead = [hdrCell(''), ...oDays.map((r) => hdrCell(r.day.slice(0, 3)))]
  const oRows = oPeriods.map(([label, key]) => [txtCell(label, { bold: true, fill: { color: LIGHTF } }), ...oDays.map((r) => oCell(r[key]))])
  s.addTable([oHead, ...oRows], { x: oX, y: oY, w: oW, colW: [oFirstW, ...oDays.map(() => oDayW)], rowH: oRowH, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, valign: 'middle' })
  overlayWindArrows(s, oPeriods.map(([, key]) => ({ key })), {
    y: oY, rowH: oRowH, size: 0.18,
    cols: oDays.map((r, j) => ({ cx: oX + oFirstW + j * oDayW + 0.2, twdOf: (p) => r[p.key]?.twdMean ?? null })),
  })
  const lrY = oY + oRowH * 4 + 0.25
  if (d.longRange) s.addImage({ data: d.longRange, ...fit(1400, 520, M, lrY, CW, 2.6) }); else ph(s, M, lrY, CW, 2.6, '4-day TWS & TWD (±1σ)')
  const outlookItems = asItems(d.ai?.outlookDays).length ? asItems(d.ai.outlookDays) : asItems(d.ai?.outlook)
  if (outlookItems.length) s.addText(bulletRuns(outlookItems, { color: INK, size: 15, spaceAfter: 12 }), { x: M, y: lrY + 2.8, w: CW, h: 6.2, fontFace: FONT, valign: 'top' })
  s.addText('AM/Mid/PM = 10:00/12:00/15:00 local · TWD & TWS ranges = weighted-model mean ±1σ (all models day 1-2, ARPEGE+ECMWF beyond)', { x: M, y: FOOT, w: CW, h: 0.35, fontFace: FONT, fontSize: 11, color: GREY })

  // ── 5) Details for today (table full width, bullets under) ───────────────────
  s = pptx.addSlide(); addTitle(s, 'Details for today')
  const dHead = [hdrCell('Time'), hdrCell('TWD'), hdrCell('TWS'), hdrCell('TWD ±1σ'), hdrCell('TWS ±1σ'), hdrCell('Trend')]
  const dRows = d.dailyRows.map((r) => [txtCell(r.time, { bold: true, fill: { color: LIGHTF } }), twdCell(r.twdMean), spdCell(r.tws), txtCell(r.twd), spdCell(`${r.lo}-${r.hi}kn`), txtCell(r.trend)])
  // Trend column stays wide enough that "Right · increasing" is ONE line — equal
  // row heights are what keeps the overlaid TWD arrows aligned with their rows.
  const dX = M, dY = 1.35, dColW = [0.66, 0.85, 0.72, 0.95, 1.12, 2.4], dRowH = 0.46
  s.addTable([dHead, ...dRows], { x: dX, y: dY, w: dColW.reduce((a, b) => a + b, 0), colW: dColW, rowH: dRowH, autoPage: false, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, valign: 'middle' })
  overlayWindArrows(s, d.dailyRows, { y: dY, rowH: dRowH, size: 0.2, cols: [{ cx: dX + dColW[0] + 0.21, twdOf: (r) => r.twdMean ?? null }] })
  const detY = dY + dRowH * (d.dailyRows.length + 1) + 0.3
  const detItems = asItems(d.ai?.todaysWind)
  s.addText(detItems.length
    ? bulletRuns(detItems, { color: INK, size: 16, spaceAfter: 8 })
    : d.dailyBullets.map((t) => ({ text: t, options: { bullet: { indent: 16 }, breakLine: true, paraSpaceAfter: 8, color: INK, fontFace: FONT, fontSize: 16 } })),
    { x: M, y: detY, w: CW, h: Math.max(1.2, FOOT - detY - 0.2), fontFace: FONT, valign: 'top' })
  s.addText(`TWS at mast height (${d.mastH} m), MOS where available · Model: ${d.shortModelLabel} · ranges = weighted-model mean ±1σ`, { x: M, y: FOOT, w: CW, h: 0.35, fontFace: FONT, fontSize: 11, color: GREY })

  // ── 6) Model guidance — 4× 3D snapshots (30 m wind), one column ──────────────
  if (d.views3d && d.views3d.length) {
    s = pptx.addSlide(); addTitle(s, 'Model guidance')
    // Single column: on a phone a 2×2 grid of wind fields is unreadable. Four
    // stacked snapshots at ~4.2 in wide each still fit the page.
    // 3.7 in wide is the largest that fits four of them plus captions on the page:
    // 1.35 + 4×(2.24 + 0.5) = 12.3, inside the 13.33 page. Don't grow it.
    const iW = 3.7, iH = iW * (460 / 760), iX = (PW - iW) / 2
    d.views3d.slice(0, 4).forEach((v, i) => {
      const cy = 1.35 + i * (iH + 0.5)
      s.addImage({ data: v.png, ...fit(760, 460, iX, cy, iW, iH) })
      s.addText(`${v.label} local`, { x: iX, y: cy + iH + 0.02, w: iW, h: 0.26, align: 'center', fontFace: FONT, fontSize: 14, bold: true, color: NAVY })
    })
    const h3d = d.views3d[0].height
    s.addText(`3D wind field — ${d.views3d[0].model}${h3d ? ` · ${h3d} m wind` : ''} · oriented upwind · 5 nm racing area`, { x: M, y: FOOT, w: CW, h: 0.24, align: 'center', fontFace: FONT, fontSize: 11, color: GREY })
  }

  // ── 7) Model comparison (charts stacked) ─────────────────────────────────────
  s = pptx.addSlide(); addTitle(s, 'Model comparison — TWS & TWD (±1σ)')
  if (d.cmpSpeed) s.addImage({ data: d.cmpSpeed, ...fit(1000, 600, M, 1.35, CW, 5.4) }); else ph(s, M, 1.35, CW, 5.4, 'Wind-speed comparison')
  if (d.cmpDir) s.addImage({ data: d.cmpDir, ...fit(1000, 600, M, 7.0, CW, 5.4) }); else ph(s, M, 7.0, CW, 5.4, 'Wind-direction (TWD) comparison')

  // ── 8) Strategic considerations — AFTER the model evidence, not before it ────
  // (Moved here on purpose: you read the models, then the call that follows from
  // them. It's also the page you want to land on last before the boat leaves.)
  s = pptx.addSlide(); addTitle(s, 'Strategic considerations')
  const stratHdr = []
  const sh = (k, v) => { if (!v) return; stratHdr.push({ text: `${k}  `, options: { color: GREY, fontFace: FONT, fontSize: 14 } }, { text: String(v), options: { color: NAVY, bold: true, fontFace: FONT, fontSize: 14 } }, { text: '      ', options: {} }) }
  sh('TWD trend', windTrend); sh('TWD bend', windBend); sh('Type', dayType); sh('Mixing', mixing); sh('TWS grad', twsGrad)
  if (stratHdr.length) {
    s.addShape('roundRect', { x: M, y: 1.15, w: CW, h: 0.95, fill: { color: LIGHTF }, line: { color: 'C2C9D4', width: 1 }, rectRadius: 0.06 })
    s.addText(stratHdr, { x: M + 0.15, y: 1.22, w: CW - 0.3, h: 0.8, fontFace: FONT, valign: 'middle', fontSize: 14 })
  }
  const hasCourseTbl = d.courseSeries && d.courseSeries.length
  const stratItems = asItems(d.ai?.strategy)
  s.addText(stratItems.length
    ? bulletRuns(stratItems, { color: INK, size: 16, spaceAfter: 6, spacer: 10 })
    : [{ text: 'Tactical considerations — edit. (AI strategy unavailable.)', options: { color: GREY, fontFace: FONT, fontSize: 16 } }],
    { x: M, y: 2.3, w: CW, h: hasCourseTbl ? 5.0 : 10.4, fontFace: FONT, valign: 'top' })
  if (hasCourseTbl) {
    const fmtg = (v, pos, neg) => (v == null ? '—' : Math.abs(v) < 0.3 ? '~0' : `${v > 0 ? '+' : '−'}${Math.abs(v)} ${v > 0 ? pos : neg}`)
    const cHead = [hdrCell('Time'), hdrCell('TWD'), hdrCell('Bend'), hdrCell('TWS L/R'), hdrCell('TWS ↑/↓')]
    const cRows = d.courseSeries.map((c) => [
      txtCell(`${c.hh}:00`, { bold: true, fill: { color: LIGHTF } }),
      txtCell(`${c.twd}°`),
      txtCell(c.bend == null || c.bend === 'straight' ? '—' : `${c.bend === 'right' ? 'R' : 'L'} ${Math.abs(c.bendDeg)}°`),
      txtCell(fmtg(c.twsLeftRight, 'R', 'L')),
      txtCell(fmtg(c.twsTopBottom, 'top', 'bot')),
    ])
    const cY = 7.85
    s.addText('Course gradient — hourly (4 nm box, point 1)', { x: M, y: cY - 0.35, w: CW, h: 0.3, fontFace: FONT, fontSize: 14, bold: true, color: NAVY })
    s.addTable([cHead, ...cRows], { x: M, y: cY, w: CW, colW: [1.1, 1.1, 1.4, 1.55, 1.55], rowH: 0.42, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, valign: 'middle', fontFace: FONT, fontSize: 13, color: INK })
    s.addText('Bend looking upwind (R/L); TWS grad: + = right / windward', { x: M, y: FOOT, w: CW, h: 0.3, fontFace: FONT, fontSize: 11, color: GREY })
  }

  // ── 9) Stability + WIND WEIGHT ───────────────────────────────────────────────
  s = pptx.addSlide(); addTitle(s, 'Stability & wind weight')
  if (dg) {
    const st = dg.stability || {}; const sbb = dg.seaBreeze || {}
    const cap = st.hasLowCap ? `low cap +${st.capStrengthC}°C @ ${st.capBaseM} m` : (st.capBaseM != null ? `cap aloft @ ${st.capBaseM} m` : 'no cap')
    const line = `${cap} · lapse ${st.lapseRateCkm ?? '—'} °C/km · h_mix ${st.hMixM ?? '—'} m · gate ${st.gate ?? '—'}\n`
      + `Sea-breeze ${sbb.score ?? '—'}/10${sbb.quadrant ? ` (${sbb.quadrant})` : ''}: SBI ${sbb.sbi ?? '—'}, cross-shore ${sbb.crossShoreKt ?? '—'} kt, bend ${sbb.thermalBendDeg ?? '—'}°${sbb.deltaT != null ? `, ΔT ${sbb.deltaT} °C` : ''}`
    s.addText(line, { x: M, y: 0.98, w: CW, h: 0.5, fontFace: FONT, fontSize: 12, color: NAVY })
  }
  const stabItems = asItems(d.ai?.stabilityNotes).length ? asItems(d.ai.stabilityNotes) : asItems(d.ai?.stability)
  if (stabItems.length) s.addText(bulletRuns(stabItems, { color: INK, size: 14, spaceAfter: 4 }), { x: M, y: 1.55, w: CW, h: 1.5, fontFace: FONT, valign: 'top' })
  const stY = stabItems.length ? 3.15 : 1.7
  // hpbl (left) + sounding (right) — both still ~3.2 in wide, legible on a phone.
  const halfW = (CW - 0.25) / 2
  if (d.hpblImg) s.addImage({ data: d.hpblImg, ...fit(1000, 560, M, stY, halfW, 2.2) }); else ph(s, M, stY, halfW, 2.2, 'Boundary-layer height\n(no hpbl data)')
  if (d.soundingImg) s.addImage({ data: d.soundingImg, ...fit(820, 900, M + halfW + 0.25, stY - 0.35, halfW, 3.4) }); else ph(s, M + halfW + 0.25, stY - 0.35, halfW, 3.4, 'Sounding @ 13:00\n(no sounding data)')

  // Wind weight — the rig-integrated load vs a standard day. Table (racing window)
  // + the V(z) profile that produced it, so the number is never a bare number.
  const wwY = stY + 3.4
  s.addText('Wind weight — rig load vs a standard day (100 = standard)', { x: M, y: wwY, w: CW, h: 0.3, fontFace: FONT, fontSize: 15, bold: true, color: NAVY })
  const wwRows = d.wwRows || []
  const wwTblY = wwY + 0.38
  if (wwRows.length) {
    const wHead = [hdrCell('Time'), hdrCell('WW'), hdrCell('V_eff'), hdrCell('Class')]
    const wRows = wwRows.map((r) => {
      const calm = r.h.cls === 'Calm'
      return [
        txtCell(`${pad2(r.hr)}:00`, { bold: true, fill: { color: LIGHTF } }),
        txtCell(calm ? '—' : `${r.h.WW}%`, { bold: true }),
        spdCell(`${Math.round(r.h.V_eff)}kn`),
        txtCell(r.h.cls || '—'),
      ]
    })
    s.addTable([wHead, ...wRows], { x: M, y: wwTblY, w: 3.3, colW: [0.85, 0.8, 0.85, 0.8], rowH: 0.4, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, valign: 'middle' })
  } else {
    ph(s, M, wwTblY, 3.3, 3.24, 'Wind weight\n(no windweight.json\nfor this venue yet)')
  }
  if (d.wwProfileImg) s.addImage({ data: d.wwProfileImg, ...fit(620, 620, M + 3.45, wwTblY, CW - 3.45, 3.24) })
  else ph(s, M + 3.45, wwTblY, CW - 3.45, 3.24, 'Rig profile V(z)\n(no profile)')
  s.addText(`hpbl: point 1, racing window shaded · sounding 13:00 local · wind weight: masthead ${d.mastH} m, dashed line = standard log profile`, { x: M, y: FOOT, w: CW, h: 0.3, fontFace: FONT, fontSize: 11, color: GREY })

  // ── 10) Confidence & side notes ──────────────────────────────────────────────
  s = pptx.addSlide(); addTitle(s, 'Confidence & side notes')
  const chips = diagChips(dg)
  if (chips.length) s.addText(chips.join('  ·  '), { x: M, y: 1.05, w: CW, h: 0.5, fontFace: FONT, fontSize: 13, bold: true, color: NAVY })
  s.addText('Confidence', { x: M, y: 1.75, w: CW, h: 0.32, fontFace: FONT, fontSize: 16, bold: true, color: NAVY })
  s.addText(bulletRuns([d.ai?.confidenceNote, ...asItems(d.ai?.modelComparison)].filter(Boolean), { color: INK, size: 15, spaceAfter: 7 }),
    { x: M, y: 2.15, w: CW, h: 4.6, fontFace: FONT, valign: 'top' })
  s.addText('Notes', { x: M, y: 7.0, w: CW, h: 0.32, fontFace: FONT, fontSize: 16, bold: true, color: NAVY })
  const noteItems = asItems(d.ai?.notes).length ? asItems(d.ai.notes) : asItems(d.ai?.sideNotes)
  s.addText(noteItems.length
    ? bulletRuns(noteItems, { color: INK, size: 15, spaceAfter: 7 })
    : [{ text: 'Local effects / hazards — edit. (AI notes unavailable.)', options: { color: GREY, fontFace: FONT, fontSize: 15 } }],
    { x: M, y: 7.4, w: CW, h: 5.0, fontFace: FONT, valign: 'top' })
  return pptx
}

// ── component ───────────────────────────────────────────────────────────────
// Compose the Summary-slide text as plain, editable notes for the campaign day's
// Weather -> Notes. Mirrors the Summary slide's fields; returns null if empty.
function summaryNotesBlock(typeOfDay, ai, dayLabel) {
  const lines = []
  if (typeOfDay) lines.push(`Type of day: ${typeOfDay}`)
  const items = [
    ['Situation', ai?.situation], ["Today's wind", ai?.todaysWind], ['Strategy', ai?.strategyNote],
    ['Stability', ai?.stability], ['Outlook', ai?.outlook], ['Confidence', ai?.confidenceNote],
  ]
  for (const [k, v] of items) if (v) lines.push(`${k}: ${v}`)
  if (!lines.length) return null
  return `Forecast summary${dayLabel ? ` \u2014 ${dayLabel}` : ''}\n${lines.join('\n')}`
}

export default function ForecastDeck({ p1lat, p1lon, windData, mastHeight = 20, resolvedTz = 'UTC', raceDay = null, boatName = null, eventName = null, teamId = null, boatId = null, targetDate = null }) {
  const campaignRaceDay = raceDay
  const pptxReady = useScriptsOnce([PPTX_JS]); useScriptsOnce([PLOTLY_JS]); useScriptsOnce([MAPLIBRE_JS, DECK_JS], [MAPLIBRE_CSS])
  const point1 = windData?.['1']; const haveP1 = p1lat != null && p1lon != null && !!point1
  const shortModels = useMemo(() => { const sb = point1?.surfaceByModel || {}; return Object.keys(MODELS).filter((k) => sb[k] && hasValidSpeed(sb[k].hourly)) }, [point1])
  // Default outlook model: ARPEGE (falls back to ECMWF at generate time if its
  // extended data isn't available). Default short-term model preference:
  // SSA-Race 1 km → SSA-Race 2 km → AROME → ECMWF.
  const SHORT_PREF = ['ICONRACE_1KM', 'ICONRACE', 'AROME', 'ECMWF']
  const [outlookModel, setOutlookModel] = useState('ARPEGE'); const [shortModel, setShortModel] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(''); const [aiErr, setAiErr] = useState('')
  const shortSel = shortModel && shortModels.includes(shortModel) ? shortModel : (SHORT_PREF.find((k) => shortModels.includes(k)) || shortModels[0] || '')

  async function generate() {
    setErr(''); setBusy(true)
    try {
      const P = window.PptxGenJS; if (!P) throw new Error('engine loading — retry shortly')
      const venueName = (matchVenue(p1lat, p1lon) || 'venue').replace(/_/g, ' '); const tz = resolvedTz || 'UTC'
      const venueKey = matchVenue(p1lat, p1lon); const spec = venueKey ? specFor(venueKey) : null
      const mosFor = (key, hourly) => { const id = MODELS[key]?.mosModel; return spec && id ? mosSeries(hourly, MODELS[key]?.heights || [10], spec, id, tz) : null }
      const mosZ = spec?.target_height_m || 30
      const mk = (k, hourly, heights) => ({ key: k, hourly, lt: localTimes(hourly, tz), heights: heights || MODELS[k]?.heights || [10], mos: mosFor(k, hourly), mosZ, weight: WEIGHTS[k] || 0.5 })
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

      // Wind weight (box product). Time-bounded and entirely optional: venues
      // without a published windweight.json just get placeholders on the slide.
      let wwRows = []; let wwProfileImg = null
      try {
        const todayLocal = short.lt[0]?.slice(0, 10)
        const r = await withTimeout(fetchWindweightNearest(p1lat, p1lon), 8000, null)
        if (r?.data && todayLocal) {
          wwRows = wwRowsFor(r.data, tz, todayLocal)
          const mid = wwRows.find((x) => x.hr === 13) || wwRows[Math.floor(wwRows.length / 2)] || null
          if (mid) wwProfileImg = await captureWindweightProfile(mid, mastHeight)
        }
      } catch { /* */ }
      let field = null
      try {
        field = shortSel.startsWith('ICONRACE')
          ? await fetchIconRaceField({ lat: p1lat, lon: p1lon, height: mastHeight, timezone: tz, modelKey: shortSel })
          : (MODELS[shortSel]?.endpoint ? await fetchWindField({ modelKey: shortSel, lat: p1lat, lon: p1lon, height: mastHeight, timezone: tz }) : null)
        if (field) windfieldImg = await windfieldCoast(field, p1lat, p1lon)
      } catch { /* */ }

      // Racecourse bend + TWS gradient over a 4 nm W/L course centred on point 1,
      // HOURLY across the racing window (the field is already in memory, so this
      // is ~free). `course` = the mid-window (13:00) snapshot for the box.
      let course = null; let courseSeries = []
      try {
        const fst = field?.stamps || []
        for (const H of [10, 11, 12, 13, 14, 15, 16]) {
          const fi = fst.findIndex((x) => x && x.hh === H)
          if (fi < 0) continue
          const ca = analyseCourse(field, p1lat, p1lon, fi, 4)
          if (ca) courseSeries.push({ hh: H, ...ca })
        }
        course = courseSeries.find((c) => c.hh === 13) || courseSeries.find((c) => c.hh === 12) || courseSeries[Math.floor(courseSeries.length / 2)] || null
      } catch { /* */ }

      // ── 4× 3D snapshots (SSA-Race 1 km if available, else AROME) @ 10/12/14/16 ──
      // for the General weather slide. Captured at 30 m wind. Time-bounded; falls
      // back to the 2D windfield.
      const VIEW3D_HEIGHT_M = 30
      let views3d = []        // Model guidance: 4× 5 nm snapshots (2 nm ring)
      let heroView = null     // General weather: 1× zoomed-out 20 nm overview (10 nm ring)
      try {
        const m3dKey = (sb.ICONRACE_1KM && hasValidSpeed(sb.ICONRACE_1KM.hourly)) ? 'ICONRACE_1KM' : 'AROME'
        const f3d = m3dKey.startsWith('ICONRACE')
          ? await fetchIconRaceField({ lat: p1lat, lon: p1lon, height: VIEW3D_HEIGHT_M, timezone: tz, modelKey: m3dKey })
          : await fetchWindField({ modelKey: m3dKey, lat: p1lat, lon: p1lon, height: VIEW3D_HEIGHT_M, timezone: tz })
        const stamps = f3d?.stamps || []
        const frameIndices = [10, 12, 14, 16].map((H) => stamps.findIndex((s) => s && s.hh === H)).filter((i) => i >= 0)
        const ML = window.maplibregl
        const modelLabel = MODELS[m3dKey]?.label || m3dKey
        // The 3 selected points as numbered markers on the exported maps.
        const LOC_COLORS = { '1': '#EF4444', '2': '#10B981', '3': '#F97316' }
        const deckPoints = Object.entries(windData || {})
          .map(([k, pt]) => ({ key: k, lat: pt?.coords?.latitude ?? (k === '1' ? p1lat : null), lon: pt?.coords?.longitude ?? (k === '1' ? p1lon : null), color: LOC_COLORS[k] || '#38BDF8' }))
          .filter((p) => p.lat != null && p.lon != null)
        if (ML && f3d?.frames?.length && frameIndices.length) {
          // Model guidance: tight ≈ 5 nm racing view, 2 nm ring, full grid density.
          const caps = await withTimeout(captureField3DSeries(ML, f3d, { lat: p1lat, lon: p1lon, width: 760, height: 460, exaggeration: 3, frameIndices, zoom: 11.6, arrowStep: 1, ringNm: 2, points: deckPoints }), 55000, [])
          views3d = (caps || []).map((c) => { const s = stamps[c.idx]; return { label: s ? `${pad2(s.hh)}:00` : '', model: modelLabel, height: VIEW3D_HEIGHT_M, png: c.png } }).filter((v) => v.png)
          // General weather hero: zoomed-OUT ≈ 20 nm overview, 10 nm ring, midday.
          const midIdx = frameIndices[1] ?? frameIndices[0]
          const heroCaps = await withTimeout(captureField3DSeries(ML, f3d, { lat: p1lat, lon: p1lon, width: 900, height: 540, exaggeration: 3, frameIndices: [midIdx], zoom: 9.8, arrowStep: 1, ringNm: 10, points: deckPoints }), 45000, [])
          const hc = (heroCaps || [])[0]
          if (hc?.png) { const s = stamps[hc.idx]; heroView = { label: s ? `${pad2(s.hh)}:00` : '12:00', model: modelLabel, height: VIEW3D_HEIGHT_M, png: hc.png } }
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
        // Computed from the wind field over a 4 nm W/L course centred on point 1
        // (the AI cannot see the spatial field): twd, bend (left/right looking
        // upwind, degrees), and TWS gradient left-right / top-bottom (kn). The
        // hourly series shows how the bend / gradient EVOLVE through the racing window.
        course, courseSeries,
      }
      let ai = null
      setAiErr('writing AI brief…')
      try {
        // Client cap (65s) sits just beyond the server's 55s upstream abort, so a
        // real server error/timing wins instead of a blind client timeout.
        const r = await withTimeout(aiSummary(aiPayload), 65000, { __error: 'client timeout (65s) — server never responded' })
        if (r && r.__error) { setAiErr(r.__error); ai = null }
        else { ai = r; setAiErr(r?._ms ? `AI brief ok (${(r._ms / 1000).toFixed(1)}s)` : '') }
      } catch (e) { setAiErr(e?.message || 'failed') }

      const typeOfDay = diag?.typeOfDay || ai?.typeOfDay || typeHeur
      const deck = buildDeck(P, {
        venue: venueName, location: venueName,
        boatName: boatName || null, eventName: eventName || null,
        day: aiPayload.date,                                  // "Wednesday, 24 June"
        year: String(new Date().getFullYear()),
        typeOfDay, raceDay: campaignRaceDay, ai, diag, course, courseSeries,
        subtitle: `${venueName} — issued ${new Date().toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz })}`,
        outlookModelLabel: MODELS[outlookModel]?.label || outlookModel, shortModelLabel: MODELS[shortSel]?.label || shortSel,
        mastH: mastHeight, outlookRows, dailyRows, cmpSpeed: cmp[0], cmpDir: cmp[1], longRange, windfieldImg, hpblImg, soundingImg, views3d, heroView,
        wwRows, wwProfileImg,
        generalBullets: ['Synoptic setup — edit', 'Sea-breeze timing & strength — edit', 'Local effects / hazards — edit'],
        dailyBullets: [peak ? `Peak breeze ~${peak.hi}kn around ${peak.time}` : 'Breeze through the racing window — edit', 'Racing window 10:00–16:00 — edit', 'Local effects — edit'],
      })
      await deck.writeFile({ fileName: `forecast_${venueName.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pptx` })

      // Prepend the Summary text into the campaign day's Weather -> Notes (top,
      // editable). Best-effort: never block the deck. De-dupes a prior auto block.
      try {
        const block = summaryNotesBlock(typeOfDay, ai, aiPayload.date)
        if (block && teamId && boatId && targetDate) {
          const cbase = `/api/teams/${teamId}/boats/${boatId}/campaign`
          const cur = await fetch(`${cbase}/conditions?date=${targetDate}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
          const details = cur?.details || {}
          const SEP = '\n\n\u2014\u2014\u2014\n\n'
          let rest = String(details.comments || '')
          if (rest.startsWith('Forecast summary')) { const i = rest.indexOf(SEP); rest = i >= 0 ? rest.slice(i + SEP.length) : '' }
          const comments = rest.trim() ? `${block}${SEP}${rest}` : block
          await fetch(`${cbase}/conditions`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: targetDate, details: { ...details, comments } }) }).catch(() => {})
        }
      } catch { /* best-effort — the deck is the primary output */ }
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
          {err || (!haveP1 ? 'Set point 1 to enable' : 'Editable .pptx · portrait (phone) · mast-height · ranges ±1σ')}
        </span>
        {aiErr && (() => {
          const ok = aiErr.startsWith('AI brief ok'); const working = aiErr.includes('writing')
          const color = ok ? '#34D399' : (working ? '#7DD3FC' : '#FBBF24')
          const label = (ok || working) ? aiErr : `AI brief skipped — ${aiErr}`
          return <span style={{ fontSize: 11, color, alignSelf: 'center' }}>{label}</span>
        })()}
      </div>
    </div>
  )
}
const lbl = { fontSize: 10, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1 }
const input = { background: '#071624', border: '1px solid #1E3A5A', borderRadius: 6, color: '#E2E8F0', padding: '6px 9px', fontSize: 13 }
const btn = { background: '#06B6D4', border: 'none', borderRadius: 6, color: '#001018', fontWeight: 700, fontSize: 13, padding: '8px 16px', cursor: 'pointer' }

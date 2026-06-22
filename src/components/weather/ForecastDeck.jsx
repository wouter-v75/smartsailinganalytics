// ForecastDeck.jsx
// ----------------------------------------------------------------------------
// Admin-only "Generate forecast" panel at the top of the Forecast tab. Builds the
// 4-slide racing-weather deck (General weather, Outlook, Details for today, Model
// comparison) as an EDITABLE .pptx via pptxgenjs — native tables colour-coded with
// the same Beaufort ramp as the wind field. Opens cleanly in Keynote/PowerPoint.
//
// Daily-details = the SHORT-TERM model at point 1 (mast height + MOS where available).
// Outlook = the chosen OUTLOOK model (ARPEGE/ECMWF), with Morning/Midday/Afternoon =
// the 10:00 / 12:00 / 15:00 LOCAL forecasts. TWS min&max = a WEIGHTED multi-model blend
// (today: all models at point 1; outlook: the long-range global models). The wind-field
// (12:00) and the two model-comparison charts are auto-captured in DAY (light) mode.
// ----------------------------------------------------------------------------
import React, { useMemo, useState } from 'react'
import { useScriptsOnce } from './useScriptOnce'
import { MODELS, interpolateSpeedAtHeight, hasValidSpeed } from './openMeteo'
import { matchVenue, specFor, mosSeries } from './mos'
import { BEAUFORT_BANDS, PALETTE_MAX_KT, fetchWindField, fetchIconRaceField } from './windField'

const PPTX_JS = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js'
const PLOTLY_JS = 'https://cdnjs.cloudflare.com/ajax/libs/plotly.js/2.24.1/plotly.min.js'
const KN = 0.539957
const OUTLOOK_MODELS = ['ARPEGE', 'ECMWF']          // longer-range globals for the multi-day outlook
const OUTLOOK_DAYS = 4
const BAND_MODELS_TODAY = ['ICONRACE', 'ICONRACE_1KM', 'AROME', 'ECMWF', 'ICON', 'ARPEGE', 'ITALIA', 'DMI']
const WEIGHTS = {                                   // per-model weight for the TWS min&max blend
  ICONRACE: 1.0, ICONRACE_1KM: 1.0, AROME: 1.0, ECMWF: 0.8, ICON: 0.8, ARPEGE: 0.5, ITALIA: 0.7, DMI: 0.6,
}
const RACE_HOURS = [10, 11, 12, 13, 14, 15, 16]
const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
const cardinal = (deg) => (deg == null || Number.isNaN(deg) ? '' : CARD[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16])

function circMean(degs) {
  if (!degs.length) return null
  let s = 0; let c = 0
  for (const d of degs) { const r = (d * Math.PI) / 180; s += Math.sin(r); c += Math.cos(r) }
  return (((Math.atan2(s, c) * 180) / Math.PI) % 360 + 360) % 360
}

function beaufort(kn) {
  const N = BEAUFORT_BANDS.length
  const x = Math.max(0, Math.min(0.999999, (kn || 0) / PALETTE_MAX_KT))
  const pos = x * (N - 1); const i = Math.floor(pos); const t = pos - i
  const a = BEAUFORT_BANDS[i].c; const b = BEAUFORT_BANDS[Math.min(N - 1, i + 1)].c
  const r = Math.round(a[0] + (b[0] - a[0]) * t)
  const g = Math.round(a[1] + (b[1] - a[1]) * t)
  const bl = Math.round(a[2] + (b[2] - a[2]) * t)
  const hex = ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1).toUpperCase()
  return { hex, dark: (0.299 * r + 0.587 * g + 0.114 * bl) < 128, rgb: [r, g, bl] }
}

// Weighted band [lo,hi] (kn): low-weight models' deviations are shrunk toward the
// weighted mean, so the weights shape how wide the range is (weight 0 = no influence).
export function weightedBand(items) {
  const xs = items.filter((x) => x.v != null && Number.isFinite(x.v) && x.w > 0)
  if (!xs.length) return null
  const sw = xs.reduce((a, x) => a + x.w, 0)
  const mu = xs.reduce((a, x) => a + x.w * x.v, 0) / sw
  const wmax = Math.max(...xs.map((x) => x.w))
  const pulled = xs.map((x) => mu + (x.v - mu) * (x.w / wmax))
  return [Math.round(Math.min(mu, ...pulled)), Math.round(Math.max(mu, ...pulled))]
}

async function fetchModelDays(modelKey, lat, lon, tz, days) {
  const m = MODELS[modelKey]
  if (!m || !m.endpoint) throw new Error(`${modelKey} has no Open-Meteo endpoint`)
  const params = []
  for (const h of (m.heights || [10])) params.push(`wind_speed_${h}m`, `wind_direction_${h}m`)
  let url = `${m.endpoint}?latitude=${lat}&longitude=${lon}&hourly=${params.join(',')}`
    + `&wind_speed_unit=kmh&timezone=${encodeURIComponent(tz)}&forecast_days=${days}`
  if (m.modelParam) url += `&models=${m.modelParam}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${modelKey} ${res.status}`)
  return res.json()
}

const heightsFromHourly = (h) => {
  const hs = []
  for (const k of Object.keys(h || {})) { const m = k.match(/^wind_speed_(\d+)m$/); if (m) hs.push(+m[1]) }
  return hs.sort((a, b) => a - b)
}
function mastKn(hourly, heights, mastH, i, mosArr) {
  if (mosArr && mosArr[i] != null) return mosArr[i]
  const kmh = interpolateSpeedAtHeight(hourly, heights, mastH, i)
  return kmh != null ? kmh * KN : null
}
const idxAt = (h, dateStr, hh) => (h.time || []).findIndex((t) => t.startsWith(`${dateStr}T${String(hh).padStart(2, '0')}:`))

// today's hourly detail rows from the short-term model + a weighted min&max from all models
function buildDaily(shortHourly, shortKey, mastH, shortMos, bandModels) {
  if (!shortHourly?.time) return []
  const heights = MODELS[shortKey]?.heights || heightsFromHourly(shortHourly)
  const today = shortHourly.time[0]?.slice(0, 10)
  const rows = []
  for (let i = 0; i < shortHourly.time.length; i++) {
    const t = shortHourly.time[i]
    if (t.slice(0, 10) !== today) break
    const hh = parseInt(t.slice(11, 13), 10)
    if (hh < 7 || hh > 19) continue
    const s = mastKn(shortHourly, heights, mastH, i, shortMos)
    if (s == null) continue
    const kn = Math.round(s)
    const d = shortHourly.wind_direction_10m?.[i] ?? shortHourly[`wind_direction_${heights[0]}m`]?.[i]
    const items = bandModels.map((bm) => {
      const j = bm.hourly.time.indexOf(t)
      return { v: j >= 0 ? mastKn(bm.hourly, bm.heights, mastH, j, bm.mos) : null, w: bm.weight }
    })
    const band = weightedBand(items.concat([{ v: s, w: WEIGHTS[shortKey] || 1 }])) || [Math.max(0, kn - 2), kn + 2]
    rows.push({ time: `${String(hh).padStart(2, '0')}:00`, twd: cardinal(d), tws: `${kn}kn`, lo: band[0], hi: band[1] })
  }
  return rows
}

// multi-day outlook: Morning/Midday/Afternoon = 10:00/12:00/15:00 of the selected model;
// TWS min&max = weighted blend of the long-range models over the racing hours.
function buildOutlook(centralJson, mastH, bandModels) {
  const h = centralJson?.hourly
  if (!h?.time) return []
  const heights = heightsFromHourly(h)
  const dates = [...new Set(h.time.map((t) => t.slice(0, 10)))].slice(0, OUTLOOK_DAYS)
  const rows = []
  for (const d of dates) {
    const at = (hh) => {
      const i = idxAt(h, d, hh)
      if (i < 0) return null
      const s = mastKn(h, heights, mastH, i, null)
      const dir = h.wind_direction_10m?.[i] ?? h[`wind_direction_${heights[0]}m`]?.[i]
      return s == null ? null : { kn: Math.round(s), dir: cardinal(dir) }
    }
    const items = []
    for (const bm of bandModels) {
      for (const hh of RACE_HOURS) {
        const i = idxAt(bm.hourly, d, hh)
        if (i < 0) continue
        const v = mastKn(bm.hourly, bm.heights, mastH, i, null)
        if (v != null) items.push({ v, w: bm.weight })
      }
    }
    rows.push({
      day: new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long' }),
      mor: at(10), mid: at(12), aft: at(15), band: weightedBand(items),
    })
  }
  return rows
}

// ── day-mode image captures ─────────────────────────────────────────────────
async function captureComparison(point1, models) {
  if (!window.Plotly || !point1) return [null, null]
  const div = document.createElement('div')
  div.style.cssText = 'position:fixed;left:-9999px;top:0;width:1000px;height:600px;background:#fff'
  document.body.appendChild(div)
  const LIGHT = {
    paper_bgcolor: 'white', plot_bgcolor: 'white', font: { color: '#222', size: 13 },
    margin: { t: 36, b: 56, l: 60, r: 20 }, showlegend: true, legend: { orientation: 'h', y: -0.2 },
  }
  const traces = (kind) => {
    const out = []
    for (const k of models) {
      const h = point1.surfaceByModel?.[k]?.hourly
      if (!h?.time) continue
      const y = kind === 'spd'
        ? (h.wind_speed_10m || []).map((v) => (v != null ? v * KN : null))
        : (h.wind_direction_10m || [])
      if (!y.some((v) => v != null)) continue
      out.push({ x: h.time.map((t) => new Date(t)), y, name: MODELS[k]?.label || k,
        type: 'scatter', mode: kind === 'dir' ? 'markers' : 'lines+markers',
        line: { color: MODELS[k]?.color, width: 2 }, marker: { color: MODELS[k]?.color, size: 4 }, connectgaps: true })
    }
    return out
  }
  const imgs = []
  for (const [kind, title, yt, yax] of [
    ['spd', 'Wind speed (10 m)', 'knots', { rangemode: 'tozero' }],
    ['dir', 'Wind direction (10 m)', '°', { range: [0, 360], dtick: 45 }],
  ]) {
    const data = traces(kind)
    if (!data.length) { imgs.push(null); continue }
    const layout = { ...LIGHT, title: { text: title, font: { size: 15, color: '#1F4E79' } },
      xaxis: { title: 'Time', gridcolor: '#e5e7eb', linecolor: '#cbd5e1' },
      yaxis: { title: yt, gridcolor: '#e5e7eb', linecolor: '#cbd5e1', ...yax } }
    // eslint-disable-next-line no-await-in-loop
    await window.Plotly.newPlot(div, data, layout, { staticPlot: true })
    // eslint-disable-next-line no-await-in-loop
    imgs.push(await window.Plotly.toImage(div, { format: 'png', width: 1000, height: 600 }))
  }
  try { window.Plotly.purge(div) } catch { /* */ }
  div.remove()
  return imgs
}

function fieldNoonPng(field) {
  if (typeof document === 'undefined' || !field?.frames?.length) return null
  let idx = (field.stamps || []).findIndex((s) => s && s.hh === 12)
  if (idx < 0) idx = Math.floor(field.frames.length / 2)
  const { nx, ny } = field.header
  const fr = field.frames[idx]
  if (!fr || !fr.u) return null
  const scale = 16
  const cv = document.createElement('canvas'); cv.width = nx * scale; cv.height = ny * scale
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#eef3f8'; ctx.fillRect(0, 0, cv.width, cv.height)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const u = fr.u[j * nx + i] || 0; const v = fr.v[j * nx + i] || 0
      const kn = Math.hypot(u, v) * 1.94384
      const bf = beaufort(kn)
      ctx.globalAlpha = 0.9; ctx.fillStyle = `#${bf.hex}`
      ctx.fillRect(i * scale, j * scale, scale, scale)
      ctx.globalAlpha = 1
      const cx = i * scale + scale / 2; const cy = j * scale + scale / 2; const len = scale * 0.42
      const ux = u === 0 && v === 0 ? 0 : u / Math.hypot(u, v); const vy = u === 0 && v === 0 ? 0 : v / Math.hypot(u, v)
      const dx = ux * len; const dy = -vy * len
      ctx.strokeStyle = bf.dark ? '#ffffff' : '#1a2530'; ctx.lineWidth = 1.4
      ctx.beginPath(); ctx.moveTo(cx - dx, cy - dy); ctx.lineTo(cx + dx, cy + dy); ctx.stroke()
      // arrowhead
      const ah = scale * 0.22; const a = Math.atan2(dy, dx)
      ctx.beginPath(); ctx.moveTo(cx + dx, cy + dy)
      ctx.lineTo(cx + dx - ah * Math.cos(a - 0.5), cy + dy - ah * Math.sin(a - 0.5))
      ctx.moveTo(cx + dx, cy + dy)
      ctx.lineTo(cx + dx - ah * Math.cos(a + 0.5), cy + dy - ah * Math.sin(a + 0.5))
      ctx.stroke()
    }
  }
  return cv.toDataURL()
}

// ── deck builder (pptxgenjs) ────────────────────────────────────────────────
const NAVY = '1F4E79'; const INK = '202020'; const GREY = '6B7280'
const HEADER = 'D6DCE5'; const LIGHT = 'F2F4F7'; const FONT = 'Helvetica Neue'

function spdCell(text) {
  const nums = (text.match(/\d+/g) || []).map(Number)
  if (!nums.length) return { text, options: { color: INK, fontFace: FONT, fontSize: 13, valign: 'middle', align: 'left' } }
  const mid = nums.reduce((a, b) => a + b, 0) / nums.length
  const bf = beaufort(mid)
  return { text, options: { fill: { color: bf.hex }, color: bf.dark ? 'FFFFFF' : '0F1723', fontFace: FONT, fontSize: 13, valign: 'middle', align: 'left' } }
}
const txtCell = (text, o = {}) => ({ text, options: { color: INK, fontFace: FONT, fontSize: 13, valign: 'middle', align: 'left', ...o } })
const hdrCell = (text) => ({ text, options: { fill: { color: HEADER }, color: INK, bold: true, fontFace: FONT, fontSize: 13, valign: 'middle' } })

function addTitle(slide, title, sub) {
  slide.addText(title, { x: 0.5, y: 0.3, w: 12.3, h: 0.7, fontFace: FONT, fontSize: 34, bold: true, color: NAVY })
  if (sub) slide.addText(sub, { x: 0.52, y: 1.0, w: 12.3, h: 0.35, fontFace: FONT, fontSize: 12, color: GREY })
}
function placeholder(slide, x, y, w, h, label) {
  slide.addShape('roundRect', { x, y, w, h, fill: { color: LIGHT }, line: { color: 'C2C9D4', width: 1 }, rectRadius: 0.1 })
  slide.addText(label, { x, y, w, h, align: 'center', valign: 'middle', fontFace: FONT, fontSize: 15, color: GREY })
}
const fit = (img, x, y, w, h) => {
  const r = Math.min(w / (img.w || 1), h / (img.h || 1))
  const dw = (img.w || 1) * r; const dh = (img.h || 1) * r
  return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh }
}

function buildDeck(P, d) {
  const pptx = new P()
  pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 }); pptx.layout = 'WIDE'

  // 1) General weather (first) — wind field @ 12:00
  let s = pptx.addSlide()
  addTitle(s, 'General weather', d.subtitle)
  s.addText(d.generalBullets.map((t) => ({ text: t, options: { bullet: true, breakLine: true, paraSpaceAfter: 10 } })),
    { x: 0.5, y: 1.6, w: 5.4, h: 5.0, fontFace: FONT, fontSize: 17, color: INK })
  if (d.windfieldImg) {
    const box = { x: 6.3, y: 1.7, w: 6.5, h: 4.6 }
    const p = fit({ w: d.windfieldImg.w, h: d.windfieldImg.h }, box.x, box.y, box.w, box.h)
    s.addImage({ data: d.windfieldImg.data, ...p })
    s.addText('Wind field — 12:00 local', { x: 6.3, y: 6.4, w: 6.5, h: 0.3, align: 'center', fontFace: FONT, fontSize: 11, color: GREY })
  } else {
    placeholder(s, 6.3, 1.7, 6.5, 4.6, 'Wind field — 12:00 local\n(export from the SSA wind-field viewer)')
  }

  // 2) Outlook
  s = pptx.addSlide()
  addTitle(s, `Outlook — ${d.outlookModelLabel}`)
  const oHead = [hdrCell('Time'), hdrCell('Morning (10:00)'), hdrCell('Midday (12:00)'), hdrCell('Afternoon (15:00)'), hdrCell('TWS min&max'), hdrCell('Remarks')]
  const cell = (b) => (b ? `${b.dir} ${b.kn}kn` : '—')
  const oRows = d.outlookRows.map((r) => [
    txtCell(r.day, { bold: true, fill: { color: LIGHT } }),
    spdCell(cell(r.mor)), spdCell(cell(r.mid)), spdCell(cell(r.aft)),
    spdCell(r.band ? `${r.band[0]}-${r.band[1]}kn` : '—'), txtCell(''),
  ])
  s.addTable([oHead, ...oRows], { x: 0.5, y: 1.5, w: 12.33, colW: [1.4, 2.1, 2.1, 2.2, 1.6, 2.93], rowH: 0.5, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, valign: 'middle' })
  s.addText(`Outlook model: ${d.outlookModelLabel}  ·  AM/Mid/PM = 10:00/12:00/15:00 local  ·  TWS min&max = weighted model blend`, { x: 0.5, y: 7.02, w: 12.3, h: 0.35, fontFace: FONT, fontSize: 10, color: GREY })

  // 3) Details for today
  s = pptx.addSlide()
  addTitle(s, 'Details for today')
  s.addText(d.dailyBullets.map((t) => ({ text: t, options: { bullet: true, breakLine: true, paraSpaceAfter: 10 } })),
    { x: 0.5, y: 1.6, w: 4.7, h: 5.2, fontFace: FONT, fontSize: 17, color: INK })
  const dHead = [hdrCell('Time'), hdrCell('TWD'), hdrCell(`TWS ${d.venue}`), hdrCell('TWS min&max')]
  const dRows = d.dailyRows.map((r) => [txtCell(r.time, { bold: true, fill: { color: LIGHT } }), txtCell(r.twd), spdCell(r.tws), spdCell(`${r.lo}-${r.hi}kn`)])
  s.addTable([dHead, ...dRows], { x: 5.5, y: 1.5, w: 7.33, colW: [1.5, 1.9, 2.0, 1.93], rowH: 0.45, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, valign: 'middle' })
  s.addText(`TWS at mast height (${d.mastH} m), MOS-corrected where available  ·  Model: ${d.shortModelLabel}  ·  TWS min&max = weighted blend`, { x: 0.5, y: 7.02, w: 12.3, h: 0.35, fontFace: FONT, fontSize: 10, color: GREY })

  // 4) Model comparison — captured charts (day mode)
  s = pptx.addSlide()
  addTitle(s, 'Model comparison — wind speed & TWD')
  if (d.cmpSpeed) s.addImage({ data: d.cmpSpeed, ...fit({ w: 1000, h: 600 }, 0.4, 1.5, 6.3, 4.9) })
  else placeholder(s, 0.4, 1.5, 6.3, 4.9, 'Wind-speed comparison')
  if (d.cmpDir) s.addImage({ data: d.cmpDir, ...fit({ w: 1000, h: 600 }, 6.9, 1.5, 6.0, 4.9) })
  else placeholder(s, 6.9, 1.5, 6.0, 4.9, 'Wind-direction (TWD) comparison')

  return pptx
}

// ── component ───────────────────────────────────────────────────────────────
export default function ForecastDeck({ p1lat, p1lon, windData, mastHeight = 20, resolvedTz = 'UTC' }) {
  const pptxReady = useScriptsOnce([PPTX_JS])
  useScriptsOnce([PLOTLY_JS])
  const point1 = windData?.['1']
  const haveP1 = p1lat != null && p1lon != null && !!point1

  const shortModels = useMemo(() => {
    const sb = point1?.surfaceByModel || {}
    return Object.keys(MODELS).filter((k) => sb[k] && hasValidSpeed(sb[k].hourly))
  }, [point1])

  const [outlookModel, setOutlookModel] = useState('ECMWF')
  const [shortModel, setShortModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const shortSel = shortModel && shortModels.includes(shortModel) ? shortModel
    : (shortModels.find((k) => k.startsWith('ICONRACE')) || shortModels[0] || '')

  async function generate() {
    setErr(''); setBusy(true)
    try {
      const P = window.PptxGenJS
      if (!P) throw new Error('PowerPoint engine still loading — try again in a moment')
      const venueName = (matchVenue(p1lat, p1lon) || 'venue').replace(/_/g, ' ')
      const tz = resolvedTz || 'UTC'
      const venueKey = matchVenue(p1lat, p1lon)
      const spec = venueKey ? specFor(venueKey) : null
      const mosFor = (key, hourly) => {
        const id = MODELS[key]?.mosModel
        return spec && id ? mosSeries(hourly, MODELS[key]?.heights || [10], spec, id, tz) : null
      }

      // band models for "today" = all models present at point 1
      const sb = point1.surfaceByModel
      const bandModels = BAND_MODELS_TODAY
        .filter((k) => sb[k] && hasValidSpeed(sb[k].hourly))
        .map((k) => ({ key: k, hourly: sb[k].hourly, heights: MODELS[k]?.heights || [10], mos: mosFor(k, sb[k].hourly), weight: WEIGHTS[k] || 0.5 }))

      // daily details: selected short model + MOS
      const shortMos = mosFor(shortSel, sb[shortSel].hourly)
      const dailyRows = buildDaily(sb[shortSel].hourly, shortSel, mastHeight, shortMos,
        bandModels.filter((m) => m.key !== shortSel))

      // outlook: selected model (central) + both global models for the band
      const [central, ...bandJsons] = await Promise.all([
        fetchModelDays(outlookModel, p1lat, p1lon, tz, OUTLOOK_DAYS),
        ...OUTLOOK_MODELS.map((k) => fetchModelDays(k, p1lat, p1lon, tz, OUTLOOK_DAYS).catch(() => null)),
      ])
      const outlookBand = OUTLOOK_MODELS.map((k, i) => ({ k, json: bandJsons[i] }))
        .filter((x) => x.json?.hourly?.time)
        .map((x) => ({ hourly: x.json.hourly, heights: heightsFromHourly(x.json.hourly), weight: WEIGHTS[x.k] || 0.7 }))
      const outlookRows = buildOutlook(central, mastHeight, outlookBand)

      // day-mode images (best-effort; placeholders on failure)
      let cmp = [null, null]; let windfieldImg = null
      try { cmp = await captureComparison(point1, shortModels) } catch { /* placeholder */ }
      try {
        const field = shortSel.startsWith('ICONRACE')
          ? await fetchIconRaceField({ lat: p1lat, lon: p1lon, height: 10, timezone: tz, modelKey: shortSel })
          : (MODELS[shortSel]?.endpoint ? await fetchWindField({ modelKey: shortSel, lat: p1lat, lon: p1lon, height: 10, timezone: tz }) : null)
        const data = field ? fieldNoonPng(field) : null
        if (data) windfieldImg = { data, w: field.header.nx * 16, h: field.header.ny * 16 }
      } catch { /* placeholder */ }

      const peak = dailyRows.reduce((m, r) => (r.hi > (m?.hi ?? -1) ? r : m), null)
      const deck = buildDeck(P, {
        venue: venueName,
        subtitle: `${venueName} — issued ${new Date().toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz })}`,
        outlookModelLabel: MODELS[outlookModel]?.label || outlookModel,
        shortModelLabel: MODELS[shortSel]?.label || shortSel,
        mastH: mastHeight, outlookRows, dailyRows,
        cmpSpeed: cmp[0], cmpDir: cmp[1], windfieldImg,
        generalBullets: ['Synoptic setup — edit', 'Sea-breeze timing & strength — edit', 'Local effects / hazards — edit'],
        dailyBullets: [peak ? `Peak breeze ~${peak.hi}kn around ${peak.time}` : 'Breeze build through the day — edit', 'Morning: light/variable — edit', 'Local effects — edit'],
      })
      await deck.writeFile({ fileName: `forecast_${venueName.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pptx` })
    } catch (e) {
      setErr(e?.message || 'generation failed')
    } finally {
      setBusy(false)
    }
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
          {err || (!haveP1 ? 'Set point 1 to enable' : 'Editable .pptx · day-mode charts · opens in Keynote')}
        </span>
      </div>
    </div>
  )
}

const lbl = { fontSize: 10, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1 }
const input = { background: '#071624', border: '1px solid #1E3A5A', borderRadius: 6, color: '#E2E8F0', padding: '6px 9px', fontSize: 13 }
const btn = { background: '#06B6D4', border: 'none', borderRadius: 6, color: '#001018', fontWeight: 700, fontSize: 13, padding: '8px 16px', cursor: 'pointer' }

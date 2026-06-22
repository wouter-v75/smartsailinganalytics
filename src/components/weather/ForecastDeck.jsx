// ForecastDeck.jsx
// ----------------------------------------------------------------------------
// Admin-only "Generate forecast" panel at the top of the Forecast tab. Builds the
// 4-slide racing-weather deck (General weather, Outlook, Details for today, Model
// comparison) as an EDITABLE .pptx via pptxgenjs — native tables, colour-coded with
// the same Beaufort ramp as the wind field. Opens cleanly in Keynote/PowerPoint.
//
// Step (a): the daily-details table is filled from the SHORT-TERM model at point 1
// (mast height + MOS where available); the outlook table from the chosen OUTLOOK
// model (ARPEGE/ECMWF), multi-day, aggregated into Morning/Midday/Afternoon. The
// synoptic/wind-field and comparison images are placeholders (step b auto-captures
// them); the TWS min&max is the model's own daily spread for now (step b: weighted blend).
// ----------------------------------------------------------------------------
import React, { useMemo, useState } from 'react'
import { useScriptsOnce } from './useScriptOnce'
import { MODELS, interpolateSpeedAtHeight, hasValidSpeed } from './openMeteo'
import { matchVenue, specFor, mosSeries } from './mos'
import { BEAUFORT_BANDS, PALETTE_MAX_KT } from './windField'

const PPTX_JS = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js'
const KN = 0.539957                       // km/h -> knots
const OUTLOOK_MODELS = ['ARPEGE', 'ECMWF'] // longer-range global models for the multi-day outlook
const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

const cardinal = (deg) => (deg == null || Number.isNaN(deg) ? '' : CARD[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16])

function circMean(degs) {
  if (!degs.length) return null
  let s = 0; let c = 0
  for (const d of degs) { const r = (d * Math.PI) / 180; s += Math.sin(r); c += Math.cos(r) }
  return (((Math.atan2(s, c) * 180) / Math.PI) % 360 + 360) % 360
}

// wind speed (kn) -> { hex:'RRGGBB', dark:bool } using the wind-field Beaufort ramp
function beaufort(kn) {
  const N = BEAUFORT_BANDS.length
  const x = Math.max(0, Math.min(0.999999, (kn || 0) / PALETTE_MAX_KT))
  const pos = x * (N - 1); const i = Math.floor(pos); const t = pos - i
  const a = BEAUFORT_BANDS[i].c; const b = BEAUFORT_BANDS[Math.min(N - 1, i + 1)].c
  const r = Math.round(a[0] + (b[0] - a[0]) * t)
  const g = Math.round(a[1] + (b[1] - a[1]) * t)
  const bl = Math.round(a[2] + (b[2] - a[2]) * t)
  const hex = ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1).toUpperCase()
  return { hex, dark: (0.299 * r + 0.587 * g + 0.114 * bl) < 128 }
}

// Fetch one Open-Meteo model for N forecast days at a point.
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

// mast-height wind in knots at index i (MOS-corrected 30 m where available).
function mastKn(hourly, heights, mastH, i, mosArr) {
  if (mosArr && mosArr[i] != null) return mosArr[i]            // MOS knots (30 m)
  const kmh = interpolateSpeedAtHeight(hourly, heights, mastH, i)
  return kmh != null ? kmh * KN : null
}

// Representative dir + speed range (kn) over a set of hour indices.
function summarize(hourly, heights, mastH, idxs, mosArr) {
  const spds = []; const dirs = []
  for (const i of idxs) {
    const s = mastKn(hourly, heights, mastH, i, mosArr)
    if (s != null) spds.push(s)
    const d = hourly.wind_direction_10m?.[i] ?? hourly[`wind_direction_${heights[0]}m`]?.[i]
    if (d != null) dirs.push(d)
  }
  if (!spds.length) return null
  return { lo: Math.round(Math.min(...spds)), hi: Math.round(Math.max(...spds)), dir: cardinal(circMean(dirs)) }
}

// Build the multi-day outlook rows from an outlook-model payload.
function buildOutlook(json, mastH, days) {
  const h = json?.hourly
  if (!h?.time) return []
  const heights = []
  for (const k of Object.keys(h)) { const m = k.match(/^wind_speed_(\d+)m$/); if (m) heights.push(+m[1]) }
  heights.sort((a, b) => a - b)
  const byDate = {}
  h.time.forEach((t, i) => { (byDate[t.slice(0, 10)] ||= []).push(i) })
  const hourOf = (i) => parseInt(h.time[i].slice(11, 13), 10)
  const rows = []
  for (const d of Object.keys(byDate).slice(0, days)) {
    const idxs = byDate[d]
    const win = (lo, hi) => idxs.filter((i) => hourOf(i) >= lo && hourOf(i) < hi)
    const mor = summarize(h, heights, mastH, win(8, 11))
    const mid = summarize(h, heights, mastH, win(11, 14))
    const aft = summarize(h, heights, mastH, win(14, 18))
    const all = summarize(h, heights, mastH, win(8, 19))
    const wd = new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long' })
    rows.push({ day: wd, mor, mid, aft, all })
  }
  return rows
}

// Build today's hourly detail rows from the short-term model at point 1.
function buildDaily(hourly, modelKey, mastH, mosArr) {
  if (!hourly?.time) return []
  const heights = MODELS[modelKey]?.heights || [10]
  const today = hourly.time[0]?.slice(0, 10)
  const rows = []
  for (let i = 0; i < hourly.time.length; i++) {
    const t = hourly.time[i]
    if (t.slice(0, 10) !== today) break
    const hh = parseInt(t.slice(11, 13), 10)
    if (hh < 7 || hh > 19) continue
    const s = mastKn(hourly, heights, mastH, i, mosArr)
    if (s == null) continue
    const d = hourly.wind_direction_10m?.[i] ?? hourly[`wind_direction_${heights[0]}m`]?.[i]
    const kn = Math.round(s)
    rows.push({ time: `${String(hh).padStart(2, '0')}:00`, twd: cardinal(d), tws: `${kn}kn`, lo: Math.max(0, kn - 2), hi: kn + 2 })
  }
  return rows
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

function addTitle(slide, P, title, sub) {
  slide.addText(title, { x: 0.5, y: 0.3, w: 12.3, h: 0.7, fontFace: FONT, fontSize: 34, bold: true, color: NAVY })
  if (sub) slide.addText(sub, { x: 0.52, y: 1.0, w: 12.3, h: 0.35, fontFace: FONT, fontSize: 12, color: GREY })
}
function placeholder(slide, x, y, w, h, label) {
  slide.addShape('roundRect', { x, y, w, h, fill: { color: LIGHT }, line: { color: 'C2C9D4', width: 1 }, rectRadius: 0.1 })
  slide.addText(label, { x, y, w, h, align: 'center', valign: 'middle', fontFace: FONT, fontSize: 15, color: GREY })
}

function buildDeck(P, d) {
  const pptx = new P()
  pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 }); pptx.layout = 'WIDE'

  // 1) General weather (first)
  let s = pptx.addSlide()
  addTitle(s, P, 'General weather', d.subtitle)
  s.addText(d.generalBullets.map((t) => ({ text: t, options: { bullet: true, breakLine: true, paraSpaceAfter: 10 } })),
    { x: 0.5, y: 1.6, w: 5.4, h: 5.0, fontFace: FONT, fontSize: 17, color: INK })
  placeholder(s, 6.3, 1.7, 6.5, 4.6, 'Wind field — 12:00 local\n(export from the SSA wind-field viewer)')

  // 2) Outlook
  s = pptx.addSlide()
  addTitle(s, P, `Outlook — ${d.outlookModelLabel}`)
  const oHead = [hdrCell('Time'), hdrCell('Morning'), hdrCell('Midday'), hdrCell('Afternoon'), hdrCell('TWS min&max'), hdrCell('Remarks')]
  const oRows = d.outlookRows.map((r) => {
    const cell = (b) => (b ? `${b.dir} ${b.lo}-${b.hi}kn` : '—')
    const mm = r.all ? `${r.all.lo}-${r.all.hi}kn` : '—'
    return [txtCell(r.day, { bold: true, fill: { color: LIGHT } }), spdCell(cell(r.mor)), spdCell(cell(r.mid)), spdCell(cell(r.aft)), spdCell(mm), txtCell(r.remarks || '')]
  })
  s.addTable([oHead, ...oRows], { x: 0.5, y: 1.5, w: 12.33, colW: [1.5, 2.05, 2.05, 2.2, 1.6, 2.93], rowH: 0.5, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, valign: 'middle' })
  s.addText(`Outlook model: ${d.outlookModelLabel}  ·  TWS min&max = model daily spread (weighted blend: coming)`, { x: 0.5, y: 7.02, w: 12.3, h: 0.35, fontFace: FONT, fontSize: 10, color: GREY })

  // 3) Details for today
  s = pptx.addSlide()
  addTitle(s, P, 'Details for today')
  s.addText(d.dailyBullets.map((t) => ({ text: t, options: { bullet: true, breakLine: true, paraSpaceAfter: 10 } })),
    { x: 0.5, y: 1.6, w: 4.7, h: 5.2, fontFace: FONT, fontSize: 17, color: INK })
  const dHead = [hdrCell('Time'), hdrCell('TWD'), hdrCell(`TWS ${d.venue}`), hdrCell('TWS min&max')]
  const dRows = d.dailyRows.map((r) => [txtCell(r.time, { bold: true, fill: { color: LIGHT } }), txtCell(r.twd), spdCell(r.tws), spdCell(`${r.lo}-${r.hi}kn`)])
  s.addTable([dHead, ...dRows], { x: 5.5, y: 1.5, w: 7.33, colW: [1.5, 1.9, 2.0, 1.93], rowH: 0.45, border: { type: 'solid', color: 'FFFFFF', pt: 1 }, valign: 'middle' })
  s.addText(`TWS at mast height (${d.mastH} m), MOS-corrected where available  ·  Model: ${d.shortModelLabel}`, { x: 0.5, y: 7.02, w: 12.3, h: 0.35, fontFace: FONT, fontSize: 10, color: GREY })

  // 4) Model comparison
  s = pptx.addSlide()
  addTitle(s, P, 'Model comparison — wind speed & TWD')
  placeholder(s, 0.4, 1.5, 6.3, 4.9, 'Wind-speed comparison\n(export from SSA Model Comparison)')
  placeholder(s, 6.9, 1.5, 6.0, 4.9, 'Wind-direction (TWD) comparison\n(export from SSA Model Comparison)')

  return pptx
}

// ── component ───────────────────────────────────────────────────────────────
export default function ForecastDeck({ p1lat, p1lon, windData, modelAvailable, mastHeight = 20, resolvedTz = 'UTC' }) {
  const pptxReady = useScriptsOnce([PPTX_JS])
  const point1 = windData?.['1']
  const haveP1 = p1lat != null && p1lon != null && !!point1

  // short-term models = those with data at point 1 (excluding the field-only layers)
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
      if (!P) throw new Error('PowerPoint engine not loaded yet — try again in a moment')
      const venueName = (matchVenue(p1lat, p1lon) || 'venue').replace(/_/g, ' ')
      const tz = resolvedTz || 'UTC'

      // outlook: fetch the chosen global model for ~4 days
      const oJson = await fetchModelDays(outlookModel, p1lat, p1lon, tz, 4)
      const outlookRows = buildOutlook(oJson, mastHeight, 4)

      // daily details: short-term model at point 1 (already fetched), MOS if available
      const sb = point1.surfaceByModel[shortSel]
      const heights = MODELS[shortSel]?.heights || [10]
      const venueKey = matchVenue(p1lat, p1lon)
      const spec = venueKey ? specFor(venueKey) : null
      const mosId = MODELS[shortSel]?.mosModel
      const mosArr = spec && mosId ? mosSeries(sb.hourly, heights, spec, mosId, tz) : null
      const dailyRows = buildDaily(sb.hourly, shortSel, mastHeight, mosArr)

      const peak = dailyRows.reduce((m, r) => (r.hi > (m?.hi ?? -1) ? r : m), null)
      const deck = buildDeck(P, {
        venue: venueName,
        subtitle: `${venueName} — issued ${new Date().toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz })}`,
        outlookModelLabel: MODELS[outlookModel]?.label || outlookModel,
        shortModelLabel: MODELS[shortSel]?.label || shortSel,
        mastH: mastHeight,
        outlookRows,
        dailyRows,
        generalBullets: ['Synoptic setup — edit', 'Sea-breeze timing & strength — edit', 'Local effects / hazards — edit'],
        dailyBullets: [
          peak ? `Peak breeze ~${peak.hi}kn around ${peak.time}` : 'Breeze build through the day — edit',
          'Morning: light/variable — edit', 'Local effects — edit',
        ],
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
          {err || (!haveP1 ? 'Set point 1 to enable' : 'Editable .pptx — opens in Keynote/PowerPoint')}
        </span>
      </div>
    </div>
  )
}

const lbl = { fontSize: 10, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1 }
const input = { background: '#071624', border: '1px solid #1E3A5A', borderRadius: 6, color: '#E2E8F0', padding: '6px 9px', fontSize: 13 }
const btn = { background: '#06B6D4', border: 'none', borderRadius: 6, color: '#001018', fontWeight: 700, fontSize: 13, padding: '8px 16px', cursor: 'pointer' }

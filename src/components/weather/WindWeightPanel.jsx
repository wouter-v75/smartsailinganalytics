// WindWeightPanel — Stability-tab windweight for the racing window.
//   1) hourly table 08:00–20:00 (venue-local), FORECAST windweight per hour
//   2) vertical rig profile V(z) 0→masthead for the selected hour
//   3) OBSERVED windweight for the same hours once a logfile is uploaded
//      (from on-board masthead TWS + air-T + SST + RH via the bulk MOST route)
// Forecast comes from the box product (icon-race/<domain>/<venue>/windweight.json);
// observed is computed client-side with src/lib/windweight.ts.

import React, { useEffect, useMemo, useState } from 'react'
import { fetchWindweightNearest, windweightVenues } from './openMeteo'
import { windweightObserved } from '../../lib/windweight'

const CLS_COLOR = { Light: '#7DD3FC', Standard: '#1D9E75', Heavy: '#F97316' }
const clsColor = (c) => CLS_COLOR[c] || '#94A3B8'
const HOURS = Array.from({ length: 13 }, (_, i) => i + 8) // 8..20

// local hour (0..23) of a UTC ms in an IANA tz
function localHour(ms, tz) {
  try {
    const s = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms))
    return parseInt(s, 10)
  } catch { return new Date(ms).getUTCHours() }
}
// local YYYY-MM-DD of a UTC ms in tz
function localDate(ms, tz) {
  try {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
    return p
  } catch { return new Date(ms).toISOString().slice(0, 10) }
}

export default function WindWeightPanel({ windData = {}, locKey, resolvedTz = 'UTC', logData = null, mastHeight: mastHeightProp = 34 }) {
  const coords = (locKey && windData[locKey]?.coords) || Object.values(windData).find((p) => p?.coords)?.coords || null
  const hasVenue = coords ? windweightVenues(coords.latitude, coords.longitude).length > 0 : false

  const [fc, setFc] = useState(undefined) // undefined loading, null none
  const [ven, setVen] = useState(null)    // resolved { domain, venue } that had data
  const [selHour, setSelHour] = useState(13)
  const [mastHeight, setMastHeight] = useState(mastHeightProp) // the CHOSEN masthead height (m)

  useEffect(() => {
    let off = false
    setFc(undefined); setVen(null)
    if (!coords) { setFc(null); return }
    fetchWindweightNearest(coords.latitude, coords.longitude).then((r) => {
      if (off) return
      setFc(r?.data ?? null)
      setVen(r ? { domain: r.domain, venue: r.venue } : null)
    })
    return () => { off = true }
  }, [coords?.latitude, coords?.longitude])

  const todayLocal = coords ? localDate(Date.now(), resolvedTz) : null

  // forecast hour → row, for TODAY's 08..20 local
  const fcByHour = useMemo(() => {
    const m = {}
    const hrs = (fc && Array.isArray(fc.hours)) ? fc.hours : []
    for (const h of hrs) {
      const ms = Date.parse(h.t)
      if (isNaN(ms)) continue
      if (localDate(ms, resolvedTz) !== todayLocal) continue
      m[localHour(ms, resolvedTz)] = h
    }
    return m
  }, [fc, resolvedTz, todayLocal])

  // observed hour → {ww, veff, cls, n} from the log (avg the on-board sensors per hour)
  const obsByHour = useMemo(() => {
    const out = {}
    const rows = logData?.rows
    if (!rows?.length) return out
    const bins = {} // hr -> accumulators
    for (const r of rows) {
      if (r.utc == null) continue
      if (localDate(r.utc, resolvedTz) !== todayLocal) continue
      const hr = localHour(r.utc, resolvedTz)
      if (hr < 8 || hr > 20) continue
      const b = (bins[hr] ||= { tws: [0, 0], at: [0, 0], st: [0, 0], rh: [0, 0], bp: [0, 0] })
      const push = (k, v) => { if (v != null && v === v) { b[k][0] += v; b[k][1]++ } }
      push('tws', r.tws); push('at', r.airTemp); push('st', r.seaTemp); push('rh', r.rh); push('bp', r.baro)
    }
    const avg = (a) => (a[1] ? a[0] / a[1] : null)
    for (const hr of Object.keys(bins)) {
      const b = bins[hr]
      const tws = avg(b.tws), at = avg(b.at), st = avg(b.st)
      let rh = avg(b.rh); if (rh != null && rh > 1.5) rh /= 100 // accept % or fraction
      const bp = avg(b.bp)
      if (tws == null || at == null || st == null) continue
      const r = windweightObserved({ vHKt: tws, airTC: at, sstC: st, rhFrac: rh ?? 0.6, pHpa: bp ?? 1015, H: mastHeight })
      if (r) out[hr] = { ww: r.ww, veff: r.vEff, cls: r.cls, n: b.tws[1], profile: r.profile }
    }
    return out
  }, [logData, resolvedTz, todayLocal, mastHeight])

  const hasObs = Object.keys(obsByHour).length > 0
  const selFc = fcByHour[selHour]
  const selObs = obsByHour[selHour]

  return (
    <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14, gridColumn: '1 / -1' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0' }}>🪶 Wind weight — racing window</span>
        <span style={{ fontSize: 11, color: '#64748B' }}>
          rig load vs a standard day · 100 = standard · {ven ? `${ven.venue} (${ven.domain})` : hasVenue ? '…' : 'no SSA-Race venue near this point'}
        </span>
        <div style={{ flex: 1 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, color: '#7DD3FC' }}>
          Masthead
          <input type="number" min={5} max={60} value={mastHeight}
            onChange={(e) => setMastHeight(Math.max(5, Math.min(60, Number(e.target.value) || 34)))}
            style={{ width: 52, background: '#071624', border: '1px solid #1E3A5A', borderRadius: 5, color: '#E2E8F0', padding: '3px 6px', fontSize: 11 }} /> m
        </label>
      </div>

      {fc === undefined && <div style={{ fontSize: 11, color: '#64748B' }}>loading forecast…</div>}
      {fc === null && hasVenue && !hasObs && <div style={{ fontSize: 11, color: '#64748B' }}>No windweight product published yet for this venue (appears after the box run).</div>}
      {!hasVenue && <div style={{ fontSize: 11, color: '#64748B' }}>Pick a location inside a SSA-Race venue box (La Ciotat / St Tropez / …).</div>}

      {(fc || hasObs) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 2fr) minmax(160px, 1fr)', gap: 14, alignItems: 'start' }}>
          {/* table */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: '#64748B', textAlign: 'right' }}>
                  <th style={thL}>Hour</th>
                  <th style={th}>Fcst WW</th>
                  <th style={th}>V_eff</th>
                  <th style={th}>Class</th>
                  {hasObs && <th style={th}>Obs WW</th>}
                  {hasObs && <th style={th}>Δ</th>}
                </tr>
              </thead>
              <tbody>
                {HOURS.map((hr) => {
                  const f = fcByHour[hr]; const o = obsByHour[hr]
                  const d = (f && o) ? Math.round((o.ww - f.WW) * 10) / 10 : null
                  const active = hr === selHour
                  return (
                    <tr key={hr} onClick={() => setSelHour(hr)}
                      style={{ cursor: 'pointer', background: active ? '#0F2A45' : 'transparent', borderTop: '1px solid #0F2030' }}>
                      <td style={{ ...tdL, color: active ? '#06B6D4' : '#CBD5E1', fontWeight: active ? 700 : 400 }}>{String(hr).padStart(2, '0')}:00</td>
                      <td style={{ ...td, color: f ? clsColor(f.cls) : '#334155', fontWeight: 700 }}>{f ? `${f.WW}%` : '—'}</td>
                      <td style={{ ...td, color: '#94A3B8' }}>{f ? `${f.V_eff}kt` : '—'}</td>
                      <td style={{ ...td, color: f ? clsColor(f.cls) : '#334155' }}>{f ? f.cls : '—'}</td>
                      {hasObs && <td style={{ ...td, color: o ? clsColor(o.cls) : '#334155', fontWeight: 700 }}>{o ? `${o.ww}%` : '—'}</td>}
                      {hasObs && <td style={{ ...td, color: d == null ? '#334155' : Math.abs(d) < 5 ? '#1D9E75' : '#F59E0B' }}>{d == null ? '—' : (d > 0 ? `+${d}` : d)}</td>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {!hasObs && <div style={{ fontSize: 10, color: '#475569', marginTop: 6 }}>Observed column appears once a logfile with on-board air-temp / sea-temp / RH is uploaded for today.</div>}
          </div>

          {/* vertical profile to masthead for the selected hour */}
          <div>
            <div style={{ fontSize: 10, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
              V(z) · {String(selHour).padStart(2, '0')}:00 · 0–{mastHeight} m
            </div>
            <ProfilePlot fc={selFc?.profile} obs={selObs?.profile} H={mastHeight} />
            <div style={{ fontSize: 10, color: '#64748B', marginTop: 4 }}>
              {selFc && <div>Fcst <b style={{ color: clsColor(selFc.cls) }}>{selFc.WW}%</b> {selFc.cls} · V_H {selFc.V_H}kt</div>}
              {selObs && <div>Obs <b style={{ color: clsColor(selObs.cls) }}>{selObs.ww}%</b> {selObs.cls} · V_H {windData && ''}{Math.round(selObs.veff)}kt eff · {selObs.n} samples</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ProfilePlot({ fc, obs, H = 34 }) {
  const W = 150, HT = 150, pad = 18
  const series = []
  if (Array.isArray(fc) && fc.length > 1) series.push({ pts: fc, c: '#06B6D4', lbl: 'fcst' })
  if (Array.isArray(obs) && obs.length > 1) series.push({ pts: obs, c: '#F59E0B', lbl: 'obs' })
  if (!series.length) return <div style={{ height: HT, fontSize: 10, color: '#334155', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #1E3A5A', borderRadius: 6 }}>no profile</div>
  const vMax = Math.max(...series.flatMap((s) => s.pts.map((p) => p.V))) * 1.08 || 1
  const X = (v) => pad + (v / vMax) * (W - pad - 6)
  const Y = (z) => HT - pad - (Math.min(z, H) / H) * (HT - pad - 6)
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${HT}`} style={{ border: '1px solid #1E3A5A', borderRadius: 6, background: '#071624' }}>
      {[0, H / 2, H].map((z) => (
        <g key={z}>
          <line x1={pad} y1={Y(z)} x2={W - 4} y2={Y(z)} stroke="#122435" strokeWidth="0.5" />
          <text x="2" y={Y(z) + 3} fill="#334155" fontSize="7">{Math.round(z)}m</text>
        </g>
      ))}
      {series.map((s) => (
        <g key={s.lbl}>
          <polyline points={s.pts.map((p) => `${X(p.V)},${Y(p.z)}`).join(' ')} fill="none" stroke={s.c} strokeWidth="1.6" />
          {s.pts.map((p) => <circle key={p.z} cx={X(p.V)} cy={Y(p.z)} r="1.6" fill={s.c} />)}
        </g>
      ))}
      <text x={W - 4} y={HT - 4} fill="#334155" fontSize="7" textAnchor="end">V (m/s)</text>
    </svg>
  )
}

const th = { padding: '3px 8px', textAlign: 'right', fontWeight: 600, fontSize: 10 }
const thL = { ...th, textAlign: 'left' }
const td = { padding: '3px 8px', textAlign: 'right', fontFamily: 'monospace' }
const tdL = { ...td, textAlign: 'left' }

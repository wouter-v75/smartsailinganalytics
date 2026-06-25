// Model Comparison sub-tab — Phase 2c.
//
// One location at a time across all fetched models. Panels: 10 m speed, mast
// speed, MOS-corrected 30 m, 100 m speed, 10 m direction.
//
// A shared clickable legend (model chips) toggles each model across ALL panels
// at once. Hovering a curve highlights it and shows that model's name + time +
// value only (hovermode 'closest'), instead of a unified all-models tooltip.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import PlotlyChart from './PlotlyChart'
import { MODELS, COMPARE_ORDER, kmhToKnots, speed100mSeries, interpolateSpeedAtHeight, labelWithCycle, localRacingWindow } from './openMeteo'
import { useModelCycles } from './modelCycles'
import { matchVenue, specFor, mosSeries } from './mos'

const LOCATION_META = [
  { key: '1', emoji: '🔴', accent: '#EF4444' },
  { key: '2', emoji: '🟢', accent: '#10B981' },
  { key: '3', emoji: '🟠', accent: '#F97316' },
]

export default function CompareView({ windData, mastHeight = 20, resolvedTz = 'UTC', canMos = false, canHeights = false }) {
  const cycles = useModelCycles()
  const locKeys = Object.keys(windData)
  const [activeLoc, setActiveLoc] = useState(locKeys[0] || '1')
  const [hidden, setHidden] = useState(() => new Set())   // model keys toggled off (shared across panels)
  useEffect(() => {
    if (!locKeys.includes(activeLoc) && locKeys.length) setActiveLoc(locKeys[0])
  }, [windData, locKeys, activeLoc])

  if (!locKeys.length) {
    return (
      <div style={{ padding: '24px 20px 40px' }}>
        <Card>
          <div style={{ fontSize: 13, color: '#94A3B8', textAlign: 'center', padding: 30 }}>
            No data yet. Open the <b>Forecast</b> tab, pick locations, and hit <b>Fetch wind data</b> — model comparison appears here automatically.
          </div>
        </Card>
      </div>
    )
  }

  const point = windData[activeLoc]
  const venue = point ? matchVenue(point.coords.latitude, point.coords.longitude) : null
  const spec = venue ? specFor(venue) : null

  // Models that actually have data at this location -> the shared legend.
  const present = COMPARE_ORDER.filter((k) => point && point.surfaceByModel && point.surfaceByModel[k] && point.surfaceByModel[k].hourly)
  const toggle = (k) => setHidden((h) => { const n = new Set(h); n.has(k) ? n.delete(k) : n.add(k); return n })

  return (
    <div style={{ padding: '16px 20px 40px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0' }}>🔬 Model Comparison</span>
          <span style={{ fontSize: 11, color: '#64748B' }}>click a model to show/hide it · hover a line for its value</span>
          <div style={{ flex: 1 }} />
          <label style={{ fontSize: 11, color: '#94A3B8', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span>Location</span>
            <select value={activeLoc} onChange={(e) => setActiveLoc(e.target.value)} style={inputStyle}>
              {locKeys.map((k) => {
                const meta = LOCATION_META.find((m) => m.key === k)
                return <option key={k} value={k}>{meta?.emoji} Location {k}</option>
              })}
            </select>
          </label>
        </div>

        {/* Shared clickable legend — toggles the model across every panel below. */}
        {present.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 10 }}>
            {present.map((k) => {
              const on = !hidden.has(k)
              const c = MODELS[k].color
              return (
                <button
                  key={k}
                  onClick={() => toggle(k)}
                  title={on ? 'click to hide' : 'click to show'}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '2px 7px', borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap',
                    border: `1px solid ${on ? c : '#33455C'}`,
                    background: on ? `${c}22` : 'transparent',
                    color: on ? '#E2E8F0' : '#64748B',
                    fontSize: 10, fontWeight: 600,
                    textDecoration: on ? 'none' : 'line-through',
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: on ? c : '#475569', flexShrink: 0 }} />
                  {labelWithCycle(k, cycles)}
                </button>
              )
            })}
          </div>
        )}
      </Card>

      <ComparePanel
        title="10 m wind speed"
        point={point} hidden={hidden} cycles={cycles}
        seriesFn={(h) => h.wind_speed_10m ? h.wind_speed_10m.map((v) => v != null ? kmhToKnots(v) : null) : null}
        yTitle="Wind speed (knots)" isDir={false}
      />
      {canHeights && (
      <ComparePanel
        title={`⛵ Wind speed at mast height (${mastHeight} m)`}
        point={point} hidden={hidden} cycles={cycles}
        seriesFn={(h, key) => {
          if (!h || !h.time) return null
          const hgts = MODELS[key].heights
          return h.time.map((_, i) => {
            const v = interpolateSpeedAtHeight(h, hgts, mastHeight, i)
            return v != null ? kmhToKnots(v) : null
          })
        }}
        yTitle="Wind speed (knots)" isDir={false}
      />
      )}
      {spec && canMos && (
        <ComparePanel
          title={`✓ MOS-corrected mast-height wind (30 m) — ${venue.replace('_', ' ')}`}
          point={point} hidden={hidden} cycles={cycles}
          seriesFn={(h, key) => {
            const mosId = MODELS[key].mosModel
            if (!mosId) return null
            return mosSeries(h, MODELS[key].heights, spec, mosId, resolvedTz)
          }}
          yTitle="Wind speed (knots)" isDir={false}
        />
      )}
      {canHeights && (
      <ComparePanel
        title="100 m wind speed  (ICON interpolated 80↔120 m)"
        point={point} hidden={hidden} cycles={cycles}
        seriesFn={(h, key) => speed100mSeries(h, key)}
        yTitle="Wind speed (knots)" isDir={false}
      />
      )}
      {/* Boundary-layer height moved to the Stability tab. */}
      <ComparePanel
        title="10 m wind direction"
        point={point} hidden={hidden} cycles={cycles}
        seriesFn={(h) => h.wind_direction_10m || null}
        yTitle="Wind direction (°)" isDir
      />
    </div>
  )
}

export function ComparePanel({ title, point, seriesFn, yTitle, isDir, hidden, cycles, unit = 'kt', legend = false }) {
  const data = useMemo(() => {
    if (!point) return []
    const traces = []
    for (const key of COMPARE_ORDER) {
      if (hidden && hidden.has(key)) continue          // shared legend toggle
      const surf = point.surfaceByModel[key]
      if (!surf || !surf.hourly) continue
      const y = seriesFn(surf.hourly, key)
      if (!y) continue
      const name = labelWithCycle(key, cycles)
      traces.push({
        x: surf.hourly.time.map((t) => new Date(t)),
        y,
        type: 'scatter',
        mode: isDir ? 'markers' : 'lines+markers',
        name,
        line: { color: MODELS[key].color, width: 2 },
        marker: { color: MODELS[key].color, size: isDir ? 5 : 4 },
        connectgaps: true,
        // 'closest' hovermode -> this template shows ONLY the hovered model.
        hovertemplate: `<b>${name}</b><br>%{x|%a %d %H:%M}<br>` +
          (isDir ? '%{y:.0f}°' : (unit === 'm' ? '%{y:.0f} m' : '%{y:.1f} kt')) + '<extra></extra>',
      })
    }
    return traces
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point, isDir, cycles, hidden])

  // ±1σ shading across the visible model series (matches the forecast-deck
  // comparison band). For direction it uses CIRCULAR mean/σ so the band is
  // meaningful on the 0–360 axis (clipped to range near 0/360).
  const bandTraces = useMemo(() => {
    if (data.length < 2) return []
    const byT = new Map()
    for (const tr of data) {
      for (let i = 0; i < tr.x.length; i++) {
        const v = tr.y[i]; if (v == null || Number.isNaN(v)) continue
        const t = +tr.x[i]; if (!byT.has(t)) byT.set(t, []); byT.get(t).push(v)
      }
    }
    const ts = [...byT.keys()].sort((a, b) => a - b)
    const D2R = Math.PI / 180
    const x = [], lo = [], hi = []
    for (const t of ts) {
      const a = byT.get(t); if (a.length < 2) continue
      if (isDir) {
        let su = 0, sv = 0; for (const d of a) { su += Math.sin(d * D2R); sv += Math.cos(d * D2R) }
        const n = a.length; const mu = su / n, mv = sv / n
        const meanDir = ((Math.atan2(mu, mv) * 180 / Math.PI) + 360) % 360
        const R = Math.min(1, Math.hypot(mu, mv))
        const sd = R > 1e-6 ? Math.min(90, Math.sqrt(-2 * Math.log(R)) * 180 / Math.PI) : 90
        x.push(new Date(t)); lo.push(meanDir - sd); hi.push(meanDir + sd)
      } else {
        const m = a.reduce((s, v) => s + v, 0) / a.length
        const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length)
        x.push(new Date(t)); lo.push(m - sd); hi.push(m + sd)
      }
    }
    if (x.length < 2) return []
    return [
      { x, y: lo, type: 'scatter', mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, connectgaps: true },
      { x, y: hi, type: 'scatter', mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(150,160,180,0.18)', name: '±1σ', hoverinfo: 'skip', showlegend: false, connectgaps: true },
    ]
  }, [data, isDir])
  const nBand = bandTraces.length
  const allData = useMemo(() => [...bandTraces, ...data], [bandTraces, data])

  const layout = {
    // Open zoomed to the racing window; pan (drag) is the default tool, scroll to
    // zoom, and the data extends either side so you can pan to the full forecast.
    xaxis: { title: 'Time', type: 'date', range: localRacingWindow(), autorange: false },
    yaxis: {
      title: yTitle,
      rangemode: isDir ? 'normal' : 'tozero',
      ...(isDir ? { range: [0, 360], dtick: 45 } : {}),
    },
    dragmode: 'pan',
    hovermode: 'closest',          // single hovered series, not a unified all-models tooltip
    showlegend: legend,            // per-panel legend (used where there's no shared chip legend)
    ...(legend ? { legend: { orientation: 'h', y: -0.25, font: { size: 10 } } } : {}),
    margin: { t: 16, b: legend ? 70 : 48, l: 60, r: 20 },
  }

  // Highlight the hovered curve by thickening it only — leave every other
  // series exactly as it was (full opacity, normal width) so they all stay
  // clearly visible for comparison. Restore the hovered one on unhover.
  // The first nBand traces are the ±1σ band (width 0) — never thicken those.
  const onHover = useCallback((gd, e) => {
    const ci = e && e.points && e.points[0] && e.points[0].curveNumber
    if (ci == null || !window.Plotly) return
    const n = gd.data.length
    window.Plotly.restyle(gd, { 'line.width': Array.from({ length: n }, (_, i) => (i < nBand ? 0 : i === ci ? 4.5 : 2)) })
  }, [nBand])
  const onUnhover = useCallback((gd) => {
    if (!window.Plotly) return
    const n = gd.data.length
    window.Plotly.restyle(gd, { 'line.width': Array.from({ length: n }, (_, i) => (i < nBand ? 0 : 2)) })
  }, [nBand])

  return (
    <Card>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
        {title}
      </div>
      <PlotlyChart data={allData} layout={layout} height={320} onHover={onHover} onUnhover={onUnhover} config={{ doubleClick: 'reset' }} placeholder={`No model data for ${title.toLowerCase()}`} />
    </Card>
  )
}

function Card({ children }) {
  return (
    <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14 }}>
      {children}
    </div>
  )
}

const inputStyle = {
  background: '#071624', border: '1px solid #1E3A5A', borderRadius: 6,
  color: '#E2E8F0', padding: '5px 9px', fontSize: 12,
}

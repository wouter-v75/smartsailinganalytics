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
import { MODELS, COMPARE_ORDER, kmhToKnots, speed100mSeries, interpolateSpeedAtHeight, labelWithCycle, localForecastWindow } from './openMeteo'
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
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 10 }}>
            {present.map((k) => {
              const on = !hidden.has(k)
              const c = MODELS[k].color
              return (
                <button
                  key={k}
                  onClick={() => toggle(k)}
                  title={on ? 'click to hide' : 'click to show'}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                    border: `1px solid ${on ? c : '#33455C'}`,
                    background: on ? `${c}22` : 'transparent',
                    color: on ? '#E2E8F0' : '#64748B',
                    fontSize: 11, fontWeight: 600,
                    textDecoration: on ? 'none' : 'line-through',
                  }}
                >
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: on ? c : '#475569', flexShrink: 0 }} />
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
      <ComparePanel
        title="10 m wind direction"
        point={point} hidden={hidden} cycles={cycles}
        seriesFn={(h) => h.wind_direction_10m || null}
        yTitle="Wind direction (°)" isDir
      />
    </div>
  )
}

function ComparePanel({ title, point, seriesFn, yTitle, isDir, hidden, cycles }) {
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
          (isDir ? '%{y:.0f}°' : '%{y:.1f} kt') + '<extra></extra>',
      })
    }
    return traces
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point, isDir, cycles, hidden])

  const layout = {
    xaxis: { title: 'Time', type: 'date', range: localForecastWindow(2), autorange: false },
    yaxis: {
      title: yTitle,
      rangemode: isDir ? 'normal' : 'tozero',
      ...(isDir ? { range: [0, 360], dtick: 45 } : {}),
    },
    hovermode: 'closest',          // single hovered series, not a unified all-models tooltip
    showlegend: false,             // the shared chip legend above replaces per-panel legends
    margin: { t: 16, b: 48, l: 60, r: 20 },
  }

  // Highlight the hovered curve by thickening it only — leave every other
  // series exactly as it was (full opacity, normal width) so they all stay
  // clearly visible for comparison. Restore the hovered one on unhover.
  const onHover = useCallback((gd, e) => {
    const ci = e && e.points && e.points[0] && e.points[0].curveNumber
    if (ci == null || !window.Plotly) return
    const n = gd.data.length
    window.Plotly.restyle(gd, { 'line.width': Array.from({ length: n }, (_, i) => (i === ci ? 4.5 : 2)) })
  }, [])
  const onUnhover = useCallback((gd) => {
    if (!window.Plotly) return
    const n = gd.data.length
    window.Plotly.restyle(gd, { 'line.width': Array(n).fill(2) })
  }, [])

  return (
    <Card>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
        {title}
      </div>
      <PlotlyChart data={data} layout={layout} height={320} onHover={onHover} onUnhover={onUnhover} placeholder={`No model data for ${title.toLowerCase()}`} />
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

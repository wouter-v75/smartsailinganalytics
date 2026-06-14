// Model Comparison sub-tab — Phase 2c.
//
// One location at a time across all six fetched models (AROME / ECMWF / ICON
// plus high-res regionals DMI Harmonie / ItaliaMeteo / ARPEGE). Three panels:
//   1. 10 m wind speed
//   2. 100 m wind speed (ICON interpolated 80↔120 m)
//   3. 10 m wind direction
//
// The standalone tool calls this `createModelComparisonChart` (index.html
// line 1246). Same Plotly trace structure here, dark-themed via PlotlyChart.

import React, { useEffect, useMemo, useState } from 'react'
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
  const locKeys = Object.keys(windData)
  const [activeLoc, setActiveLoc] = useState(locKeys[0] || '1')
  useEffect(() => {
    // If the selected location was cleared in Forecast, pick the first
    // available one so the user isn't stuck on an empty selector.
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

  return (
    <div style={{ padding: '16px 20px 40px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0' }}>
            🔬 Model Comparison
          </span>
          <span style={{ fontSize: 11, color: '#64748B' }}>
            AROME · ECMWF · ICON · DMI Harmonie · ItaliaMeteo · ARPEGE — each drawn where it has coverage
          </span>
          <div style={{ flex: 1 }} />
          <label style={{ fontSize: 11, color: '#94A3B8', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span>Location</span>
            <select
              value={activeLoc}
              onChange={(e) => setActiveLoc(e.target.value)}
              style={inputStyle}
            >
              {locKeys.map((k) => {
                const meta = LOCATION_META.find((m) => m.key === k)
                return (
                  <option key={k} value={k}>
                    {meta?.emoji} Location {k}
                  </option>
                )
              })}
            </select>
          </label>
        </div>
      </Card>

      <ComparePanel
        title="10 m wind speed"
        point={point}
        seriesFn={(h) => h.wind_speed_10m ? h.wind_speed_10m.map((v) => v != null ? kmhToKnots(v) : null) : null}
        yTitle="Wind speed (knots)"
        isDir={false}
      />
      {canHeights && (
      <ComparePanel
        title={`⛵ Wind speed at mast height (${mastHeight} m)`}
        point={point}
        seriesFn={(h, key) => {
          if (!h || !h.time) return null
          const hgts = MODELS[key].heights
          return h.time.map((_, i) => {
            const v = interpolateSpeedAtHeight(h, hgts, mastHeight, i)
            return v != null ? kmhToKnots(v) : null
          })
        }}
        yTitle="Wind speed (knots)"
        isDir={false}
      />
      )}
      {spec && canMos && (
        <ComparePanel
          title={`✓ MOS-corrected mast-height wind (30 m) — ${venue.replace('_', ' ')}`}
          point={point}
          seriesFn={(h, key) => {
            const mosId = MODELS[key].mosModel
            if (!mosId) return null
            return mosSeries(h, MODELS[key].heights, spec, mosId, resolvedTz)
          }}
          yTitle="Wind speed (knots)"
          isDir={false}
        />
      )}
      {canHeights && (
      <ComparePanel
        title="100 m wind speed  (ICON interpolated 80↔120 m)"
        point={point}
        seriesFn={(h, key) => speed100mSeries(h, key)}
        yTitle="Wind speed (knots)"
        isDir={false}
      />
      )}
      <ComparePanel
        title="10 m wind direction"
        point={point}
        seriesFn={(h) => h.wind_direction_10m || null}
        yTitle="Wind direction (°)"
        isDir={true}
      />
    </div>
  )
}

function ComparePanel({ title, point, seriesFn, yTitle, isDir }) {
  const cycles = useModelCycles()
  const data = useMemo(() => {
    if (!point) return []
    const traces = []
    for (const key of COMPARE_ORDER) {
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
        hovertemplate: `<b>${name}</b><br>%{x|%a %d %H:%M}<br>` +
          (isDir ? '%{y:.0f}°' : '%{y:.1f} kt') + '<extra></extra>',
      })
    }
    return traces
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point, isDir, cycles])

  const layout = {
    // Fixed 2-day local window (00 today → 00 +2d); ignores any earlier data.
    xaxis: { title: 'Time', type: 'date', range: localForecastWindow(2), autorange: false },
    yaxis: {
      title: yTitle,
      rangemode: isDir ? 'normal' : 'tozero',
      ...(isDir ? { range: [0, 360], dtick: 45 } : {}),
    },
    hovermode: 'x unified',
    legend: { orientation: 'h', y: -0.18 },
    margin: { t: 20, b: 80, l: 60, r: 20 },
  }

  return (
    <Card>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
        {title}
      </div>
      <PlotlyChart data={data} layout={layout} height={320} placeholder={`No model data for ${title.toLowerCase()}`} />
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

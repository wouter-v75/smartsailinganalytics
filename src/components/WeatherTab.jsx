// Weather tab — native port of the standalone weather tool (v1.3 of
// weather.wvsailing.co.uk, source HTML in Smart Sailing Analytics/index.html).
//
// Phase 1: sub-tab shell + Forecast (map + tables + summary strip + charts).
// Phase 2: Compare sub-tab (6-model 48 h speed/dir for one location).
// Phase 3: Skew-T sounding (custom D3 port) — shipped.
// Phase 4: Skill Score / model verification (admin-only) — pending.
//
// Shared post-fetch state — windData / activeModel / resolvedTz — lives at
// THIS level so opening the Compare sub-tab after fetching in Forecast
// instantly renders without re-querying Open-Meteo. The input state
// (locations, date, etc.) stays inside ForecastView.

import React, { useState } from 'react'
import dynamic from 'next/dynamic'

const ForecastView = dynamic(() => import('./weather/ForecastView'), {
  ssr: false,
  loading: () => <TabLoading label="Loading forecast tools…" />,
})
const CompareView = dynamic(() => import('./weather/CompareView'), {
  ssr: false,
  loading: () => <TabLoading label="Loading compare view…" />,
})
const SoundingView = dynamic(() => import('./weather/SoundingView'), {
  ssr: false,
  loading: () => <TabLoading label="Loading sounding…" />,
})

const SUB_TABS = [
  { id: 'forecast',   label: 'Forecast',         enabled: true  },
  { id: 'compare',    label: 'Model Comparison', enabled: true  },
  { id: 'sounding',   label: 'Sounding',         enabled: true  },
  { id: 'skillscore', label: 'Skill Score',      enabled: false, badge: 'Phase 4', adminOnly: true },
]

export default function WeatherTab({ isMobile = false }) {
  const [sub, setSub] = useState('forecast')

  // Shared post-fetch state. Forecast emits updates via callbacks; Compare
  // reads them straight from here. Empty until the user clicks "Fetch wind
  // data" in Forecast.
  const [windData, setWindData] = useState({})
  const [activeModel, setActiveModel] = useState('AROME')
  const [resolvedTz, setResolvedTz] = useState('UTC')
  const [mastHeight, setMastHeight] = useState(20) // metres; interpolated masthead wind

  function handleDataChange(next, modelKey, tz) {
    setWindData(next)
    if (modelKey) setActiveModel(modelKey)
    if (tz) setResolvedTz(tz)
  }

  const hasData = Object.keys(windData).length > 0

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#030F1A',
        color: '#E2E8F0',
      }}
    >
      {/* Sub-tab chrome — same pattern as Campaign tab. */}
      <div
        style={{
          padding: isMobile ? '10px 12px' : '14px 20px 0',
          background: '#030F1A',
          borderBottom: '1px solid #1E3A5A',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 800, marginRight: 8 }}>🌦 Weather</span>
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => t.enabled && setSub(t.id)}
            disabled={!t.enabled}
            style={{
              padding: '7px 14px',
              borderRadius: 8,
              border: 'none',
              cursor: t.enabled ? 'pointer' : 'not-allowed',
              fontSize: 12,
              fontWeight: 700,
              background: sub === t.id ? '#06B6D4' : '#0F2A45',
              color: sub === t.id ? '#000' : t.enabled ? '#94A3B8' : '#475569',
              opacity: t.enabled ? 1 : 0.55,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
            title={!t.enabled ? `${t.badge} — not yet ported` : ''}
          >
            {t.label}
            {!t.enabled && (
              <span style={{ fontSize: 9, fontWeight: 700, color: '#7DD3FC', background: '#0A1929', border: '1px solid #1E3A5A', padding: '0 5px', borderRadius: 3 }}>
                {t.badge}
              </span>
            )}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {hasData && sub !== 'forecast' && (
          <span style={{ fontSize: 10, color: '#64748B' }}>
            data from {Object.keys(windData).length} location{Object.keys(windData).length === 1 ? '' : 's'}
          </span>
        )}
        <span style={{
          fontSize: 9, fontWeight: 700, color: '#F59E0B',
          background: '#0F2A45', border: '1px solid #1E3A5A',
          borderRadius: 4, padding: '2px 6px',
          letterSpacing: 0.5, textTransform: 'uppercase',
        }}>
          Admin preview
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sub === 'forecast' && (
          <ForecastView
            windData={windData}
            activeModel={activeModel}
            resolvedTz={resolvedTz}
            mastHeight={mastHeight}
            onMastHeightChange={setMastHeight}
            onDataChange={handleDataChange}
            onActiveModelChange={setActiveModel}
          />
        )}
        {sub === 'compare' && (
          <CompareView windData={windData} mastHeight={mastHeight} />
        )}
        {sub === 'sounding' && (
          <SoundingView windData={windData} resolvedTz={resolvedTz} />
        )}
      </div>
    </div>
  )
}

function TabLoading({ label }) {
  return (
    <div style={{ padding: 30, textAlign: 'center', color: '#475569', fontSize: 12 }}>
      {label || 'Loading…'}
    </div>
  )
}

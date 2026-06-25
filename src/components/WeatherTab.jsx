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

import React, { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { ModelCyclesProvider } from './weather/modelCycles'
import { getWeatherSession, patchWeatherSession } from './weather/weatherSession'

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
const VenueMOSView = dynamic(() => import('./weather/VenueMOSView'), {
  ssr: false,
  loading: () => <TabLoading label="Loading admin…" />,
})
const ChannelCurrents = dynamic(() => import('./weather/ChannelCurrents'), {
  ssr: false,
  loading: () => <TabLoading label="Loading currents…" />,
})

// Role hierarchy. MOS adjustments + Icon-Race require TL2 and up; Venue MOS is
// admin-only. Weather itself is open to every role.
const ROLE_RANK = { guest: 0, consultant: 1, tl1: 2, tl2: 3, tl3: 4, coach: 5, team_manager: 6, admin: 7 }

const SUB_TABS = [
  { id: 'forecast',   label: 'Forecast',         short: 'Forecast', enabled: true  },
  { id: 'compare',    label: 'Model Comparison', short: 'Models',   enabled: true  },
  { id: 'sounding',   label: 'Stability',        short: 'Stability', enabled: true  },
  { id: 'venuemos',   label: 'Admin',            short: 'Admin',    enabled: true, adminOnly: true },
]

export default function WeatherTab({ isMobile = false, effectiveRole = null, boatName = null, eventName = null }) {
  const isAdmin = effectiveRole === 'admin'
  const atLeastTL2 = (ROLE_RANK[effectiveRole] ?? -1) >= ROLE_RANK.tl2
  const canMos = atLeastTL2        // MOS adjustments (field button, table column, comparisons)
  const canIconRace = atLeastTL2   // Icon-Race model + data
  const canHeights = !['tl1', 'guest'].includes(effectiveRole) // above-10 m winds (tl1/guest see 10 m only)
  const subTabs = SUB_TABS.filter((t) => !t.adminOnly || isAdmin)

  const [sub, setSub] = useState('forecast')

  // Shared post-fetch state. Forecast emits updates via callbacks; Compare
  // reads them straight from here. Seeded from the module-level session store so
  // it survives leaving + returning to the Weather tab (WeatherTab unmounts on a
  // top-level tab switch); empty on the first visit of a fresh page load.
  const [windData, setWindData] = useState(() => getWeatherSession().windData)
  const [activeModel, setActiveModel] = useState(() => getWeatherSession().activeModel)
  const [resolvedTz, setResolvedTz] = useState(() => getWeatherSession().resolvedTz)
  const [mastHeight, setMastHeight] = useState(() => getWeatherSession().mastHeight) // metres; masthead wind (default 30 m)
  // Forecast input + wind-field state, lifted so the 3 points and the last 2D
  // wind/hpbl field survive sub-tab switches (ForecastView unmounts when hidden).
  const [forecastPersist, setForecastPersist] = useState(() => getWeatherSession().forecastPersist)

  // Mirror the shared state into the session store on every change, so a remount
  // (after visiting another top-level tab) re-seeds it instead of resetting.
  useEffect(() => {
    patchWeatherSession({ windData, activeModel, resolvedTz, mastHeight, forecastPersist })
  }, [windData, activeModel, resolvedTz, mastHeight, forecastPersist])

  function handleDataChange(next, modelKey, tz) {
    setWindData(next)
    if (modelKey) setActiveModel(modelKey)
    if (tz) setResolvedTz(tz)
  }

  const hasData = Object.keys(windData).length > 0

  return (
    <ModelCyclesProvider>
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
          padding: isMobile ? '6px 8px' : '14px 20px 0',
          background: '#030F1A',
          borderBottom: '1px solid #1E3A5A',
          display: 'flex',
          alignItems: 'center',
          gap: isMobile ? 5 : 8,
          flexWrap: isMobile ? 'nowrap' : 'wrap',
          overflowX: isMobile ? 'auto' : 'visible',
          flexShrink: 0,
        }}
      >
        {!isMobile && <span style={{ fontSize: 13, fontWeight: 800, marginRight: 8 }}>🌦 Weather</span>}
        {subTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => t.enabled && setSub(t.id)}
            disabled={!t.enabled}
            style={{
              padding: isMobile ? '5px 9px' : '7px 14px',
              borderRadius: 8,
              border: 'none',
              cursor: t.enabled ? 'pointer' : 'not-allowed',
              fontSize: isMobile ? 11 : 12,
              fontWeight: 700,
              whiteSpace: 'nowrap',
              background: sub === t.id ? '#06B6D4' : '#0F2A45',
              color: sub === t.id ? '#000' : t.enabled ? '#94A3B8' : '#475569',
              opacity: t.enabled ? 1 : 0.55,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
            title={!t.enabled ? `${t.badge} — not yet ported` : ''}
          >
            {isMobile ? (t.short || t.label) : t.label}
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
            persist={forecastPersist}
            onPersistChange={setForecastPersist}
            canMos={canMos}
            canIconRace={canIconRace}
            canHeights={canHeights}
            isAdmin={isAdmin}
            boatName={boatName}
            eventName={eventName}
            isMobile={isMobile}
          />
        )}
        {sub === 'compare' && (
          <CompareView windData={windData} mastHeight={mastHeight} resolvedTz={resolvedTz} canMos={canMos} canHeights={canHeights} />
        )}
        {sub === 'currents' && (
          <ChannelCurrents point1={forecastPersist?.locations?.['1']} />
        )}
        {sub === 'sounding' && (
          <SoundingView windData={windData} resolvedTz={resolvedTz} />
        )}
        {sub === 'venuemos' && isAdmin && (
          <VenueMOSView />
        )}
      </div>
    </div>
    </ModelCyclesProvider>
  )
}

function TabLoading({ label }) {
  return (
    <div style={{ padding: 30, textAlign: 'center', color: '#475569', fontSize: 12 }}>
      {label || 'Loading…'}
    </div>
  )
}

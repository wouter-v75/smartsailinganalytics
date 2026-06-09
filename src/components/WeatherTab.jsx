// Weather tab — native port of the standalone weather tool (v1.3 of
// weather.wvsailing.co.uk, source HTML in Smart Sailing Analytics/index.html).
//
// Architecture:
//   Phase 1 (this commit) — sub-tab shell + Forecast sub-tab end-to-end:
//      Leaflet map + 3-point picker, model checkboxes, surface model toggle,
//      hourly tables. No iframe. All deps lazy-loaded from CDN on tab open.
//   Phase 2 — Wind profile + Model Comparison sub-tab.
//   Phase 3 — Skew-T sounding (custom D3) sub-tab.
//   Phase 4 — Skill Score / model verification (admin-only sub-tab even
//      when Forecast gets relaxed to lower roles).
//
// Role gating:
//   Whole tab is admin-only today via the shell's `effectiveRole !== 'admin'`
//   check (see SmartSailingAnalytics_UI). The Skill Score sub-tab also
//   enforces admin internally so it stays gated when Forecast widens.

import React, { useState } from 'react'
import dynamic from 'next/dynamic'

const ForecastView = dynamic(() => import('./weather/ForecastView'), {
  ssr: false,
  loading: () => <TabLoading label="Loading forecast tools…" />,
})

const SUB_TABS = [
  { id: 'forecast',   label: 'Forecast',         enabled: true  },
  { id: 'compare',    label: 'Model Comparison', enabled: false, badge: 'Phase 2' },
  { id: 'sounding',   label: 'Sounding',         enabled: false, badge: 'Phase 3' },
  { id: 'skillscore', label: 'Skill Score',      enabled: false, badge: 'Phase 4', adminOnly: true },
]

export default function WeatherTab({ isMobile = false }) {
  const [sub, setSub] = useState('forecast')

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
        {sub === 'forecast' && <ForecastView />}
        {/* Future sub-tabs land here. */}
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

// Weather tab — admin-gated embed of the AROME / ECMWF / ICON wind-analysis
// tool (live at weather.wvsailing.co.uk).
//
// V1 strategy is an iframe so the tool keeps shipping from its own repo and
// auto-updates here. A native port (with proper React state + dark theming
// at the component level) replaces this once the integration brief in
// MODEL_VERIFICATION_PROPOSAL.md is implemented.
//
// Role gate is read at the call site (effectiveRole === 'admin' today,
// relaxable to a single ROLES[...].canSeeWeather flag later).
//
// Theme: dark frame to match the host SPA; the iframe interior stays the
// tool's own theme until ported.

import React, { useState } from 'react'

const WEATHER_URL = 'https://weather.wvsailing.co.uk'

export default function WeatherTab({ isMobile = false }) {
  const [loaded, setLoaded] = useState(false)
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
      {/* Mini header — keeps the tab consistent with Plan / Day / Backlog
          chrome (label + actions on the right). Hidden on mobile to free
          vertical space for the iframe. */}
      {!isMobile && (
        <div
          style={{
            padding: '10px 18px',
            borderBottom: '1px solid #1E3A5A',
            background: '#050E1C',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 800 }}>🌦 Weather tool</span>
          <span style={{ fontSize: 11, color: '#64748B' }}>
            AROME · ECMWF · ICON wind analysis
          </span>
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: '#F59E0B',
              background: '#0F2A45',
              border: '1px solid #1E3A5A',
              borderRadius: 4,
              padding: '1px 6px',
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            Admin preview
          </span>
          <div style={{ flex: 1 }} />
          <a
            href={WEATHER_URL}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 11,
              color: '#06B6D4',
              textDecoration: 'none',
              padding: '4px 10px',
              border: '1px solid #1E3A5A',
              borderRadius: 6,
              background: '#0A1929',
            }}
          >
            Open in new tab ↗
          </a>
        </div>
      )}

      {!loaded && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            color: '#475569',
            fontSize: 12,
            background: '#030F1A',
          }}
        >
          Loading wind analysis…
        </div>
      )}

      <iframe
        src={WEATHER_URL}
        title="AROME / ECMWF / ICON wind analysis"
        onLoad={() => setLoaded(true)}
        style={{
          flex: 1,
          width: '100%',
          border: 'none',
          background: '#030F1A',
        }}
        // Sandbox kept permissive — the tool runs on a sibling subdomain we
        // control. Tighten later if the native port is delayed.
        allow="geolocation; clipboard-read; clipboard-write"
      />
    </div>
  )
}

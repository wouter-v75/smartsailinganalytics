// Venue MOS sub-tab — the venue-by-venue MOS findings + per-model correction
// summary, read straight from the bundled mos_<venue>.json (no fetch needed).
// Mirrors the standalone mos_view_<venue>.html viewers.

import React, { useState } from 'react'
import { specFor } from './mos'
import { FINDINGS, GUIDANCE, VENUE_LABEL, VENUE_KEYS } from './venueNotes'

// MOS coefficients are keyed by Open-Meteo model id; show friendly labels.
const MODEL_LABEL = {
  meteofrance_arome_france_hd: 'AROME (1.5 km)',
  meteofrance_arpege_europe: 'ARPEGE (11 km)',
  icon_eu: 'ICON-EU',
  ecmwf_ifs025: 'ECMWF',
  gfs_seamless: 'GFS',
  italia_meteo_arpae_icon_2i: 'ICON-2I (Italy 2 km)',
}
const fmt = (v, s = '') => (v == null || Number.isNaN(v) ? '–' : `${v}${s}`)

export default function VenueMOSView() {
  const [venue, setVenue] = useState('sorrento')
  const spec = specFor(venue)
  const f = FINDINGS[venue]
  const models = spec ? Object.entries(spec.models) : []
  const bands = spec?.bands || []

  return (
    <div style={{ padding: '16px 20px 40px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0' }}>📐 Venue MOS</span>
          <span style={{ fontSize: 11, color: '#64748B' }}>
            How each model is corrected to mast-height (30 m) TWS at this venue
          </span>
          <div style={{ flex: 1 }} />
          <label style={{ fontSize: 11, color: '#94A3B8', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span>Venue</span>
            <select value={venue} onChange={(e) => setVenue(e.target.value)} style={inputStyle}>
              {VENUE_KEYS.map((k) => <option key={k} value={k}>{VENUE_LABEL[k]}</option>)}
            </select>
          </label>
        </div>
      </Card>

      {/* Findings */}
      <Card>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#34D399', marginBottom: 8 }}>
          Findings — {VENUE_LABEL[venue]}
        </div>
        {f && (
          <div style={{ fontSize: 13, color: '#CBD5E1', lineHeight: 1.55, display: 'flex', flexDirection: 'column', gap: 7 }}>
            <Line label="Regime" text={f.regime} />
            <Line label="Directional zones" text={f.zones} />
            <Line label="Best MOS" text={f.best} />
            <Line label="Recommendation" text={f.rec} />
            <div style={{ borderTop: '1px solid #1E3A5A', marginTop: 4, paddingTop: 8, color: '#94A3B8' }}>
              <b style={{ color: '#7DD3FC' }}>Choosing the MOS type:</b> {GUIDANCE}
            </div>
          </div>
        )}
      </Card>

      {/* Per-model correction summary */}
      <Card>
        <ChartTitle>Per-model correction (cross-validated)</ChartTitle>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={thL}>Model</th>
                <th style={th}>Correction</th>
                <th style={th}>Dir agree</th>
                <th style={th}>Raw RMSE</th>
                <th style={th}>MOS RMSE</th>
                <th style={th}>Reduction</th>
                <th style={th}>n</th>
              </tr>
            </thead>
            <tbody>
              {models.map(([id, m]) => {
                const best = m.best || m.type || 'raw'
                const isWin = best !== 'raw'
                return (
                  <tr key={id}>
                    <td style={tdL}>{MODEL_LABEL[id] || id}</td>
                    <td style={{ ...td, color: isWin ? '#34D399' : '#64748B', fontWeight: isWin ? 700 : 400 }}>
                      {best}
                    </td>
                    <td style={td}>{m.sector_agreement != null ? `${Math.round(m.sector_agreement * 100)}%` : '–'}</td>
                    <td style={td}>{fmt(m.raw_rmse)}</td>
                    <td style={{ ...td, color: isWin ? '#34D399' : '#E2E8F0', fontWeight: 700 }}>{fmt(m.cv_rmse)}</td>
                    <td style={td}>{m.reduction_pct != null ? fmt(m.reduction_pct, '%') : '–'}</td>
                    <td style={td}>{fmt(m.n)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: '#64748B', marginTop: 8 }}>
          RMSE in knots, leave-one-regatta-out cross-validated. “raw” = no correction beats the raw model (shipped uncorrected).
          {bands.length > 0 && (
            <> Sector bands: {bands.map((b) => `${b[0]} (${b[1]}–${b[2]}°)`).join(', ')}.</>
          )}
        </div>
      </Card>
    </div>
  )
}

function Line({ label, text }) {
  return (
    <div><b style={{ color: '#7DD3FC' }}>{label}:</b> {text}</div>
  )
}

function ChartTitle({ children }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
      {children}
    </div>
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
const th = { padding: '6px 8px', textAlign: 'right', color: '#94A3B8', fontWeight: 600, fontSize: 11, borderBottom: '1px solid #1E3A5A' }
const thL = { ...th, textAlign: 'left' }
const td = { padding: '5px 8px', textAlign: 'right', color: '#E2E8F0', fontFamily: 'monospace', borderBottom: '1px solid #0F2030' }
const tdL = { ...td, textAlign: 'left', fontFamily: 'inherit' }

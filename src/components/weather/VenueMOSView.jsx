// Venue MOS sub-tab — the venue-by-venue MOS findings + per-model correction
// summary, read straight from the bundled mos_<venue>.json (no fetch needed).
// Mirrors the standalone mos_view_<venue>.html viewers.

import React, { useState } from 'react'
import { specFor } from './mos'
import { FINDINGS, GUIDANCE, VENUE_LABEL, VENUE_KEYS } from './venueNotes'
import { modelRows, columnsFor, truthLine, cvScheme, heightNote } from './mosSpecRows'
import ModelUpdates from './ModelUpdates'

// MOS coefficients are keyed by Open-Meteo model id; show friendly labels.
// The Pacific and Nordic ids were missing, so those venues showed raw keys.
const MODEL_LABEL = {
  meteofrance_arome_france_hd: 'AROME (1.5 km)',
  meteofrance_arpege_europe: 'ARPEGE (11 km)',
  icon_eu: 'ICON-EU',
  ecmwf_ifs025: 'ECMWF',
  gfs_seamless: 'GFS',
  italia_meteo_arpae_icon_2i: 'ICON-2I (Italy 2 km)',
  gfs_hrrr: 'HRRR (3 km)',
  ncep_nam_conus: 'NAM (CONUS 5 km)',
  gfs_global: 'GFS (global)',
  icon_global: 'ICON global (13 km)',
  gem_hrdps_continental: 'HRDPS (2.5 km)',
  metno_nordic: 'MET Nordic (1 km)',
}
const fmt = (v, s = '') => (v == null || Number.isNaN(v) ? '–' : `${v}${s}`)

export default function VenueMOSView() {
  const [venue, setVenue] = useState('sorrento')
  const spec = specFor(venue)
  const f = FINDINGS[venue]
  //  Read through mosSpecRows, NOT straight off spec.models: three generations
  //  of spec write three different names for the same numbers, and reading one
  //  of them is why San Juan and Long Beach showed a dash in every column.
  const rows = modelRows(spec)
  //  Only draw a column some row can fill. A column of pure dashes reads as
  //  missing data when the honest statement is that the measure does not exist
  //  at this venue — "Dir agree" needs a boat heading, which a station has not.
  const cols = columnsFor(rows)
  const has = (c) => cols.includes(c)
  const bands = spec?.bands || []
  const truth = truthLine(spec)

  return (
    <div style={{ padding: '16px 20px 40px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Live model-freshness overview (Open-Meteo metas + Icon-Race pipeline). */}
      <ModelUpdates />

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0' }}>📐 Venue MOS</span>
          <span style={{ fontSize: 11, color: '#8A97A9' }}>
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
        {truth && (
          <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: f ? 10 : 0, lineHeight: 1.5 }}>
            <b style={{ color: '#7DD3FC' }}>Truth:</b> {truth}
          </div>
        )}
        {!f && (
          <div style={{ fontSize: 13, color: '#CBD5E1', lineHeight: 1.55 }}>
            No written findings for this venue yet — the table below is the measurement.
          </div>
        )}
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
                <th style={th}>Gain</th>
                {has('holds') && <th style={th}>Holds every block</th>}
                {has('rawRmse') && <th style={th}>Raw RMSE</th>}
                {has('cvRmse') && <th style={th}>MOS RMSE</th>}
                {has('agree') && <th style={th}>Dir agree</th>}
                {has('n') && <th style={th}>n</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isWin = !r.isRaw && !r.notApplied
                return (
                  <React.Fragment key={r.id}>
                    <tr>
                      <td style={tdL}>
                        {MODEL_LABEL[r.id] || r.id}
                        {r.slopeConstrained && (
                          <span title="slope pinned at 1 to protect the strong-wind tail"
                                style={{ color: '#7DD3FC', fontSize: 10, marginLeft: 5 }}>a=1</span>
                        )}
                      </td>
                      <td style={{ ...td, color: isWin ? '#34D399' : '#64748B', fontWeight: isWin ? 700 : 400 }}>
                        {r.best}
                      </td>
                      <td style={td}>{r.gainPct != null ? fmt(r.gainPct, '%') : '–'}</td>
                      {has('holds') && (
                        <td style={{ ...td, color: r.holds === false ? '#F59E0B' : '#94A3B8' }}>
                          {r.holds == null ? '–' : r.holds ? 'yes' : 'NO'}
                        </td>
                      )}
                      {has('rawRmse') && <td style={td}>{fmt(r.rawRmse)}</td>}
                      {has('cvRmse') && (
                        <td style={{ ...td, color: isWin ? '#34D399' : '#E2E8F0', fontWeight: 700 }}>{fmt(r.cvRmse)}</td>
                      )}
                      {has('agree') && (
                        <td style={td}>{r.agree != null ? `${Math.round(r.agree * 100)}%` : '–'}</td>
                      )}
                      {has('n') && (
                        //  nEff on the hover, because a big n here is misleading on
                        //  its own: an hourly series' autocorrelation makes 36,000
                        //  hours behave like some 8,500 independent samples, and the
                        //  bars are measured on that, not on n.
                        <td style={td} title={r.nEff != null ? `effective n ${r.nEff} after autocorrelation` : undefined}>
                          {fmt(r.n)}{r.blocks != null ? <span style={{ color: '#64748B' }}>{` / ${r.blocks}`}</span> : null}
                          {r.nEff != null && <span style={{ color: '#64748B' }}>{` · eff ${r.nEff}`}</span>}
                        </td>
                      )}
                    </tr>
                    {/* A model whose coefficients are stored but unreachable must
                        say so on the row: otherwise the table advertises a gain
                        that can never fire, which is the one way this panel can
                        mislead rather than merely omit. */}
                    {r.notApplied && (
                      <tr>
                        <td colSpan={3 + cols.length} style={{ ...tdL, color: '#F59E0B', fontSize: 11, paddingTop: 0, borderTop: 'none' }}>
                          NOT APPLIED — {r.notApplied}
                        </td>
                      </tr>
                    )}
                    {r.why && !r.notApplied && (
                      <tr>
                        <td colSpan={3 + cols.length} style={{ ...tdL, color: '#8A97A9', fontSize: 11, paddingTop: 0, borderTop: 'none' }}>
                          {r.why}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: '#8A97A9', marginTop: 8, lineHeight: 1.6 }}>
          RMSE in knots, {cvScheme(spec)}. “raw” = no correction cleared the bars, so the model
          ships uncorrected. <b>n</b> is paired samples / held-out blocks. {heightNote(spec)}
          {bands.length > 0 && (
            <> Sector bands: {bands.map((b) => `${b[0]} (${b[1]}–${b[2]}°)`).join(', ')}.</>
          )}
          {rows.some((r) => r.missing.includes('rmse')) && (
            <> The RMSE columns are empty for this venue because its fitting script recorded the
              gain and not the two rmse values — the gain IS the measurement, cross-validated.</>
          )}
          {!has('agree') && (
            <> No “Dir agree” column: it counts how often the model put the wind in the band the
              BOAT was in, and a fixed-station truth has no heading to agree with.</>
          )}
          {!has('holds') && (
            <> No “Holds every block” column: this venue’s fitting script enforced that bar without
              recording it — a form that failed it was written as “raw”, so a shipped correction
              passed it.</>
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

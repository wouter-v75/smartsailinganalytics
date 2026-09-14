'use client'
// src/components/analytics/LidarTables.jsx
// ─────────────────────────────────────────────────────────────────────────────
// KND-style lidar sail-shape report (lib/lidarTables): per sail, measured camber /
// draft / twist against the logged targets — by mode, tack and sail, overall, by point
// of sail, and every lidar phase tagged with its sails — filtered on the main / jib /
// spinnaker in use during the captures, with KND's filters noted under the tables.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { lidarTables, lidarSailOptions, formatLidarCell, lidarTableToTsv } from '../../lib/lidarTables'

const th = {
  padding: '5px 8px', color: '#64748B', fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap',
  borderBottom: '1px solid #1E3A5A', textAlign: 'right', background: '#071624',
}
const td = { padding: '4px 8px', fontFamily: 'monospace', fontSize: 11, color: '#CBD5E1', textAlign: 'right', whiteSpace: 'nowrap' }
const btn = on => ({
  fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
  border: `1px solid ${on ? '#06B6D4' : '#1E3A5A'}`, background: on ? '#06B6D420' : '#071624', color: on ? '#06B6D4' : '#94A3B8',
})
const select = { background: '#071624', border: '1px solid #1E3A5A', borderRadius: 6, padding: '4px 8px', color: '#E2E8F0', fontSize: 11, cursor: 'pointer' }
const KINDS = [['mn', 'Main', 'mains'], ['jib', 'Jib', 'jibs'], ['spi', 'Spinnaker', 'spinnakers']]
const leftAligned = f => f === 'text' || f === 'time'

function LidarTable({ table, tzOffsetMin = 0, onRowClick = null }) {
  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(lidarTableToTsv(table, tzOffsetMin)); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* blocked */ }
  }
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#CBD5E1' }}>{table.title}</div>
        <button onClick={copy} style={{
          marginLeft: 'auto', fontSize: 9, borderRadius: 3, padding: '2px 7px', cursor: 'pointer',
          color: copied ? '#22C55E' : '#94A3B8', background: '#071624', border: '1px solid #1E3A5A',
        }}>{copied ? '✓ Copied' : 'Copy for Excel'}</button>
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid #1E3A5A', borderRadius: 8 }}>
        <table data-lidar={table.id} style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>{table.columns.map((c, i) => <th key={i} style={{ ...th, textAlign: leftAligned(c.format) ? 'left' : 'right' }}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {table.rows.map((r, i) => (
              <tr key={i} onClick={onRowClick ? () => onRowClick(r) : undefined}
                title={onRowClick ? 'Jump to this phase' : undefined}
                style={{ background: i % 2 ? '#071624' : 'transparent', cursor: onRowClick ? 'pointer' : 'default' }}>
                {r.map((v, j) => {
                  const f = table.columns[j].format
                  const gap = table.columns[j].label.startsWith('d') || f === 'pct1'
                  const color = v == null ? '#475569' : gap && typeof v === 'number' ? (v > 0 ? '#FBBF24' : v < 0 ? '#7DD3FC' : td.color) : f === 'text' ? '#E2E8F0' : td.color
                  return (
                    <td key={j} style={{ ...td, textAlign: leftAligned(f) ? 'left' : 'right', fontFamily: f === 'text' ? 'inherit' : 'monospace', color }}>
                      {formatLidarCell(v, f, '', tzOffsetMin)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function LidarTables({ stats: allStats, sails, xmlData = null, tzOffsetMin = 0, onJump = null }) {
  const [sail, setSail] = React.useState(sails[0]?.sail)
  const [picked, setPicked] = React.useState({})          // sail kind → sail name ('' = all)
  const [tack, setTack] = React.useState('')              // '' = both, 'port', 'stbd'
  const [showPhases, setShowPhases] = React.useState(false)
  const current = sails.find(s => s.sail === sail) || sails[0]
  if (!current) return null
  const stats = tack ? allStats.filter(p => p.tack === tack) : allStats

  // The mains / jibs / spinnakers in use during this sail's lidar captures. A pick that is not
  // among them (another day, another sail tab) counts as "all".
  const filters = KINDS
    .map(([kind, label, plural]) => ({ kind, label, plural, options: lidarSailOptions(stats, kind, xmlData, current.sail) }))
    .filter(f => f.options.length > 0)
  const filter = Object.fromEntries(filters.map(f => [f.kind, f.options.some(o => o.name === picked[f.kind]) ? picked[f.kind] : null]))
  const [byModeTack, overall, byPoint, phases] = lidarTables(stats, current.sail, { xml: xmlData, filter })

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        {sails.map(s => (
          <button key={s.sail} onClick={() => setSail(s.sail)} aria-pressed={s.sail === current.sail} style={btn(s.sail === current.sail)}>
            {s.label}
          </button>
        ))}
        <span style={{ width: 1, height: 18, background: '#1E3A5A', margin: '0 4px' }} />
        {[['', 'Both tacks'], ['port', 'Port'], ['stbd', 'Stbd']].map(([t, label]) => (
          <button key={label} onClick={() => setTack(t)} aria-pressed={tack === t} aria-label={`${label === 'Both tacks' ? label : `${label} tack`} lidar`}
            style={{ ...btn(tack === t), fontWeight: 600 }}>
            {label}
          </button>
        ))}
        {filters.length > 0 && <span style={{ width: 1, height: 18, background: '#1E3A5A', margin: '0 4px' }} />}
        {filters.map(f => (
          <label key={f.kind} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: '#64748B' }}>
            {f.label}
            <select aria-label={`${f.label} sail filter`} value={filter[f.kind] || ''} style={select}
              onChange={e => setPicked(p => ({ ...p, [f.kind]: e.target.value }))}>
              <option value="">All {f.plural}</option>
              {f.options.map(o => <option key={o.name} value={o.name}>{o.name} · {o.n} phase{o.n === 1 ? '' : 's'}</option>)}
            </select>
          </label>
        ))}
      </div>
      <LidarTable table={byModeTack} />
      <LidarTable table={overall} />
      <LidarTable table={byPoint} />
      <div style={{ marginBottom: 14 }}>
        <button onClick={() => setShowPhases(s => !s)} aria-expanded={showPhases} style={{ ...btn(showPhases), fontWeight: 600, marginBottom: showPhases ? 8 : 0 }}>
          {showPhases ? '▾' : '▸'} Every lidar phase with its sails · {phases.rows.length}
        </button>
        {showPhases && (
          <LidarTable table={phases} tzOffsetMin={tzOffsetMin} onRowClick={onJump ? r => onJump(r[0]) : null} />
        )}
      </div>
      <div style={{ fontSize: 9, color: '#475569', lineHeight: 1.5 }}>
        dXX = measured minus target (amber: fuller / further aft / more twist than target). Samples outside CA 0–20, DR 20–80,
        TW 0–60 are ignored before each 30 s phase is averaged (min 5 valid samples). A target below CA 3 / DR 20 / TW 2 means the
        target channel is not tracking — that phase is dropped. Outliers removed by 1.5 × IQR on the per-phase % gaps. Blank / n/a =
        fewer than 2 valid phases. % Diff is the average of the per-phase gaps, not the difference of the two averages. Sails are
        the ones up at the middle of each phase, from the event file’s sail changes.
      </div>
    </div>
  )
}

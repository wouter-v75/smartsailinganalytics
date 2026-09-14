'use client'
// src/components/analytics/LidarTables.jsx
// ─────────────────────────────────────────────────────────────────────────────
// KND-style lidar sail-shape report (lib/lidarTables): per sail, measured camber /
// draft / twist against the logged targets — by mode and tack, overall and by point
// of sail — with KND's filters noted under the tables.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { lidarTables, formatLidarCell, lidarTableToTsv } from '../../lib/lidarTables'

const th = {
  padding: '5px 8px', color: '#64748B', fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap',
  borderBottom: '1px solid #1E3A5A', textAlign: 'right', background: '#071624',
}
const td = { padding: '4px 8px', fontFamily: 'monospace', fontSize: 11, color: '#CBD5E1', textAlign: 'right', whiteSpace: 'nowrap' }
const btn = on => ({
  fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
  border: `1px solid ${on ? '#06B6D4' : '#1E3A5A'}`, background: on ? '#06B6D420' : '#071624', color: on ? '#06B6D4' : '#94A3B8',
})

function LidarTable({ table }) {
  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(lidarTableToTsv(table)); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* blocked */ }
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
            <tr>{table.columns.map((c, i) => <th key={i} style={{ ...th, textAlign: c.format === 'text' ? 'left' : 'right' }}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {table.rows.map((r, i) => (
              <tr key={i} style={{ background: i % 2 ? '#071624' : 'transparent' }}>
                {r.map((v, j) => {
                  const f = table.columns[j].format
                  const gap = table.columns[j].label.startsWith('d') || f === 'pct1'
                  const color = v == null ? '#475569' : gap && typeof v === 'number' ? (v > 0 ? '#FBBF24' : v < 0 ? '#7DD3FC' : td.color) : f === 'text' ? '#E2E8F0' : td.color
                  return <td key={j} style={{ ...td, textAlign: f === 'text' ? 'left' : 'right', fontFamily: f === 'text' ? 'inherit' : 'monospace', color }}>{formatLidarCell(v, f)}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function LidarTables({ stats, sails }) {
  const [sail, setSail] = React.useState(sails[0]?.sail)
  const current = sails.find(s => s.sail === sail) || sails[0]
  if (!current) return null
  const tables = lidarTables(stats, current.sail)
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {sails.map(s => (
          <button key={s.sail} onClick={() => setSail(s.sail)} aria-pressed={s.sail === current.sail} style={btn(s.sail === current.sail)}>
            {s.label}
          </button>
        ))}
      </div>
      {tables.map(t => <LidarTable key={t.id} table={t} />)}
      <div style={{ fontSize: 9, color: '#475569', lineHeight: 1.5 }}>
        dXX = measured minus target (amber: fuller / further aft / more twist than target). Samples outside CA 0–20, DR 20–80,
        TW 0–60 are ignored before each 30 s phase is averaged (min 5 valid samples). A target below CA 3 / DR 20 / TW 2 means the
        target channel is not tracking — that phase is dropped. Outliers removed by 1.5 × IQR on the per-phase gaps. Blank / n/a =
        fewer than 2 valid phases. % Diff is the average of the per-phase gaps, not the difference of the two averages.
      </div>
    </div>
  )
}

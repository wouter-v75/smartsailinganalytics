'use client'
// src/components/analytics/ReportTable.jsx
// ─────────────────────────────────────────────────────────────────────────────
// One KND-style report table (lib/reportTables): group columns (sails, tack, band),
// n, then the channel means / maxima. Scrolls sideways on narrow screens; "Copy"
// puts it on the clipboard tab-separated for Excel.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { GROUP_LABELS, groupCellText, formatCell, tableToTsv } from '../../lib/reportTables'

const TACK_MARK = { port: { mark: '▲', color: '#7DD3FC' }, stbd: { mark: '●', color: '#10B981' } }

const th = {
  padding: '5px 8px', color: '#64748B', fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap',
  borderBottom: '1px solid #1E3A5A', textAlign: 'right', background: '#071624',
}
const td = { padding: '4px 8px', fontFamily: 'monospace', fontSize: 11, color: '#CBD5E1', textAlign: 'right', whiteSpace: 'nowrap' }

export default function ReportTable({ table }) {
  const [copied, setCopied] = React.useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tableToTsv(table))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked — nothing to do */ }
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#CBD5E1' }}>{table.title}</div>
        <span style={{ fontSize: 9, color: '#475569' }}>{table.total} phases</span>
        <button onClick={copy} style={{
          marginLeft: 'auto', fontSize: 9, borderRadius: 3, padding: '2px 7px', cursor: 'pointer',
          color: copied ? '#22C55E' : '#94A3B8', background: '#071624', border: '1px solid #1E3A5A',
        }}>{copied ? '✓ Copied' : 'Copy for Excel'}</button>
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid #1E3A5A', borderRadius: 8 }}>
        <table data-report={table.id} style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              {table.by.map(k => <th key={k} style={{ ...th, textAlign: 'left' }}>{GROUP_LABELS[k]}</th>)}
              <th style={th}>n</th>
              {table.columns.map(c => <th key={`${c.key}-${c.stat}`} style={th}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r, i) => (
              <tr key={i} style={{ background: i % 2 ? '#071624' : 'transparent' }}>
                {table.by.map(k => {
                  const tack = k === 'tack' ? TACK_MARK[r.key[k]] : null
                  return (
                    <td key={k} style={{ ...td, fontFamily: 'inherit', textAlign: 'left', color: tack ? tack.color : '#E2E8F0' }}>
                      {tack && <span style={{ marginRight: 4 }}>{tack.mark}</span>}
                      {groupCellText(k, r.key[k])}
                    </td>
                  )
                })}
                <td style={{ ...td, color: '#94A3B8' }}>{r.n}</td>
                {r.values.map((v, j) => <td key={j} style={td}>{formatCell(v, table.columns[j].decimals)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

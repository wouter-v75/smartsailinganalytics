'use client'
// src/components/analytics/ManoeuvreTable.jsx
// ─────────────────────────────────────────────────────────────────────────────
// KND-style tack or gybe table (lib/manoeuvres): one row per manoeuvre, an AVERAGE
// row over the judged ones (racing, not mark roundings). Click a row to jump to it;
// "Copy for Excel" puts the table on the clipboard tab-separated.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { manoeuvreAverages, manoeuvreNote, isJudged } from '../../lib/manoeuvres'

const TACK = { port: { mark: '▲', label: 'Port', color: '#7DD3FC' }, stbd: { mark: '●', label: 'Stbd', color: '#10B981' } }
const COLUMNS = [
  { key: 'timeTo95', label: 'Time to 95% BSP (s)', decimals: 0 },
  { key: 'distLost', label: 'Dist lost vs wind (m)', decimals: 1 },
  { key: 'maxRotation', label: 'Max rotation (deg/s)', decimals: 1 },
  { key: 'bspBefore', label: 'BSP before (kn)', decimals: 2 },
  { key: 'bspAfter', label: 'BSP at +20 s (kn)', decimals: 2 },
  { key: 'turnAngle', label: 'Turn angle (deg)', decimals: 1 },
]
const hms = (utc, tz) => new Date(utc + (tz || 0) * 60000).toISOString().slice(11, 19)
const fmt = (v, d) => (v == null ? 'n/a' : v.toFixed(d).replace(/^-(0(\.0+)?)$/, '$1'))

const th = {
  padding: '5px 8px', color: '#64748B', fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap',
  borderBottom: '1px solid #1E3A5A', textAlign: 'right', background: '#071624',
}
const td = { padding: '4px 8px', fontFamily: 'monospace', fontSize: 11, color: '#CBD5E1', textAlign: 'right', whiteSpace: 'nowrap' }

export default function ManoeuvreTable({ id, title, list, tzOffsetMin = 0, onJump = null, raceLabel = r => `Race ${r}` }) {
  const [copied, setCopied] = React.useState(false)
  const judged = list.filter(isJudged)
  const avg = manoeuvreAverages(judged)

  const tsv = () => {
    const head = ['Time', 'Race', 'Sails', 'From', 'To', ...COLUMNS.map(c => c.label), 'Target (deg)', 'Note']
    const line = m => [hms(m.utc, tzOffsetMin), m.race ? raceLabel(m.race) : '', m.sails, TACK[m.from]?.label || '', TACK[m.to]?.label || '',
      ...COLUMNS.map(c => fmt(m[c.key], c.decimals)), String(m.target), manoeuvreNote(m)]
    const avgLine = ['AVERAGE', '', '', '', '', ...COLUMNS.map(c => fmt(avg[c.key], c.decimals)), String(list[0]?.target ?? ''), `${judged.length} judged`]
    return [head, ...list.map(line), avgLine].map(l => l.join('\t')).join('\n')
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(tsv()); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* blocked */ }
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#CBD5E1' }}>{title}</div>
        <span style={{ fontSize: 9, color: '#475569' }}>{judged.length} judged{list.length > judged.length ? ` · ${list.length - judged.length} shown for context` : ''}</span>
        <button onClick={copy} style={{
          marginLeft: 'auto', fontSize: 9, borderRadius: 3, padding: '2px 7px', cursor: 'pointer',
          color: copied ? '#22C55E' : '#94A3B8', background: '#071624', border: '1px solid #1E3A5A',
        }}>{copied ? '✓ Copied' : 'Copy for Excel'}</button>
      </div>
      {list.length ? (
        <div style={{ overflowX: 'auto', border: '1px solid #1E3A5A', borderRadius: 8 }}>
          <table data-manoeuvres={id} style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Time</th>
                <th style={{ ...th, textAlign: 'left' }}>Race</th>
                <th style={{ ...th, textAlign: 'left' }}>Sails</th>
                <th style={{ ...th, textAlign: 'left' }}>From → To</th>
                {COLUMNS.map(c => <th key={c.key} style={th}>{c.label}</th>)}
                <th style={th}>Target (deg)</th>
                <th style={{ ...th, textAlign: 'left' }}>Note</th>
              </tr>
            </thead>
            <tbody>
              {list.map((m, i) => {
                const dim = !isJudged(m)
                return (
                  <tr key={m.utc} data-utc={m.utc} onClick={onJump ? () => onJump(m.utc) : undefined}
                    style={{ background: i % 2 ? '#071624' : 'transparent', opacity: dim ? 0.5 : 1, cursor: onJump ? 'pointer' : 'default' }}>
                    <td style={{ ...td, textAlign: 'left', color: '#E2E8F0' }}>{hms(m.utc, tzOffsetMin)}</td>
                    <td style={{ ...td, textAlign: 'left', fontFamily: 'inherit' }}>{m.race ? raceLabel(m.race) : ''}</td>
                    <td style={{ ...td, textAlign: 'left', fontFamily: 'inherit' }}>{m.sails}</td>
                    <td style={{ ...td, textAlign: 'left', fontFamily: 'inherit' }}>
                      {[m.from, m.to].map((t, k) => (
                        <span key={k} style={{ color: TACK[t]?.color || '#64748B' }}>{k ? ' → ' : ''}{TACK[t] ? `${TACK[t].mark} ${TACK[t].label}` : '?'}</span>
                      ))}
                    </td>
                    {COLUMNS.map(c => <td key={c.key} style={{ ...td, color: m[c.key] == null ? '#475569' : td.color }}>{fmt(m[c.key], c.decimals)}</td>)}
                    <td style={{ ...td, color: '#94A3B8' }}>{m.target}</td>
                    <td style={{ ...td, textAlign: 'left', fontFamily: 'inherit', color: '#94A3B8' }}>{manoeuvreNote(m)}</td>
                  </tr>
                )
              })}
              <tr data-average style={{ borderTop: '1px solid #1E3A5A' }}>
                <td style={{ ...td, textAlign: 'left', fontWeight: 700, color: '#E2E8F0' }} colSpan={4}>AVERAGE · {judged.length} judged</td>
                {COLUMNS.map(c => <td key={c.key} style={{ ...td, fontWeight: 700, color: '#E2E8F0' }}>{fmt(avg[c.key], c.decimals)}</td>)}
                <td style={{ ...td, color: '#94A3B8' }}>{list[0]?.target}</td>
                <td style={td} />
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ padding: '10px 12px', background: '#071624', borderRadius: 8, color: '#64748B', fontSize: 11 }}>None.</div>
      )}
    </div>
  )
}

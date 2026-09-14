'use client'
// src/components/analytics/StartSection.jsx
// ─────────────────────────────────────────────────────────────────────────────
// KND-style Starts tab (lib/startAnalysis): per start gun, what the boat had at the gun
// and 30 s later, the track against the start line (full log), distance to line and
// BSP_trg% over the run-in, and the 5 s table — click a row to jump to it.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { startAnalyses } from '../../lib/startAnalysis'
import { inRange } from '../../lib/trackSelection'

const COLS = [
  { key: 'distLn', label: 'DistLn (BL)', d: 1 },
  { key: 'bspTrgPct', label: 'BSP_trg%', d: 1, pct: true },
  { key: 'twa', label: 'TWA', d: 1 },
  { key: 'dTwaTrg', label: 'ΔTwaTrg', d: 1 },
  { key: 'vmgPct', label: 'VMG%', d: 1, pct: true },
  { key: 'bsp', label: 'BSP (kn)', d: 2 },
  { key: 'rudder', label: 'Rudder', d: 1 },
  { key: 'burn', label: 'Burn (s)', d: 1 },
  { key: 'twd', label: 'TWD', d: 0 },
  { key: 'tws', label: 'TWS (kn)', d: 1 },
]
const WINDOWS = [[-120, '−2:00'], [-180, '−3:00'], [-300, '−5:00']]

const fmtT = t => `${t < 0 ? '−' : '+'}${String(Math.floor(Math.abs(t) / 60)).padStart(2, '0')}:${String(Math.abs(t) % 60).padStart(2, '0')}`
const hms = (utc, tz) => new Date(utc + (tz || 0) * 60000).toISOString().slice(11, 19)
const fmt = (v, d) => (v == null ? '' : v.toFixed(d).replace(/^-(0(\.0+)?)$/, '$1'))
const pctBg = v => (v == null ? 'transparent' : v >= 95 ? '#15803D40' : v >= 85 ? '#CA8A0440' : '#B91C1C40')

const th = { padding: '5px 7px', color: '#64748B', fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid #1E3A5A', textAlign: 'right', background: '#071624', position: 'sticky', top: 0 }
const td = { padding: '3px 7px', fontFamily: 'monospace', fontSize: 11, color: '#CBD5E1', textAlign: 'right', whiteSpace: 'nowrap' }
const btn = on => ({
  fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
  border: `1px solid ${on ? '#06B6D4' : '#1E3A5A'}`, background: on ? '#06B6D420' : '#071624', color: on ? '#06B6D4' : '#94A3B8',
})
const chip = { fontSize: 11, color: '#E2E8F0', background: '#071624', border: '1px solid #1E3A5A', borderRadius: 6, padding: '4px 8px', fontFamily: 'monospace' }
const caption = { fontSize: 9, color: '#475569', marginBottom: 4, letterSpacing: 1, textTransform: 'uppercase' }

// Track against the start line: along the line from the pin (x), towards the course side (y, up).
function TrackPlot({ track, lengthM, from }) {
  const pts = track.filter(p => p.t >= from)
  if (pts.length < 2) return null
  const W = 360, H = 260, pad = 22
  const xs = [...pts.map(p => p.along), 0, lengthM], ys = [...pts.map(p => p.over), 0]
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  const mx = (x1 - x0) * 0.08 || 20, my = (y1 - y0) * 0.08 || 20
  x0 -= mx; x1 += mx; y0 -= my; y1 += my
  const s = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0))
  const X = x => pad + (x - x0) * s, Y = y => H - pad - (y - y0) * s
  const ticks = pts.filter(p => p.t <= 0 && p.t >= -60 && p.t % 10 === 0)
  return (
    <svg data-start-track viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', background: '#071624', borderRadius: 8, border: '1px solid #1E3A5A' }}>
      <line x1={X(0)} y1={Y(0)} x2={X(lengthM)} y2={Y(0)} stroke="#22C55E" strokeWidth="2" />
      <circle cx={X(0)} cy={Y(0)} r="4" fill="#EF4444" /><text x={X(0)} y={Y(0) + 13} fontSize="9" fill="#EF4444" textAnchor="middle">Pin</text>
      <circle cx={X(lengthM)} cy={Y(0)} r="4" fill="#F97316" /><text x={X(lengthM)} y={Y(0) + 13} fontSize="9" fill="#F97316" textAnchor="middle">CB</text>
      <polyline points={pts.map(p => `${X(p.along).toFixed(1)},${Y(p.over).toFixed(1)}`).join(' ')} fill="none" stroke="#7DD3FC" strokeWidth="1.6" />
      {ticks.map(p => (
        <g key={p.t}>
          <circle cx={X(p.along)} cy={Y(p.over)} r={p.t === 0 ? 4 : 2.5} fill={p.t === 0 ? '#FDE047' : '#E2E8F0'} />
          <text x={X(p.along) + 5} y={Y(p.over) - 4} fontSize="8" fill={p.t === 0 ? '#FDE047' : '#94A3B8'}>{p.t === 0 ? 'gun' : p.t === -60 ? '1m' : `${-p.t}s`}</text>
        </g>
      ))}
      <text x={W - 6} y={12} fontSize="8" fill="#475569" textAnchor="end">↑ course side · metres</text>
    </svg>
  )
}

// Distance to line (BL, left) and BSP_trg% (right) over the run-in.
function RunInPlot({ samples, from }) {
  const pts = samples.filter(s => s.t >= from)
  const W = 360, H = 260, pad = { l: 30, r: 32, t: 12, b: 22 }
  const tMin = from, tMax = pts[pts.length - 1]?.t ?? 60
  const dMax = Math.max(5, ...pts.map(s => s.distLn ?? 0))
  const X = t => pad.l + ((t - tMin) / (tMax - tMin)) * (W - pad.l - pad.r)
  const Yd = d => H - pad.b - (d / dMax) * (H - pad.t - pad.b)
  const Yp = p => H - pad.b - (Math.min(150, Math.max(0, p)) / 150) * (H - pad.t - pad.b)
  const path = (key, Y) => {
    let d = '', pen = false
    for (const s of pts) {
      if (s[key] == null) { pen = false; continue }
      d += `${pen ? 'L' : 'M'}${X(s.t).toFixed(1)},${Y(s[key]).toFixed(1)}`
      pen = true
    }
    return d
  }
  const xTicks = pts.filter(s => s.t % 60 === 0).map(s => s.t)
  return (
    <svg data-start-runin viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', background: '#071624', borderRadius: 8, border: '1px solid #1E3A5A' }}>
      {[0, 50, 100, 150].map(p => <line key={p} x1={pad.l} x2={W - pad.r} y1={Yp(p)} y2={Yp(p)} stroke={p === 100 ? '#1E3A5A' : '#0F2030'} />)}
      {xTicks.map(t => <text key={t} x={X(t)} y={H - 7} fontSize="8" fill="#475569" textAnchor="middle">{fmtT(t)}</text>)}
      <line x1={X(0)} x2={X(0)} y1={pad.t} y2={H - pad.b} stroke="#EF4444" strokeDasharray="4,2" />
      <text x={X(0) + 3} y={pad.t + 8} fontSize="8" fill="#EF4444">gun</text>
      <path d={path('distLn', Yd)} fill="none" stroke="#7DD3FC" strokeWidth="1.6" />
      <path d={path('bspTrgPct', Yp)} fill="none" stroke="#FBBF24" strokeWidth="1.4" />
      <text x={4} y={pad.t + 8} fontSize="8" fill="#7DD3FC">{dMax.toFixed(0)} BL</text>
      <text x={4} y={H - pad.b} fontSize="8" fill="#7DD3FC">0</text>
      <text x={W - 4} y={Yp(150) + 8} fontSize="8" fill="#FBBF24" textAnchor="end">150%</text>
      <text x={W - 4} y={Yp(100) + 3} fontSize="8" fill="#FBBF24" textAnchor="end">100%</text>
    </svg>
  )
}

export default function StartSection({ rows, xmlData, polar = null, tzOffsetMin = 0, onJump = null, range = null }) {
  const all = React.useMemo(() => startAnalyses(rows, xmlData, polar), [rows, xmlData, polar])
  const starts = range ? all.filter(s => inRange(s.gunUtc, range)) : all
  const [pick, setPick] = React.useState(null)
  const [from, setFrom] = React.useState(-180)
  const [copied, setCopied] = React.useState(false)
  const start = starts.find(s => s.gunUtc === pick) || starts[0]

  if (!all.length) return <div style={{ padding: '14px 12px', background: '#071624', borderRadius: 8, color: '#64748B', fontSize: 11 }}>No start guns in this session’s event file.</div>
  if (!start) return <div style={{ padding: '14px 12px', background: '#071624', borderRadius: 8, color: '#64748B', fontSize: 11 }}>No start gun inside the track selection.</div>

  const shown = start.samples.filter(s => s.t >= from)
  const g = start.atGun, p30 = start.plus30
  const copy = async () => {
    const lines = [['Time to gun', 'Time', 'Event', ...COLS.map(c => c.label)],
      ...shown.map(s => [fmtT(s.t), hms(s.utc, tzOffsetMin), s.event, ...COLS.map(c => fmt(s[c.key], c.d))])]
    try { await navigator.clipboard.writeText(lines.map(l => l.join('\t')).join('\n')); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* blocked */ }
  }

  return (
    <div data-start-section>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        {starts.map(s => (
          <button key={s.gunUtc} onClick={() => setPick(s.gunUtc)} aria-pressed={s === start} style={btn(s === start)}>
            Race {s.raceNum || '?'} · {hms(s.gunUtc, tzOffsetMin).slice(0, 5)}
          </button>
        ))}
        <span style={{ width: 1, height: 18, background: '#1E3A5A', margin: '0 4px' }} />
        {WINDOWS.map(([f, label]) => (
          <button key={f} onClick={() => setFrom(f)} aria-pressed={from === f} style={{ ...btn(from === f), fontWeight: 600 }}>{label} → +1:00</button>
        ))}
      </div>

      <div style={{ fontSize: 11, color: '#CBD5E1', marginBottom: 8 }}>
        <strong>Race {start.raceNum || '?'} start</strong> · gun {hms(start.gunUtc, tzOffsetMin)}
        {start.sails ? ` · ${start.sails}` : ''}
        {start.twsAtGun != null ? ` · TWS ${start.twsAtGun.toFixed(1)} kn` : ''}
        {start.twdAtGun != null ? ` · TWD ${start.twdAtGun.toFixed(0)}°` : ''}
        <span style={{ color: '#475569' }}> (last minute)</span>
        {start.rowSpacingS != null && start.rowSpacingS > 2 && (
          <span style={{ color: '#F59E0B', fontSize: 10 }}> · cloud log, a row every {Math.round(start.rowSpacingS)} s — the 5 s rows are interpolated</span>
        )}
      </div>

      <div data-start-summary style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ ...caption, alignSelf: 'center', marginBottom: 0 }}>At the gun</span>
        <span style={chip}>{g?.distLn != null ? `${g.distLn.toFixed(1)} BL to line` : 'line: n/a'}</span>
        <span style={chip}>{g?.bsp != null ? `${g.bsp.toFixed(1)} kn` : 'BSP n/a'}</span>
        <span style={{ ...chip, background: pctBg(g?.bspTrgPct) }}>{g?.bspTrgPct != null ? `${g.bspTrgPct.toFixed(0)}% target` : 'target n/a'}</span>
        <span style={chip}>{g?.burn != null ? `burn ${g.burn > 0 ? '+' : ''}${g.burn.toFixed(1)} s ${g.burn > 0 ? '(early)' : '(late)'}` : 'burn n/a'}</span>
        {start.line?.gunAlongPct != null && <span style={chip}>{start.line.gunAlongPct.toFixed(0)}% up the line from the pin</span>}
        <span style={{ ...caption, alignSelf: 'center', marginBottom: 0, marginLeft: 8 }}>+30 s</span>
        <span style={chip}>{p30?.bsp != null ? `${p30.bsp.toFixed(1)} kn` : 'BSP n/a'}</span>
        <span style={{ ...chip, background: pctBg(p30?.vmgPct) }}>{p30?.vmgPct != null ? `VMG% ${p30.vmgPct.toFixed(0)}` : 'VMG% n/a'}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={caption}>Track to the line{start.line ? ` · line ${start.line.lengthM.toFixed(0)} m` : ''}</div>
          {start.track ? <TrackPlot track={start.track} lengthM={start.line.lengthM} from={from} />
            : <div style={{ padding: '14px 12px', background: '#071624', borderRadius: 8, color: '#64748B', fontSize: 11, lineHeight: 1.5 }}>{start.trackNote}</div>}
        </div>
        <div>
          <div style={caption}><span style={{ color: '#7DD3FC' }}>Distance to line (BL)</span> · <span style={{ color: '#FBBF24' }}>BSP_trg%</span></div>
          <RunInPlot samples={start.samples} from={from} />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#CBD5E1' }}>Run-in, every 5 s</div>
        <span style={{ fontSize: 9, color: '#475569' }}>click a row to jump to it</span>
        <button onClick={copy} style={{ marginLeft: 'auto', fontSize: 9, borderRadius: 3, padding: '2px 7px', cursor: 'pointer', color: copied ? '#22C55E' : '#94A3B8', background: '#071624', border: '1px solid #1E3A5A' }}>
          {copied ? '✓ Copied' : 'Copy for Excel'}
        </button>
      </div>
      <div style={{ overflow: 'auto', maxHeight: 380, border: '1px solid #1E3A5A', borderRadius: 8 }}>
        <table data-start-table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Time</th>
              <th style={{ ...th, textAlign: 'left' }}>Event</th>
              {COLS.map(c => <th key={c.key} style={th}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((s, i) => (
              <tr key={s.t} onClick={onJump ? () => onJump(s.utc) : undefined} title={hms(s.utc, tzOffsetMin)}
                style={{ cursor: onJump ? 'pointer' : 'default', background: s.t === 0 ? '#EF444422' : i % 2 ? '#071624' : 'transparent' }}>
                <td style={{ ...td, textAlign: 'left', color: s.t === 0 ? '#FCA5A5' : td.color }}>{fmtT(s.t)}</td>
                <td style={{ ...td, textAlign: 'left', fontFamily: 'inherit', color: '#FDE047' }}>{s.event}</td>
                {COLS.map(c => (
                  <td key={c.key} style={{ ...td, background: c.pct ? pctBg(s[c.key]) : 'transparent', color: s[c.key] == null ? '#475569' : td.color }}>
                    {fmt(s[c.key], c.d)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 9, color: '#475569', lineHeight: 1.5, marginTop: 6 }}>
        DistLn = distance to the line in boat lengths (blank when the log has no line) · BSP_trg% = BSP against target · ΔTwaTrg = |TWA| −
        target TWA · VMG% against the polar’s best upwind / downwind VMG · Rudder relative to the tack · Burn = time to burn before the gun
        (+ early, − late). Green ≥ 95 %, amber ≥ 85 %, red below.
      </div>
    </div>
  )
}

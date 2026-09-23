'use client'
import React from 'react'

// ─── ASK CHART ────────────────────────────────────────────────────────────────
// Draws a ChartSpec from lib/ai/askCharts. The spec is produced by a RULE from
// the tool's own table, never by the model, so this component has no decisions
// left to make about what the picture says — only how it looks.
//
// Everything is drawn from the same numbers the table below it shows. There is
// no path by which the bar and the row disagree, which is the whole reason the
// chart is built this way rather than asked for.

const C = {
  grid: '#0F2A45', axis: '#1E3A5A', text: '#94A3B8', dim: '#475569',
}
// Series colours in SSA's chart order. Port red / starboard green when the series
// ARE the tacks, because that is what everyone on a boat already reads them as.
const SERIES = ['#06B6D4', '#F59E0B', '#8B5CF6', '#10B981']
const TACK_COLOR = { Port: '#EF4444', Stbd: '#22C55E', Starboard: '#22C55E' }
const colorFor = (label, i) => TACK_COLOR[label] || SERIES[i % SERIES.length]

const VB_W = 400

const niceTicks = (lo, hi, count = 4) => {
  if (!(hi > lo)) return [lo]
  const raw = (hi - lo) / count
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || mag * 10
  const out = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 0.001; v += step) out.push(Number(v.toFixed(6)))
  return out.length ? out : [lo, hi]
}

const fmt = (v, unit) => (v == null ? '—' : `${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(Math.abs(v) >= 10 ? 1 : 2)}${unit ? ` ${unit}` : ''}`)

export default function AskChart({ spec, height = 170 }) {
  if (!spec?.series?.length) return null
  const values = spec.series.flatMap(s => s.points.map(p => p.y)).filter(v => typeof v === 'number' && Number.isFinite(v))
  if (!values.length) return null

  const isBar = spec.kind === 'bar'
  // A bar chart that does not start at zero misleads by construction — but a
  // percentage-of-polar chart that DOES start at zero shows nothing, because the
  // interesting range is 90–105. Zero-based unless every value is far from zero.
  const dataMin = Math.min(...values), dataMax = Math.max(...values)
  const spread = dataMax - dataMin
  const zeroBased = isBar && dataMin >= 0 && dataMin < spread * 2
  const lo = zeroBased ? 0 : dataMin - spread * 0.15 || dataMin - 1
  const hi = dataMax + spread * 0.15 || dataMax + 1

  const pad = { t: 10, r: 10, b: 34, l: 44 }
  const W = VB_W - pad.l - pad.r
  const H = height - pad.t - pad.b
  const py = v => pad.t + H - ((v - lo) / (hi - lo || 1)) * H
  const ticks = niceTicks(lo, hi)

  const categories = isBar ? spec.series[0].points.map(p => String(p.x)) : []
  const multi = spec.series.length > 1

  return (
    <figure style={{ margin: 0 }}>
      <figcaption style={{ fontSize: 11, color: '#CBD5E1', fontWeight: 600, marginBottom: 2 }}>
        {spec.title}{spec.unit ? <span style={{ color: C.dim, fontWeight: 400 }}> ({spec.unit})</span> : null}
      </figcaption>
      {multi && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 3 }}>
          {spec.series.map((s, i) => (
            <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: C.text }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: colorFor(s.label, i) }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${VB_W} ${height}`} width="100%" height={height} role="img"
        aria-label={`${spec.title} by ${spec.xLabel}`} style={{ display: 'block' }}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.l} x2={VB_W - pad.r} y1={py(t)} y2={py(t)} stroke={C.grid} strokeWidth="1" />
            <text x={pad.l - 5} y={py(t) + 3} textAnchor="end" fontSize="8" fill={C.text}>{t}</text>
          </g>
        ))}
        <line x1={pad.l} x2={VB_W - pad.r} y1={pad.t + H} y2={pad.t + H} stroke={C.axis} strokeWidth="1" />

        {isBar ? (() => {
          const slot = W / Math.max(1, categories.length)
          const inner = slot * 0.72
          const bw = inner / spec.series.length
          return categories.map((cat, ci) => (
            <g key={cat}>
              {spec.series.map((s, si) => {
                const v = s.points[ci]?.y
                if (v == null) return null
                const x = pad.l + ci * slot + (slot - inner) / 2 + si * bw
                const y = py(v), base = py(Math.max(lo, 0))
                return (
                  <g key={s.label}>
                    <rect x={x} y={Math.min(y, base)} width={Math.max(1, bw - 2)} height={Math.max(1, Math.abs(base - y))}
                      fill={colorFor(s.label, si)} opacity="0.85" rx="1.5">
                      <title>{`${cat}${multi ? ` · ${s.label}` : ''}: ${fmt(v, spec.unit)}`}</title>
                    </rect>
                    {categories.length * spec.series.length <= 10 && (
                      <text x={x + (bw - 2) / 2} y={Math.min(y, base) - 3} textAnchor="middle" fontSize="7.5" fill="#CBD5E1">
                        {v >= 100 ? v.toFixed(0) : v.toFixed(1)}
                      </text>
                    )}
                  </g>
                )
              })}
              <text x={pad.l + ci * slot + slot / 2} y={pad.t + H + 12} textAnchor="middle" fontSize="8" fill={C.text}>
                {cat.length > 12 ? `${cat.slice(0, 11)}…` : cat}
              </text>
            </g>
          ))
        })() : (() => {
          const xs = spec.series.flatMap(s => s.points.map(p => Number(p.x))).filter(Number.isFinite)
          const x0 = Math.min(...xs), x1 = Math.max(...xs)
          const px = x => pad.l + ((Number(x) - x0) / ((x1 - x0) || 1)) * W
          // Venue-local, via the offset the tool sent with the data. Never the
          // browser's zone: a Porto Cervo day read in London time is a day lost.
          const tz = spec.tzOffsetMin || 0
          const label = ms => new Date(ms + tz * 60000).toISOString().slice(11, 16)
          return (
            <>
              {spec.series.map((s, si) => {
                // One path per unbroken run. A gap in the log is a gap in the line,
                // not a straight segment drawn across the minutes that are missing.
                const runs = []
                let run = []
                for (const p of s.points) {
                  if (p.y == null) { if (run.length) runs.push(run); run = [] }
                  else run.push(`${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`)
                }
                if (run.length) runs.push(run)
                return runs.map((r, ri) => (
                  <path key={`${s.label}-${ri}`} d={`M${r.join(' L')}`} fill="none"
                    stroke={colorFor(s.label, si)} strokeWidth="1.4" strokeLinejoin="round" />
                ))
              })}
              {[x0, (x0 + x1) / 2, x1].map((x, i) => (
                <text key={i} x={px(x)} y={pad.t + H + 12} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
                  fontSize="8" fill={C.text}>{label(x)}</text>
              ))}
            </>
          )
        })()}
      </svg>
      <div style={{ fontSize: 9, color: C.dim, textAlign: 'center', marginTop: -4 }}>
        {spec.xLabel}{spec.xType === 'time' ? ' (venue-local)' : ''}
      </div>
    </figure>
  )
}

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
// The colours PhaseXYPlot has always used, so a scatter here reads the same as the
// one in Performance charts: port light blue, starboard green.
const TACK_COLOR = { Port: '#7DD3FC', Stbd: '#22C55E', Starboard: '#22C55E' }
const colorFor = (label, i) => TACK_COLOR[label] || SERIES[i % SERIES.length]
// The day you are looking at, picked out of the days either side of it. Comparing
// today with the season is the commonest thing this chart is asked to show, and
// without this you have to read the axis to find which bar is yours.
const HIGHLIGHT = '#FBBF24'

const VB_W = 400

// A category axis of ISO dates is unreadable at chart width — eleven of
// "2026-09-11" at 8px in a 400-unit viewBox overlap into a smear. Shorten them to
// the day and month, which is what anyone reading a season is actually scanning for.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortLabel = cat => {
  const m = ISO_DATE.exec(cat)
  if (m) return `${Number(m[3])} ${MONTH[Number(m[2]) - 1]}`
  return cat.length > 14 ? `${cat.slice(0, 13)}…` : cat
}

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

export default function AskChart({ spec, height = 170, highlight = null }) {
  if (!spec?.series?.length) return null
  const values = spec.series.flatMap(s => s.points.map(p => p.y)).filter(v => typeof v === 'number' && Number.isFinite(v))
  if (!values.length) return null
  // Reference lines widen the y domain, but only as far as the data's own span
  // again: an unreachable polar target in light air must not squash every dot
  // into the bottom eighth of the chart to make room for it.
  const refValues = (spec.refLines || []).flatMap(r => r.points.map(p => p.y)).filter(Number.isFinite)

  const isBar = spec.kind === 'bar'
  const isScatter = spec.kind === 'scatter'
  // A bar chart that does not start at zero misleads by construction — but a
  // percentage-of-polar chart that DOES start at zero shows nothing, because the
  // interesting range is 90–105. Zero-based unless every value is far from zero.
  const dataMin = Math.min(...values), dataMax = Math.max(...values)
  const dataSpan = dataMax - dataMin || 1
  const refMin = refValues.length ? Math.max(Math.min(...refValues), dataMin - dataSpan) : dataMin
  const refMax = refValues.length ? Math.min(Math.max(...refValues), dataMax + dataSpan) : dataMax
  const spread = Math.max(dataMax, refMax) - Math.min(dataMin, refMin)
  const zeroBased = isBar && !isScatter && dataMin >= 0 && dataMin < spread * 2
  const lo = zeroBased ? 0 : Math.min(dataMin, refMin) - spread * 0.15 || dataMin - 1
  const hi = Math.max(dataMax, refMax) + spread * 0.15 || dataMax + 1

  // ~4.6 units per character at font-size 8 in this viewBox. If the longest label
  // will not sit inside its slot, the whole axis tilts rather than overlapping.
  const catLabels = isBar ? spec.series[0].points.map(p => shortLabel(String(p.x))) : []
  const widest = catLabels.reduce((a, t) => Math.max(a, t.length), 0) * 4.6
  const slotW = catLabels.length ? (VB_W - 54) / catLabels.length : VB_W
  // 0.9, not 1.0: "fits" has to mean visibly separated, not merely not-overlapping.
  const tilt = isBar && widest > slotW * 0.9
  const pad = { t: 10, r: 10, b: tilt ? 46 : 34, l: 44 }
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
      {(multi || isScatter) && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 3 }}>
          {spec.series.map((s, i) => (
            <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: C.text }}>
              <span style={{ width: 8, height: 8, borderRadius: isScatter ? 8 : 2, background: colorFor(s.label, i) }} />
              {s.label}
              {/* Never a trend without the n behind it and how much of the
                  scatter it actually explains. */}
              {isScatter && s.n != null && <span style={{ color: C.dim }}>· {s.n}</span>}
              {isScatter && s.trend && <span style={{ color: C.dim }}>· R² {s.trend.r2.toFixed(2)}</span>}
            </span>
          ))}
        </div>
      )}
      {/* width:100% with a fixed height and a 400-unit viewBox does NOT fill the
          container: SVG preserves the aspect ratio, so it draws at 400px wide and
          centres it, leaving dead space either side. Letting the height follow the
          width instead fills the panel AND gives the axis ~1.75× the room, which
          is most of what made the labels feel cramped in the first place. */}
      <svg viewBox={`0 0 ${VB_W} ${height}`} role="img"
        aria-label={`${spec.title} by ${spec.xLabel}`}
        style={{ display: 'block', width: '100%', height: 'auto' }}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.l} x2={VB_W - pad.r} y1={py(t)} y2={py(t)} stroke={C.grid} strokeWidth="1" />
            <text x={pad.l - 5} y={py(t) + 3} textAnchor="end" fontSize="8" fill={C.text}>{t}</text>
          </g>
        ))}
        <line x1={pad.l} x2={VB_W - pad.r} y1={pad.t + H} y2={pad.t + H} stroke={C.axis} strokeWidth="1" />

        {isScatter ? (() => {
          const xs = spec.series.flatMap(s => s.points.map(p => Number(p.x))).filter(Number.isFinite)
          const x0 = Math.min(...xs), x1 = Math.max(...xs)
          const xpad = (x1 - x0) * 0.06 || 1
          const lox = x0 - xpad, hix = x1 + xpad
          const px = x => pad.l + ((Number(x) - lox) / ((hix - lox) || 1)) * W
          const xticks = niceTicks(lox, hix, 4)
          const clampY = v => Math.max(pad.t, Math.min(pad.t + H, py(v)))
          return (
            <>
              {xticks.map(t => (
                <text key={`xt${t}`} x={px(t)} y={pad.t + H + 12} textAnchor="middle" fontSize="8" fill={C.text}>{t}</text>
              ))}
              {/* Behind the dots, and labelled at the end of the line rather than in
                  the legend: the polar and the season are what the cloud is being
                  judged against, not more of the same measurement. */}
              {(spec.refLines || []).map(ref => {
                const inside = ref.points.filter(p => p.x >= lox && p.x <= hix)
                if (inside.length < 2) return null
                // A reference that misses the y-range entirely would be clamped
                // into a flat line along the edge of the chart — which reads as
                // data and is not. Better absent than drawn somewhere it is not.
                if (!inside.some(p => p.y >= lo && p.y <= hi)) return null
                const last = inside[inside.length - 1]
                return (
                  <g key={ref.label} opacity="0.6">
                    <polyline points={inside.map(p => `${px(p.x)},${clampY(p.y)}`).join(' ')}
                      fill="none" stroke={ref.color || '#E2E8F0'} strokeWidth="1.2"
                      strokeDasharray={ref.dashed ? '2,3' : undefined} />
                    <text x={px(last.x) - 2} y={clampY(last.y) - 4} textAnchor="end" fontSize="8" fill={ref.color || '#CBD5E1'}>
                      {ref.label}
                    </text>
                  </g>
                )
              })}
              {spec.series.map((s, si) => (
                <g key={s.label}>
                  {s.points.map((p, i) => (
                    p.y == null ? null : (
                      <circle key={i} cx={px(p.x)} cy={py(p.y)} r="2.6" fill={colorFor(s.label, si)} opacity="0.7">
                        <title>{`${s.label}: ${spec.xLabel} ${p.x}${spec.xUnit ? ` ${spec.xUnit}` : ''}, ${spec.yLabel} ${p.y}${spec.unit ? ` ${spec.unit}` : ''}`}</title>
                      </circle>
                    )
                  ))}
                  {/* Dashed, over the dots, only across the x-range it was fitted to —
                      a trend drawn past its own data is an extrapolation nobody asked for. */}
                  {s.trend && (
                    <line x1={px(s.trend.x0)} y1={py(s.trend.slope * s.trend.x0 + s.trend.intercept)}
                      x2={px(s.trend.x1)} y2={py(s.trend.slope * s.trend.x1 + s.trend.intercept)}
                      stroke={colorFor(s.label, si)} strokeWidth="1.4" strokeDasharray="5 4" opacity="0.95" />
                  )}
                </g>
              ))}
            </>
          )
        })() : isBar ? (() => {
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
                const mine = highlight != null && cat === String(highlight)
                return (
                  <g key={s.label}>
                    <rect x={x} y={Math.min(y, base)} width={Math.max(1, bw - 2)} height={Math.max(1, Math.abs(base - y))}
                      fill={mine ? HIGHLIGHT : colorFor(s.label, si)} opacity={mine ? 1 : 0.85} rx="1.5">
                      <title>{`${cat}${multi ? ` · ${s.label}` : ''}: ${fmt(v, spec.unit)}${mine ? ' — the day you are looking at' : ''}`}</title>
                    </rect>
                    {categories.length * spec.series.length <= 10 && (
                      <text x={x + (bw - 2) / 2} y={Math.min(y, base) - 3} textAnchor="middle" fontSize="7.5" fill="#CBD5E1">
                        {v >= 100 ? v.toFixed(0) : v.toFixed(1)}
                      </text>
                    )}
                  </g>
                )
              })}
              {(() => {
                const mine = highlight != null && cat === String(highlight)
                const text = shortLabel(cat)
                const cx = pad.l + ci * slot + slot / 2
                const common = { fontSize: 8, fill: mine ? HIGHLIGHT : C.text, fontWeight: mine ? 700 : 400 }
                // Straight when they fit, tilted when they do not. Tilting every
                // axis would be uglier; a smear of overlapping dates is worse.
                return tilt
                  ? <text x={cx} y={pad.t + H + 10} textAnchor="end" transform={`rotate(-40 ${cx} ${pad.t + H + 10})`} {...common}>{text}</text>
                  : <text x={cx} y={pad.t + H + 12} textAnchor="middle" {...common}>{text}</text>
              })()}
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
        {spec.xLabel}{spec.xUnit ? ` (${spec.xUnit})` : ''}{spec.xType === 'time' ? ' (venue-local)' : ''}
      </div>
    </figure>
  )
}

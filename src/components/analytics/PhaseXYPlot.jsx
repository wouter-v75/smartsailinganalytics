'use client'
// src/components/analytics/PhaseXYPlot.jsx
// ─────────────────────────────────────────────────────────────────────────────
// One dot per 30 s phase (phaseStats) — the KND-style "<channel> vs TWS" plot.
// Look and hover follow the Analytics tab's XYPlot: port ▲ light blue, stbd ● in
// the chart colour, hovering a dot veils the other tack. Added for phases: a trend
// line per tack, an optional polar target line, a tooltip per phase, and click (or
// tap) to jump the timeline/video to that phase.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { CHANNEL_BY_KEY } from '../../lib/phaseStats'
import { phasePoints, tackTrends, linearTrend, plotDomain, niceTicks, tickDecimals } from '../../lib/phasePlot'
import { phaseSection } from '../../lib/trackSections'
import { symbolFor, symbolPath } from '../../lib/phaseSymbols'

const PORT_COLOR = '#7DD3FC'
const localHMS = (utc, tzMin) => new Date(utc + (tzMin || 0) * 60000).toISOString().slice(11, 19)
const fmtVal = (v, ch) => (v == null ? '—' : v.toFixed(ch?.decimals ?? 1))

export default function PhaseXYPlot({
  phases, xKey = 'tws', yKey, color = '#06B6D4', width = 560, height = 300, title = '',
  yLines = [], targetLine = null, targetLabel = 'polar', showTrend = true, refCurves = [],
  tzOffsetMin = 0, onSelectUtc = null, activeUtc = null, sections = [],
}) {
  const [hoveredTack, setHoveredTack] = React.useState(null) // null | "port" | "stbd"
  const [hover, setHover] = React.useState(null)             // the hovered PlotPoint

  const xCh = CHANNEL_BY_KEY[xKey], yCh = CHANNEL_BY_KEY[yKey]
  const pts = phasePoints(phases, xKey, yKey)
  if (!pts.length) {
    return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1E3A5A', fontSize: 10 }}>No data</div>
  }

  const pad = { t: title ? 24 : 12, r: 12, b: 40, l: 52 }
  const W = width - pad.l - pad.r, H = height - pad.t - pad.b
  const [x0, x1] = plotDomain(pts.map(p => p.x), (targetLine || []).map(p => p.x))
  // Season reference curves are clipped to the day's wind range (± half a 1 kn bin), so a
  // season sailed in 8–28 kn doesn't squash a 20–24 kn day into a corner of the plot.
  const dotX0 = Math.min(...pts.map(p => p.x)), dotX1 = Math.max(...pts.map(p => p.x))
  const refs = (refCurves || [])
    .map(c => ({ ...c, points: (c.points || []).filter(p => p.x >= dotX0 - 0.5 && p.x <= dotX1 + 0.5) }))
    .filter(c => c.points.length >= 2)
  const [y0, y1] = plotDomain(pts.map(p => p.y), [
    ...yLines, ...(targetLine || []).map(p => p.y), ...refs.flatMap(c => c.points.map(p => p.y)),
  ])
  const px = x => pad.l + ((x - x0) / (x1 - x0 || 1)) * W
  const py = y => pad.t + H - ((y - y0) / (y1 - y0 || 1)) * H
  const xTicks = niceTicks(x0, x1, 5), xDec = tickDecimals(xTicks)
  const yTicks = niceTicks(y0, y1, 4), yDec = tickDecimals(yTicks)
  // A straight trend is meaningless across upwind + downwind angles (speed vs TWA).
  const trends = showTrend ? tackTrends(pts) : { port: null, stbd: null }
  const tackColor = t => (t === 'port' ? PORT_COLOR : color)

  const enter = p => { setHoveredTack(bySection ? (sectionOfPhase(p)?.id || null) : p.tack); setHover(p) }
  const leave = () => { setHoveredTack(null); setHover(null) }
  const select = p => { setHoveredTack(bySection ? (sectionOfPhase(p)?.id || null) : p.tack); setHover(p); onSelectUtc?.(p.utc) }

  // WHOLE SESSION, or one race: the split that matters is the tack, and it is a colour,
  // as it has always been.
  //
  // SECTIONS: the split that matters is which stretch, so the section takes over both
  // channels — colour AND shape — and gets a trend of its own. Two stretches drawn in
  // one colour with one trend line through them answer nothing; the comparison IS the
  // question somebody selected them to ask.
  const bySection = sections.length > 0
  const sectionOfPhase = p => phaseSection({ utc: p.utc, endUtc: p.endUtc ?? p.utc }, sections)
  const ptsOf = sec => pts.filter(p => sectionOfPhase(p)?.id === sec.id)
  const sectionTrends = showTrend && bySection
    ? sections.map(sec => ({ sec, trend: linearTrend(ptsOf(sec)), n: ptsOf(sec).length }))
    : []

  const dot = (p, i, hl) => {
    const cx = px(p.x), cy = py(p.y)
    const r = hl ? 4.5 : 3.2
    const sec = sectionOfPhase(p)
    const kind = symbolFor(sec?.n)
    return (
      <path
        key={(hl ? 'hl' : '') + i}
        d={symbolPath(kind, cx, cy, r)}
        fill={bySection && sec ? sec.color : tackColor(p.tack)}
        opacity={hl ? 1 : 0.8}
        data-phase={p.utc} data-tack={p.tack} data-symbol={kind}
        {...(sec ? { 'data-section': sec.n } : {})}
        style={{ cursor: 'pointer' }}
        onMouseEnter={() => enter(p)} onMouseLeave={leave} onClick={() => select(p)}
        {...(hl ? { stroke: '#fff', strokeWidth: 0.7 } : {})}
      />
    )
  }

  // A shape drawn small, for the legend.
  const swatch = (kind, fill) => (
    <svg width="12" height="12" style={{ verticalAlign: 'middle', marginRight: 4 }} aria-hidden>
      <path d={symbolPath(kind, 6, 6, 3.6)} fill={fill} />
    </svg>
  )

  const trendLine = (tack, keySuffix = '') => {
    const t = trends[tack]
    if (!t) return null
    const dim = hoveredTack && hoveredTack !== tack
    return (
      <line key={'tr' + tack + keySuffix} x1={px(t.x0)} y1={py(t.slope * t.x0 + t.intercept)} x2={px(t.x1)} y2={py(t.slope * t.x1 + t.intercept)}
        stroke={tackColor(tack)} strokeWidth="1.5" strokeDasharray="5,3" opacity={dim ? 0.15 : 0.85} style={{ pointerEvents: 'none' }} />
    )
  }

  const active = activeUtc != null ? pts.find(p => activeUtc >= p.utc && activeUtc < p.endUtc) : null
  const port = pts.filter(p => p.tack === 'port'), stbd = pts.filter(p => p.tack === 'stbd')
  const r2 = t => (trends[t] ? ` · R² ${trends[t].r2.toFixed(2)}` : '')

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 4, fontSize: 11, color: '#94A3B8', flexWrap: 'wrap' }}>
        {bySection ? (
          <>
            {sections.map(sec => {
              const secPts = ptsOf(sec)
              const t = sectionTrends.find(x => x.sec.id === sec.id)?.trend
              return (
                <span key={sec.id} data-legend-section={sec.n}>
                  {swatch(symbolFor(sec.n), sec.color)}Section {sec.n} · {secPts.length}
                  {t ? ` · R² ${t.r2.toFixed(2)}` : ''}
                </span>
              )
            })}
            <span style={{ color: '#334155' }}>· port {port.length} / stbd {stbd.length}, named in the tooltip</span>
          </>
        ) : (
          <>
            <span>{swatch('circle', PORT_COLOR)}Port tack · {port.length}{r2('port')}</span>
            <span>{swatch('circle', color)}Stbd tack · {stbd.length}{r2('stbd')}</span>
          </>
        )}
        <span style={{ color: '#64748B' }}>· hover to highlight{onSelectUtc ? ' · click to jump' : ''}</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }} role="img"
        aria-label={`${yCh?.label || yKey} vs ${xCh?.label || xKey}, ${pts.length} phases`}>
        {title && <text x={pad.l + W / 2} y={13} textAnchor="middle" fontSize="12" fill="#CBD5E1" fontWeight="600">{title}</text>}
        {yTicks.map((y, i) => <line key={i} x1={pad.l} x2={pad.l + W} y1={py(y)} y2={py(y)} stroke="#0F2030" strokeWidth="1" />)}
        {yLines.map((y, i) => {
          const cy = py(y)
          if (cy < pad.t || cy > pad.t + H) return null
          return (
            <g key={'yl' + i}>
              <line x1={pad.l} x2={pad.l + W} y1={cy} y2={cy} stroke={color} strokeWidth="1" strokeDasharray="4,3" opacity="0.6" />
              <text x={pad.l + W - 2} y={cy - 3} textAnchor="end" fontSize="10" fill={color} opacity="0.9">{y}</text>
            </g>
          )
        })}
        {refs.map(c => {
          const last = c.points[c.points.length - 1]
          return (
            <g key={'ref' + c.label} data-ref={c.label} style={{ pointerEvents: 'none' }}>
              <polyline points={c.points.map(p => `${px(p.x)},${py(p.y)}`).join(' ')} fill="none"
                stroke={c.color} strokeWidth="1.4" strokeDasharray="6,3" opacity="0.7" />
              <text x={px(last.x) + 2} y={py(last.y) - 4} fontSize="10" fill={c.color} opacity="0.95">{c.label}</text>
            </g>
          )
        })}
        {targetLine && (
          <g style={{ pointerEvents: 'none' }}>
            <polyline points={targetLine.map(p => `${px(p.x)},${py(p.y)}`).join(' ')} fill="none" stroke="#E2E8F0" strokeWidth="1.2" strokeDasharray="2,3" opacity="0.55" />
            <text x={px(targetLine[targetLine.length - 1].x) - 2} y={py(targetLine[targetLine.length - 1].y) - 4} textAnchor="end" fontSize="10" fill="#CBD5E1">{targetLabel}</text>
          </g>
        )}
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t + H} stroke="#1E3A5A" strokeWidth="1" />
        <line x1={pad.l} x2={pad.l + W} y1={pad.t + H} y2={pad.t + H} stroke="#1E3A5A" strokeWidth="1" />
        {stbd.map((p, i) => dot(p, 's' + i))}
        {port.map((p, i) => dot(p, 'p' + i))}
        {bySection
          ? sectionTrends.map(({ sec, trend }) => {
              if (!trend) return null
              const dim = hoveredTack && hoveredTack !== sec.id
              return (
                <line key={'tr' + sec.id} data-section-trend={sec.n}
                  x1={px(trend.x0)} y1={py(trend.slope * trend.x0 + trend.intercept)}
                  x2={px(trend.x1)} y2={py(trend.slope * trend.x1 + trend.intercept)}
                  stroke={sec.color} strokeWidth="1.5" strokeDasharray="5,3"
                  opacity={dim ? 0.15 : 0.9} style={{ pointerEvents: 'none' }} />
              )
            })
          : <>{trendLine('stbd')}{trendLine('port')}</>}
        {/* Grey veil over the non-hovered tack; the hovered tack is redrawn on top */}
        {hoveredTack && <rect x={pad.l} y={pad.t} width={W} height={H} fill="#0A1929" opacity="0.62" style={{ pointerEvents: 'none' }} />}
        {hoveredTack && pts.filter(p => (bySection ? sectionOfPhase(p)?.id : p.tack) === hoveredTack).map((p, i) => dot(p, i, true))}
        {hoveredTack && !bySection && trendLine(hoveredTack, 'hl')}
        {active && <circle cx={px(active.x)} cy={py(active.y)} r="7" fill="none" stroke="#F8FAFC" strokeWidth="1.2" style={{ pointerEvents: 'none' }} />}
        {yTicks.map((y, i) => <text key={i} x={pad.l - 6} y={py(y) + 4} textAnchor="end" fontSize="12" fill="#94A3B8">{y.toFixed(yDec)}</text>)}
        {xTicks.map((x, i) => <text key={i} x={px(x)} y={pad.t + H + 20} textAnchor="middle" fontSize="12" fill="#94A3B8">{x.toFixed(xDec)}</text>)}
        <text x={pad.l + W / 2} y={height - 6} textAnchor="middle" fontSize="12" fill="#CBD5E1">{xCh ? `${xCh.label} (${xCh.unit})` : xKey}</text>
        <text x={13} y={pad.t + H / 2} textAnchor="middle" fontSize="12" fill="#CBD5E1" transform={`rotate(-90,13,${pad.t + H / 2})`}>
          {yCh ? `${yCh.label} (${yCh.unit})` : yKey}
        </text>
      </svg>
      {hover && (
        <div role="tooltip" style={{
          position: 'absolute', pointerEvents: 'none', zIndex: 5,
          left: `${Math.min(78, (px(hover.x) / width) * 100)}%`, top: `${(py(hover.y) / height) * 100}%`,
          transform: 'translate(8px, 14px)', background: '#071624', border: `1px solid ${tackColor(hover.tack)}80`,
          borderRadius: 6, padding: '5px 8px', fontSize: 10, color: '#CBD5E1', whiteSpace: 'nowrap', boxShadow: '0 4px 12px #0008',
        }}>
          <div style={{ color: tackColor(hover.tack), fontWeight: 700 }}>
            {localHMS(hover.utc, tzOffsetMin)} · {hover.tack === 'port' ? 'Port' : 'Stbd'}
          </div>
          <div>{yCh?.label || yKey} <b>{fmtVal(hover.y, yCh)}</b> {yCh?.unit} · {xCh?.label || xKey} {fmtVal(hover.x, xCh)} {xCh?.unit}</div>
          <div style={{ color: '#64748B' }}>{hover.sails} · {hover.n} samples{onSelectUtc ? ' · click to jump' : ''}</div>
        </div>
      )}
    </div>
  )
}

'use client'
// src/components/SailScanCompare.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Side-by-side comparison of up to SIX SailScan scans (e.g. the two photos/tacks
// of a North "Sail Comparison" report, or any scans picked from the Sail-data
// list). Shows, per sail: a header line (TWS / rake / forestay / time), the
// analysed photo, the measured stripe table and its design-target table; then a
// row of shape charts overlaying every measured line plus each sail's design.
//
// Design targets reuse pickDesign() — main vs jib, TWS-window selection — exactly
// like the single detail view, interpolated to each scan's own TWS.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react'
import { pickDesign, designCodeOf } from '../lib/designInterp'
import { scanLocalDateTime } from '../lib/scanTime'

const C = {
  bg: '#0A1929', panel: '#0d2236', border: '#1E3A5A', accent: '#06B6D4',
  head: '#E2E8F0', text: '#CBD5E1', dim: '#64748B', warn: '#F59E0B',
}
// distinct per-sail colours (up to 6 sails compared at once)
const SAIL_COLORS = ['#06B6D4', '#FBBF24', '#34D399', '#F472B6', '#A78BFA', '#F87171']
const DESIGN_GREY = '#94A3B8'

const fmt = (v: number | null | undefined, dp = 1) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(dp))

interface Stripe { pos: number; draft: number | null; camber: number | null; twist: number | null; entry: number | null; exit: number | null; fore: number | null; back: number | null }

const METRICS: { key: keyof Stripe; label: string; dKey: string; dScale: number }[] = [
  { key: 'draft', label: 'Draft', dKey: 'draft', dScale: 100 },
  { key: 'camber', label: 'Camber', dKey: 'camber', dScale: 100 },
  { key: 'twist', label: 'Twist', dKey: 'twist', dScale: 1 },
  { key: 'entry', label: 'Entry', dKey: 'leadAngle', dScale: 1 },
  { key: 'exit', label: 'Exit', dKey: 'trailAngle', dScale: 1 },
  { key: 'fore', label: 'Front%', dKey: 'frontPct', dScale: 100 },
  { key: 'back', label: 'Back%', dKey: 'backPct', dScale: 100 },
]

interface Series { xs: number[]; ys: (number | null)[]; color: string; dash?: string; idx?: number }

// Smooth Catmull-Rom → cubic-Bézier path through pixel-space points (points must
// be sorted by x). Gives a fitted spline instead of straight segments.
function splinePath(p: { x: number; y: number }[]): string {
  if (p.length === 0) return ''
  if (p.length === 1) return `M${p[0].x.toFixed(1)},${p[0].y.toFixed(1)}`
  if (p.length === 2) return `M${p[0].x.toFixed(1)},${p[0].y.toFixed(1)} L${p[1].x.toFixed(1)},${p[1].y.toFixed(1)}`
  let d = `M${p[0].x.toFixed(1)},${p[0].y.toFixed(1)}`
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
  }
  return d
}

// Multi-series spline chart over the 25–100% stripe-height domain (below 25% is
// clipped — includes any 0% design rows). Ticks at true coordinates. `hovered` is
// a sail index: when set, that sail's lines pop and the rest dim.
function MultiLineChart({ series, w = 720, h = 280, hovered = null, onHover }:
  { series: Series[]; w?: number; h?: number; hovered?: number | null; onHover?: (i: number | null) => void }) {
  const pad = { l: 40, r: 10, t: 12, b: 22 }
  const xMin = 25, xMax = 100
  const clean = (xs: number[], ys: (number | null)[]) =>
    (ys.map((y, i) => ({ x: xs[i], y })).filter((p) => p.y != null && Number.isFinite(p.y as number) && p.x >= xMin && p.x <= xMax) as { x: number; y: number }[])
      .sort((a, b) => a.x - b.x)
  const cleaned = series.map((s) => ({ ...s, pts: clean(s.xs, s.ys) }))
  const all = cleaned.flatMap((s) => s.pts)
  if (!all.length) return <div style={{ width: w, height: h, color: C.dim, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>no data</div>
  const ymin = Math.min(...all.map((p) => p.y)), ymax = Math.max(...all.map((p) => p.y))
  const ylo = ymin === ymax ? ymin - 1 : ymin, yhi = ymin === ymax ? ymax + 1 : ymax
  const px = (x: number) => pad.l + ((x - xMin) / (xMax - xMin)) * (w - pad.l - pad.r)
  const py = (y: number) => pad.t + (1 - (y - ylo) / (yhi - ylo || 1)) * (h - pad.t - pad.b)
  const path = (pts: { x: number; y: number }[]) => splinePath(pts.map((p) => ({ x: px(p.x), y: py(p.y) })))
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <line x1={pad.l} y1={py(yhi)} x2={w - pad.r} y2={py(yhi)} stroke={C.border} strokeWidth={0.5} />
      <line x1={pad.l} y1={py(ylo)} x2={w - pad.r} y2={py(ylo)} stroke={C.border} strokeWidth={0.5} />
      <text x={4} y={py(yhi) + 4} fontSize={12} fill={C.dim}>{yhi.toFixed(yhi % 1 ? 1 : 0)}</text>
      <text x={4} y={py(ylo) + 4} fontSize={12} fill={C.dim}>{ylo.toFixed(ylo % 1 ? 1 : 0)}</text>
      {cleaned.map((s, i) => {
        if (!s.pts.length) return null
        const on = hovered == null || s.idx == null || s.idx === hovered
        return (
          <path key={i} d={path(s.pts)} fill="none" stroke={s.color}
            strokeWidth={s.idx != null && s.idx === hovered ? (s.dash ? 3 : 4.2) : (s.dash ? 1.5 : 2.4)}
            strokeDasharray={s.dash || undefined}
            strokeOpacity={on ? 1 : 0.12}
            onMouseEnter={() => s.idx != null && onHover?.(s.idx)}
            onMouseLeave={() => onHover?.(null)}
            style={{ cursor: s.idx != null ? 'pointer' : 'default' }} />
        )
      })}
      {[25, 50, 75, 100].map((t) => (
        <text key={t} x={px(t)} y={h - 5} fontSize={12} fill={C.dim} textAnchor={t === 25 ? 'start' : t === 100 ? 'end' : 'middle'}>{t}</text>
      ))}
    </svg>
  )
}

function scanModel(scan: any, sails: any[], tag: any) {
  const stripes: Stripe[] = Array.isArray(scan?.stripes) ? [...scan.stripes].sort((a: Stripe, b: Stripe) => b.pos - a.pos) : []
  const sailRec = (sails || []).find((s) => s.id === scan?.sail_id) || null
  const activeJib = (tag?.activeSails || []).map(designCodeOf).find((c: any) => c && c !== 'MN') || null
  const tws = tag?.avgTws ?? scan?.tws_kn ?? null
  const design = pickDesign(sails || [], sailRec, activeJib, tws)
  const cond = scan?.conditions || {}
  const name = sailRec?.category || sailRec?.name || cond.sail_code || cond.sail_name_in_report || 'sail'
  const posXs = stripes.map((s) => s.pos)
  return { stripes, sailRec, design, tws, cond, name, posXs }
}

export default function SailScanCompare({ scans, sails, tags = [], boatName, onClose, sessionTzOffset = 0 }:
  { scans: any[]; sails: any[]; tags?: any[]; boatName?: string | null; onClose: () => void; sessionTzOffset?: number }) {
  // one model per selected scan, capped at 6, each with its own colour
  const models = useMemo(
    () => (scans || []).slice(0, 6).map((scan, i) => ({ scan, M: scanModel(scan, sails, tags[i]), color: SAIL_COLORS[i % SAIL_COLORS.length], tag: tags[i] })),
    [scans, sails, tags],
  )
  const [hovered, setHovered] = useState<number | null>(null) // sail index to highlight

  const td: React.CSSProperties = { padding: '3px 6px', fontSize: 11, color: C.text, textAlign: 'center', borderBottom: `1px solid ${C.border}` }
  const th: React.CSSProperties = { ...td, color: C.dim, fontWeight: 700, fontSize: 10 }

  // Venue/local time from the report's wall-clock (or true-UTC + venue offset).
  const timeOf = (scan: any) => scanLocalDateTime(scan, sessionTzOffset)

  // One sail column: header line, photo, measured table, design table.
  const Column = ({ scan, M, color }: { scan: any; M: ReturnType<typeof scanModel>; color: string; tag: any }) => (
    <div style={{ flex: '1 1 320px', minWidth: 280, maxWidth: 460 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
        <span style={{ fontWeight: 800, color: C.head, fontSize: 14 }}>{M.name}</span>
        {M.cond.sail_type && <span style={{ fontSize: 10, color: M.cond.sail_type === 'main' ? '#34D399' : '#FBBF24' }}>{M.cond.sail_type}</span>}
      </div>
      <div style={{ fontSize: 11, color: C.dim, marginBottom: 6, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <span>TWS <b style={{ color: C.text }}>{fmt(M.tws, 0)}</b> kt</span>
        {M.cond.forestay_t != null && <span>Forestay <b style={{ color: C.text }}>{fmt(M.cond.forestay_t)}</b> T</span>}
        {M.cond.rake_deg != null && <span>Rake <b style={{ color: C.text }}>{fmt(M.cond.rake_deg, 2)}</b>°</span>}
        {M.cond.jib_tack_t != null && <span>JibTack <b style={{ color: C.text }}>{fmt(M.cond.jib_tack_t)}</b> T</span>}
        <span>{timeOf(scan)}</span>
      </div>
      <div style={{ width: '100%', aspectRatio: '4 / 3', background: C.panel, borderRadius: 8, overflow: 'hidden', border: `1px solid ${C.border}`, marginBottom: 8 }}>
        {scan?.photo_url ? <img src={scan.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 12 }}>no photo</div>}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: C.panel, borderRadius: 8 }}>
        <thead><tr><th style={th}>Stripe</th><th style={th}>Draft</th><th style={th}>Camber</th><th style={th}>Twist</th><th style={th}>Entry</th><th style={th}>Exit</th><th style={th}>Front%</th><th style={th}>Back%</th></tr></thead>
        <tbody>
          {M.stripes.map((s) => (
            <tr key={s.pos}>
              <td style={{ ...td, fontWeight: 700, color }}>{s.pos}%</td>
              <td style={td}>{fmt(s.draft)}</td><td style={td}>{fmt(s.camber)}</td><td style={td}>{fmt(s.twist)}</td>
              <td style={td}>{fmt(s.entry, 0)}</td><td style={td}>{fmt(s.exit, 0)}</td><td style={td}>{fmt(s.fore)}</td><td style={td}>{fmt(s.back)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {M.design && M.design.sections.filter((s: any) => s.posPct !== 0).length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.dim, margin: '8px 0 3px' }}>
            Design ({M.design.sourceCode || M.cond.sail_code || '—'}) @ {fmt(M.design.tws, 0)} kn · % = ×100
            {M.design.substituted && <span style={{ color: C.warn }}> · outside window → {M.design.sourceCode}</span>}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: C.panel, borderRadius: 8 }}>
            <thead><tr><th style={th}>Stripe</th><th style={th}>Draft</th><th style={th}>Camber</th><th style={th}>Twist</th><th style={th}>Entry</th><th style={th}>Exit</th><th style={th}>Front%</th><th style={th}>Back%</th></tr></thead>
            <tbody>
              {M.design.sections.filter((s: any) => s.posPct !== 0).map((s: any) => (
                <tr key={s.posPct}>
                  <td style={{ ...td, fontWeight: 700, color: DESIGN_GREY }}>{s.posPct}%</td>
                  <td style={td}>{fmt(s.draft != null ? s.draft * 100 : null)}</td>
                  <td style={td}>{fmt(s.camber != null ? s.camber * 100 : null)}</td>
                  <td style={td}>{fmt(s.twist)}</td>
                  <td style={td}>{fmt(s.leadAngle, 0)}</td>
                  <td style={td}>{fmt(s.trailAngle, 0)}</td>
                  <td style={td}>{fmt(s.frontPct != null ? s.frontPct * 100 : null)}</td>
                  <td style={td}>{fmt(s.backPct != null ? s.backPct * 100 : null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1100, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '24px 12px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(1440px, 100%)', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, color: C.text }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: C.head }}>Sail comparison</span>
          {boatName && <span style={{ fontSize: 11, color: C.dim }}>{boatName}</span>}
          {models.map(({ M, color }, i) => (
            <span key={i} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}
              style={{ fontSize: 11, color, fontWeight: 700, cursor: 'pointer', opacity: hovered == null || hovered === i ? 1 : 0.35 }}>■ {M.name} {M.tws != null ? `@${fmt(M.tws, 0)}kt` : ''}</span>
          ))}
          <button onClick={onClose} style={{ marginLeft: 'auto', background: '#0F2A45', border: 'none', borderRadius: 8, color: C.text, fontWeight: 700, fontSize: 13, padding: '7px 12px', cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {models.map(({ scan, M, color, tag }, i) => (
            <Column key={i} scan={scan} M={M} color={color} tag={tag} />
          ))}
        </div>

        {/* shape charts — every measured line + each design */}
        <div style={{ fontSize: 12, fontWeight: 700, color: C.dim, margin: '16px 0 4px' }}>Shape charts (vs stripe height %)</div>
        <div style={{ fontSize: 11, color: C.dim, marginBottom: 6, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {models.map(({ M, color }, i) => (
            <span key={i} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}
              style={{ color, cursor: 'pointer', fontWeight: hovered === i ? 800 : 400, opacity: hovered == null || hovered === i ? 1 : 0.35 }}>━ {M.name}</span>
          ))}
          <span style={{ color: DESIGN_GREY }}>— — design (same colour, dashed)</span>
          <span style={{ color: C.dim, opacity: 0.7 }}>· hover a sail to highlight its curve</span>
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {METRICS.map((m) => {
            const series: Series[] = []
            models.forEach(({ M, color }, si) => {
              series.push({ xs: M.posXs, ys: M.stripes.map((s) => s[m.key] as number | null), color, idx: si })
              if (M.design) series.push({ xs: M.design.sections.map((s: any) => s.posPct), ys: M.design.sections.map((s: any) => (s[m.dKey] != null ? s[m.dKey] * m.dScale : null)), color, dash: '3 2', idx: si })
            })
            return (
              <div key={m.key} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ fontSize: 13, color: C.head, fontWeight: 700, marginBottom: 4 }}>{m.label}</div>
                <MultiLineChart series={series} hovered={hovered} onHover={setHovered} />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

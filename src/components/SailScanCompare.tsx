'use client'
// src/components/SailScanCompare.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Side-by-side comparison of two SailScan scans (e.g. the two photos/tacks of a
// North "Sail Comparison" report, or any two scans picked from the Sail-data
// list). Shows, per sail: a header line (TWS / rake / forestay / time), the
// analysed photo, the measured stripe table and its design-target table; then a
// row of shape charts overlaying BOTH measured lines plus each sail's design.
//
// Design targets reuse pickDesign() — main vs jib, TWS-window selection — exactly
// like the single detail view, interpolated to each scan's own TWS.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo } from 'react'
import { pickDesign, designCodeOf } from '../lib/designInterp'

const C = {
  bg: '#0A1929', panel: '#0d2236', border: '#1E3A5A', accent: '#06B6D4',
  head: '#E2E8F0', text: '#CBD5E1', dim: '#64748B', warn: '#F59E0B',
}
const A_COLOR = '#06B6D4' // sail A (left)
const B_COLOR = '#FBBF24' // sail B (right)
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

interface Series { xs: number[]; ys: (number | null)[]; color: string; dash?: string }

// Multi-series line chart with a fixed x-domain (0–100% stripe height). Ticks at
// their true coordinates so nothing reads beyond the axis.
function MultiLineChart({ series, w = 250, h = 96 }: { series: Series[]; w?: number; h?: number }) {
  const pad = { l: 30, r: 8, t: 8, b: 16 }
  const xMin = 0, xMax = 100
  const clean = (xs: number[], ys: (number | null)[]) =>
    ys.map((y, i) => ({ x: xs[i], y })).filter((p) => p.y != null && Number.isFinite(p.y as number) && p.x >= xMin && p.x <= xMax) as { x: number; y: number }[]
  const cleaned = series.map((s) => ({ ...s, pts: clean(s.xs, s.ys) }))
  const all = cleaned.flatMap((s) => s.pts)
  if (!all.length) return <div style={{ width: w, height: h, color: C.dim, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>no data</div>
  const ymin = Math.min(...all.map((p) => p.y)), ymax = Math.max(...all.map((p) => p.y))
  const ylo = ymin === ymax ? ymin - 1 : ymin, yhi = ymin === ymax ? ymax + 1 : ymax
  const px = (x: number) => pad.l + ((x - xMin) / (xMax - xMin)) * (w - pad.l - pad.r)
  const py = (y: number) => pad.t + (1 - (y - ylo) / (yhi - ylo || 1)) * (h - pad.t - pad.b)
  const path = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <line x1={pad.l} y1={py(yhi)} x2={w - pad.r} y2={py(yhi)} stroke={C.border} strokeWidth={0.5} />
      <line x1={pad.l} y1={py(ylo)} x2={w - pad.r} y2={py(ylo)} stroke={C.border} strokeWidth={0.5} />
      <text x={2} y={py(yhi) + 3} fontSize={9} fill={C.dim}>{yhi.toFixed(yhi % 1 ? 1 : 0)}</text>
      <text x={2} y={py(ylo) + 3} fontSize={9} fill={C.dim}>{ylo.toFixed(ylo % 1 ? 1 : 0)}</text>
      {cleaned.map((s, i) => s.pts.length ? <path key={i} d={path(s.pts)} fill="none" stroke={s.color} strokeWidth={s.dash ? 1.3 : 1.7} strokeDasharray={s.dash || undefined} /> : null)}
      {[0, 25, 50, 75, 100].map((t) => (
        <text key={t} x={px(t)} y={h - 3} fontSize={9} fill={C.dim} textAnchor={t === 0 ? 'start' : t === 100 ? 'end' : 'middle'}>{t}</text>
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

export default function SailScanCompare({ scanA, scanB, sails, tagA, tagB, boatName, onClose }:
  { scanA: any; scanB: any; sails: any[]; tagA?: any; tagB?: any; boatName?: string | null; onClose: () => void }) {
  const A = useMemo(() => scanModel(scanA, sails, tagA), [scanA, sails, tagA])
  const B = useMemo(() => scanModel(scanB, sails, tagB), [scanB, sails, tagB])

  const td: React.CSSProperties = { padding: '3px 6px', fontSize: 11, color: C.text, textAlign: 'center', borderBottom: `1px solid ${C.border}` }
  const th: React.CSSProperties = { ...td, color: C.dim, fontWeight: 700, fontSize: 10 }

  const timeOf = (scan: any) => {
    const cap = scan?.captured_at ? new Date(scan.captured_at) : null
    return cap ? cap.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
  }

  // One sail column: header line, photo, measured table, design table.
  const Column = ({ scan, M, color, tag }: { scan: any; M: ReturnType<typeof scanModel>; color: string; tag: any }) => (
    <div style={{ flex: '1 1 360px', minWidth: 300 }}>
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
      {M.design && M.design.sections.length > 0 && (
        <>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.dim, margin: '8px 0 3px' }}>
            Design ({M.design.sourceCode || M.cond.sail_code || '—'}) @ {fmt(M.design.tws, 0)} kn · % = ×100
            {M.design.substituted && <span style={{ color: C.warn }}> · outside window → {M.design.sourceCode}</span>}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: C.panel, borderRadius: 8 }}>
            <thead><tr><th style={th}>Stripe</th><th style={th}>Draft</th><th style={th}>Camber</th><th style={th}>Twist</th><th style={th}>Entry</th><th style={th}>Exit</th><th style={th}>Front%</th><th style={th}>Back%</th></tr></thead>
            <tbody>
              {M.design.sections.map((s: any) => (
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
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(1040px, 100%)', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, color: C.text }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: C.head }}>Sail comparison</span>
          {boatName && <span style={{ fontSize: 11, color: C.dim }}>{boatName}</span>}
          <span style={{ fontSize: 11, color: A_COLOR, fontWeight: 700 }}>■ {A.name} {A.tws != null ? `@${fmt(A.tws, 0)}kt` : ''}</span>
          <span style={{ fontSize: 11, color: B_COLOR, fontWeight: 700 }}>■ {B.name} {B.tws != null ? `@${fmt(B.tws, 0)}kt` : ''}</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: '#0F2A45', border: 'none', borderRadius: 8, color: C.text, fontWeight: 700, fontSize: 13, padding: '7px 12px', cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Column scan={scanA} M={A} color={A_COLOR} tag={tagA} />
          <Column scan={scanB} M={B} color={B_COLOR} tag={tagB} />
        </div>

        {/* shape charts — both measured lines + each design */}
        <div style={{ fontSize: 12, fontWeight: 700, color: C.dim, margin: '16px 0 4px' }}>Shape charts (vs stripe height %)</div>
        <div style={{ fontSize: 10, color: C.dim, marginBottom: 6 }}>
          <span style={{ color: A_COLOR }}>━ {A.name}</span> · <span style={{ color: B_COLOR }}>━ {B.name}</span> · <span style={{ color: DESIGN_GREY }}>— — design</span>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {METRICS.map((m) => {
            const series: Series[] = [
              { xs: A.posXs, ys: A.stripes.map((s) => s[m.key] as number | null), color: A_COLOR },
              { xs: B.posXs, ys: B.stripes.map((s) => s[m.key] as number | null), color: B_COLOR },
            ]
            if (A.design) series.push({ xs: A.design.sections.map((s: any) => s.posPct), ys: A.design.sections.map((s: any) => (s[m.dKey] != null ? s[m.dKey] * m.dScale : null)), color: A_COLOR, dash: '3 2' })
            if (B.design) series.push({ xs: B.design.sections.map((s: any) => s.posPct), ys: B.design.sections.map((s: any) => (s[m.dKey] != null ? s[m.dKey] * m.dScale : null)), color: B_COLOR, dash: '1 3' })
            return (
              <div key={m.key} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 8px' }}>
                <div style={{ fontSize: 11, color: C.head, fontWeight: 700, marginBottom: 2 }}>{m.label}</div>
                <MultiLineChart series={series} />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

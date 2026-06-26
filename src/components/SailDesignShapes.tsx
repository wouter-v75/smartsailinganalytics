'use client'
// src/components/SailDesignShapes.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Popup of a sail's DESIGN target shapes (from the North "Target sail shapes"
// CSV, parsed by lib/designShapeParse + stored in sails.specs.design_shapes).
// One SailScan-style table per TWS condition block (Main targets are also keyed
// by the paired jib). Sections shown head-first (100/87/75/50/25/0).
//
// Design metrics are normalised fractions (0–1) for front/draft/camber/back/
// lead/trail → shown ×100 as % to read like the measured SailScan; the angle
// columns are degrees.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'

const C = {
  bg: '#0A1929', panel: '#0d2236', border: '#1E3A5A', accent: '#06B6D4',
  head: '#E2E8F0', text: '#CBD5E1', dim: '#64748B',
}

const pct = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? '—' : (v * 100).toFixed(1))
const ang = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(1))

interface Section { posPct: number | null; section: number; frontPct: number | null; draft: number | null; camber: number | null; backPct: number | null; leadPct: number | null; trailPct: number | null; leadAngle: number | null; twist: number | null; trailAngle: number | null; sectionAngle: number | null }
interface Condition { tws: number | null; pairedJib: string | null; conditionName: string | null; sections: Section[] }

export default function SailDesignShapes({ sail, onClose }: { sail: any; onClose: () => void }) {
  const ds = sail?.specs?.design_shapes
  const conditions: Condition[] = Array.isArray(ds?.conditions) ? ds.conditions : []
  // sort blocks by paired jib then TWS
  const blocks = [...conditions].sort((a, b) => (String(a.pairedJib || '').localeCompare(String(b.pairedJib || ''))) || ((a.tws || 0) - (b.tws || 0)))

  const th: React.CSSProperties = { padding: '4px 8px', fontSize: 10, fontWeight: 700, color: C.dim, textAlign: 'center', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { padding: '4px 8px', fontSize: 12, color: C.text, textAlign: 'center', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1100, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '24px 12px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(820px, 100%)', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, color: C.text }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: C.head }}>{sail?.category || sail?.name} — design shapes</span>
          <span style={{ fontSize: 11, color: C.dim }}>{blocks.length} TWS block{blocks.length === 1 ? '' : 's'}{ds?.source_file ? ` · ${ds.source_file}` : ''}</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: '#0F2A45', border: 'none', borderRadius: 8, color: C.text, fontWeight: 700, fontSize: 13, padding: '7px 12px', cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ fontSize: 10, color: C.dim, marginBottom: 10 }}>front/draft/camber/back/lead/trail shown as % (design fractions ×100); angles in °.</div>

        {!blocks.length ? (
          <div style={{ color: C.dim, fontSize: 12 }}>No design shapes stored for this sail.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {blocks.map((b, i) => {
              const secs = [...(b.sections || [])].sort((a, s) => (s.posPct ?? -1) - (a.posPct ?? -1)) // head first
              return (
                <div key={i} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: C.accent, marginBottom: 6 }}>
                    {b.tws != null ? `${b.tws} kn TWS` : 'TWS —'}{b.pairedJib ? ` · with ${b.pairedJib}` : ''}
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', minWidth: 560 }}>
                      <thead>
                        <tr>
                          <th style={th}>Pos</th><th style={th}>Draft</th><th style={th}>Camber</th><th style={th}>Twist</th>
                          <th style={th}>Front%</th><th style={th}>Back%</th><th style={th}>Lead∠</th><th style={th}>Trail∠</th><th style={th}>Sec∠</th>
                        </tr>
                      </thead>
                      <tbody>
                        {secs.map((s, j) => (
                          <tr key={j}>
                            <td style={{ ...td, fontWeight: 700, color: C.accent }}>{s.posPct != null ? `${s.posPct}%` : `#${s.section}`}</td>
                            <td style={td}>{pct(s.draft)}</td><td style={td}>{pct(s.camber)}</td><td style={td}>{ang(s.twist)}</td>
                            <td style={td}>{pct(s.frontPct)}</td><td style={td}>{pct(s.backPct)}</td>
                            <td style={td}>{ang(s.leadAngle)}</td><td style={td}>{ang(s.trailAngle)}</td><td style={td}>{ang(s.sectionAngle)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

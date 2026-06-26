'use client'
// src/components/SailScanDetail.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Full SailScan detail, styled after the North NS Sailscan report: the analysed
// sail photo, header + measured loads, the stripe table (with Twist), per-metric
// charts, and the boat state in a ±2-min window around the capture (averages +
// graphs of TWS/TWA/AWS/AWA/PolarBSP% from the day's log). Plus a native Share
// button (WhatsApp / Email / AirDrop via the Web Share API).
//
// Opens as a modal from Boat Config → Sail shapes. Dependency-free charts (inline
// SVG) so it stays light inside the modal.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from 'react'

const C = {
  bg: '#0A1929', panel: '#0d2236', border: '#1E3A5A', accent: '#06B6D4',
  head: '#E2E8F0', text: '#CBD5E1', dim: '#64748B', good: '#10B981', warn: '#F59E0B',
}

const fmt = (v: any, d = 1) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d))
const fmtDateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

interface Stripe { pos: number; draft: number | null; camber: number | null; twist: number | null; entry: number | null; exit: number | null; fore: number | null; back: number | null }

// ── tiny inline SVG line chart ────────────────────────────────────────────────
function LineChart({ xs, ys, color = '#06B6D4', w = 230, h = 90, xLabel = '' }:
  { xs: number[]; ys: (number | null)[]; color?: string; w?: number; h?: number; xLabel?: string }) {
  const pad = { l: 30, r: 6, t: 8, b: 16 }
  const valid = ys.map((y, i) => ({ x: xs[i], y })).filter((p) => p.y != null && Number.isFinite(p.y as number)) as { x: number; y: number }[]
  if (valid.length < 1) return <div style={{ width: w, height: h, color: C.dim, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>no data</div>
  const xmin = Math.min(...xs), xmax = Math.max(...xs)
  const ymin = Math.min(...valid.map((p) => p.y)), ymax = Math.max(...valid.map((p) => p.y))
  const ylo = ymin === ymax ? ymin - 1 : ymin, yhi = ymin === ymax ? ymax + 1 : ymax
  const px = (x: number) => pad.l + ((x - xmin) / (xmax - xmin || 1)) * (w - pad.l - pad.r)
  const py = (y: number) => pad.t + (1 - (y - ylo) / (yhi - ylo || 1)) * (h - pad.t - pad.b)
  const d = valid.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <line x1={pad.l} y1={py(yhi)} x2={w - pad.r} y2={py(yhi)} stroke={C.border} strokeWidth={0.5} />
      <line x1={pad.l} y1={py(ylo)} x2={w - pad.r} y2={py(ylo)} stroke={C.border} strokeWidth={0.5} />
      <text x={2} y={py(yhi) + 3} fontSize={9} fill={C.dim}>{yhi.toFixed(yhi % 1 ? 1 : 0)}</text>
      <text x={2} y={py(ylo) + 3} fontSize={9} fill={C.dim}>{ylo.toFixed(ylo % 1 ? 1 : 0)}</text>
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} />
      {xLabel && <text x={(w + pad.l) / 2} y={h - 3} fontSize={9} fill={C.dim} textAnchor="middle">{xLabel}</text>}
    </svg>
  )
}

const METRICS: { key: keyof Stripe; label: string; color: string }[] = [
  { key: 'draft', label: 'Draft', color: '#06B6D4' },
  { key: 'camber', label: 'Camber', color: '#34D399' },
  { key: 'twist', label: 'Twist', color: '#FBBF24' },
  { key: 'entry', label: 'Entry', color: '#A78BFA' },
  { key: 'exit', label: 'Exit', color: '#F472B6' },
  { key: 'fore', label: 'Front%', color: '#60A5FA' },
  { key: 'back', label: 'Back%', color: '#FB923C' },
]

const WIND: { key: string; label: string; color: string }[] = [
  { key: 'tws', label: 'TWS (kt)', color: '#06B6D4' },
  { key: 'twa', label: 'TWA (°)', color: '#34D399' },
  { key: 'aws', label: 'AWS (kt)', color: '#FBBF24' },
  { key: 'awa', label: 'AWA (°)', color: '#A78BFA' },
  { key: 'polarBspPct', label: 'Polar BSP %', color: '#F472B6' },
]

export default function SailScanDetail({ scan, teamId, sailName, onClose }:
  { scan: any; teamId: string; sailName?: string | null; onClose: () => void }) {
  const cond = scan?.conditions || {}
  const stripes: Stripe[] = useMemo(
    () => (Array.isArray(scan?.stripes) ? [...scan.stripes].sort((a: Stripe, b: Stripe) => a.pos - b.pos) : []),
    [scan]
  )
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [win, setWin] = useState<any>(null)
  const [winLoaded, setWinLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    if (cond.photo_key) {
      fetch(`/api/teams/${teamId}/sail-scans/${scan.id}/photo-url`).then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j?.url) setPhotoUrl(j.url) }).catch(() => {})
    }
    fetch(`/api/teams/${teamId}/sail-scans/${scan.id}/conditions`).then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive) { setWin(j?.window || null); setWinLoaded(true) } }).catch(() => { if (alive) setWinLoaded(true) })
    return () => { alive = false }
  }, [scan?.id, teamId, cond.photo_key])

  const title = sailName || cond.sail_name_in_report || cond.sail_code || 'Sail scan'
  const posXs = stripes.map((s) => s.pos)

  const share = async () => {
    const a = win?.averages || {}
    const lines = [
      `SailScan — ${title}`,
      cond.sail_code ? `Code ${cond.sail_code}` : '',
      `${fmtDateTime(scan.captured_at)}`,
      scan.tws_kn != null ? `TWS ${fmt(scan.tws_kn)} kt` : '',
      cond.forestay_t != null ? `Forestay ${fmt(cond.forestay_t)} T` : '',
      a.polarBspPct != null ? `Polar ${fmt(a.polarBspPct, 0)}%` : '',
    ].filter(Boolean)
    const data: any = { title: `SailScan — ${title}`, text: lines.join('\n') }
    if (photoUrl) data.url = photoUrl
    try {
      if (navigator.share) { await navigator.share(data) }
      else { await navigator.clipboard?.writeText(lines.join('\n') + (photoUrl ? `\n${photoUrl}` : '')); alert('Copied scan summary to clipboard.') }
    } catch { /* user cancelled */ }
  }

  const td: React.CSSProperties = { padding: '4px 8px', fontSize: 12, color: C.text, textAlign: 'center', borderBottom: `1px solid ${C.border}` }
  const th: React.CSSProperties = { ...td, color: C.dim, fontWeight: 700, fontSize: 11 }
  const kv = (k: string, v: any) => (
    <span style={{ fontSize: 12, color: C.text }}><span style={{ color: C.dim }}>{k} </span><b>{v}</b></span>
  )

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '24px 12px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(960px, 100%)', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, color: C.text }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: C.head }}>{title}</span>
          {cond.sail_code && <span style={{ fontSize: 11, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 6px' }}>{cond.sail_code}</span>}
          {cond.sail_type && <span style={{ fontSize: 11, color: cond.sail_type === 'main' ? '#34D399' : '#FBBF24' }}>{cond.sail_type}</span>}
          <span style={{ fontSize: 12, color: C.dim }}>{fmtDateTime(scan.captured_at)}</span>
          <div style={{ flex: 1 }} />
          <button onClick={share} style={{ background: C.accent, border: 'none', borderRadius: 8, color: '#001018', fontWeight: 700, fontSize: 13, padding: '7px 14px', cursor: 'pointer' }}>↗ Share</button>
          <button onClick={onClose} style={{ background: '#0F2A45', border: 'none', borderRadius: 8, color: C.text, fontWeight: 700, fontSize: 13, padding: '7px 12px', cursor: 'pointer' }}>✕</button>
        </div>

        {/* loads at capture */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
          {scan.tws_kn != null && kv('TWS', `${fmt(scan.tws_kn)} kt`)}
          {cond.forestay_t != null && kv('Forestay', `${fmt(cond.forestay_t)} T`)}
          {cond.rake_deg != null && kv('Rake', `${fmt(cond.rake_deg, 2)}°`)}
          {cond.jib_tack_t != null && kv('Jib tack', `${fmt(cond.jib_tack_t)} T`)}
          {cond.oe_number && kv('OE#', cond.oe_number)}
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {/* photo */}
          <div style={{ flex: '1 1 320px', minWidth: 280 }}>
            {cond.photo_key ? (
              photoUrl ? (
                <img src={photoUrl} alt="sail scan" style={{ width: '100%', borderRadius: 8, border: `1px solid ${C.border}` }} />
              ) : (
                <div style={{ width: '100%', height: 240, background: C.panel, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 12 }}>loading photo…</div>
              )
            ) : (
              <div style={{ width: '100%', height: 120, background: C.panel, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 12 }}>No photo (re-import the PDF to capture it)</div>
            )}
          </div>

          {/* stripe table */}
          <div style={{ flex: '1 1 360px', minWidth: 320 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', background: C.panel, borderRadius: 8 }}>
              <thead>
                <tr><th style={th}>Stripe</th><th style={th}>Draft</th><th style={th}>Camber</th><th style={th}>Twist</th><th style={th}>Entry</th><th style={th}>Exit</th><th style={th}>Front%</th><th style={th}>Back%</th></tr>
              </thead>
              <tbody>
                {stripes.map((s) => (
                  <tr key={s.pos}>
                    <td style={{ ...td, fontWeight: 700, color: C.accent }}>{s.pos}%</td>
                    <td style={td}>{fmt(s.draft)}</td><td style={td}>{fmt(s.camber)}</td><td style={td}>{fmt(s.twist)}</td>
                    <td style={td}>{fmt(s.entry, 0)}</td><td style={td}>{fmt(s.exit, 0)}</td><td style={td}>{fmt(s.fore)}</td><td style={td}>{fmt(s.back)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* per-metric charts (value vs stripe %) */}
        <div style={{ fontSize: 12, fontWeight: 700, color: C.dim, margin: '16px 0 6px' }}>Shape charts (vs stripe height %)</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {METRICS.map((m) => (
            <div key={m.key} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 8px' }}>
              <div style={{ fontSize: 11, color: C.head, fontWeight: 700, marginBottom: 2 }}>{m.label}</div>
              <LineChart xs={posXs} ys={stripes.map((s) => s[m.key] as number | null)} color={m.color} xLabel="0 · 25 · 50 · 75 · 100" />
            </div>
          ))}
        </div>

        {/* 2-minute window: averages + graphs */}
        <div style={{ fontSize: 12, fontWeight: 700, color: C.dim, margin: '18px 0 6px' }}>
          Boat state · 2-min window {win ? `(${win.count} pts)` : ''}
        </div>
        {!winLoaded ? (
          <div style={{ color: C.dim, fontSize: 12 }}>matching the day’s log…</div>
        ) : !win ? (
          <div style={{ color: C.dim, fontSize: 12 }}>No log found for this boat/day, or the scan time isn’t covered by the log.</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
              {kv('TWS', `${fmt(win.averages.tws)} kt`)}
              {kv('TWA', `${fmt(win.averages.twa, 0)}°`)}
              {kv('AWS', `${fmt(win.averages.aws)} kt`)}
              {kv('AWA', `${fmt(win.averages.awa, 0)}°`)}
              {kv('Polar BSP', `${fmt(win.averages.polarBspPct, 0)}%`)}
              {kv('Forestay', `${fmt(win.averages.forestay)}`)}
              {kv('Rake', `${fmt(win.averages.rake, 2)}`)}
              {kv('Jib tack', `${fmt(win.averages.jibTackLoad)}`)}
              {kv('Cunningham', `${fmt(win.averages.cunninghamLoad)}`)}
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {WIND.map((wf) => {
                const ys: (number | null)[] = win.series[wf.key] || []
                const t0 = win.series.utc?.[0] || 0
                const xs = (win.series.utc || []).map((u: number) => (u - t0) / 1000)
                return (
                  <div key={wf.key} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 8px' }}>
                    <div style={{ fontSize: 11, color: C.head, fontWeight: 700, marginBottom: 2 }}>{wf.label}</div>
                    <LineChart xs={xs} ys={ys} color={wf.color} xLabel="seconds" />
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

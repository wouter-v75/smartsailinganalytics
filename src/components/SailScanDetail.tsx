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
import { getLogData } from '../lib/localStore'
import { computeScanWindow } from '../lib/scanConditions'
import { scanLocalDateTime } from '../lib/scanTime'
import { pickDesign, designCodeOf } from '../lib/designInterp'

const DESIGN_GREY = '#94A3B8'

const C = {
  bg: '#0A1929', panel: '#0d2236', border: '#1E3A5A', accent: '#06B6D4',
  head: '#E2E8F0', text: '#CBD5E1', dim: '#64748B', good: '#10B981', warn: '#F59E0B',
}

const fmt = (v: any, d = 1) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d))
const fmtDateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

interface Stripe { pos: number; draft: number | null; camber: number | null; twist: number | null; entry: number | null; exit: number | null; fore: number | null; back: number | null }

// jsPDF (UMD) loaded once from CDN for the Share-as-PDF action.
let jspdfPromise: Promise<any> | null = null
function loadJsPdf(): Promise<any> {
  const w = window as any
  if (w.jspdf?.jsPDF) return Promise.resolve(w.jspdf.jsPDF)
  if (!jspdfPromise) {
    jspdfPromise = new Promise((res, rej) => {
      const s = document.createElement('script')
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
      s.onload = () => res((window as any).jspdf.jsPDF)
      s.onerror = () => rej(new Error('failed to load jsPDF'))
      document.head.appendChild(s)
    })
  }
  return jspdfPromise
}
// Draw a small line chart directly into a jsPDF doc (mm units). xs/ys are data;
// rgb is the line colour. Returns nothing — caller manages layout.
function pdfLineChart(doc: any, x: number, y: number, w: number, h: number, xs: number[], ys: (number | null)[], rgb: number[], label: string) {
  doc.setFontSize(7); doc.setTextColor(40); doc.text(label, x, y - 1)
  doc.setDrawColor(210); doc.setLineWidth(0.2)
  doc.rect(x, y, w, h)
  const pts = ys.map((v, i) => ({ x: xs[i], y: v })).filter((p) => p.y != null && Number.isFinite(p.y as number)) as { x: number; y: number }[]
  if (pts.length < 1) { doc.setFontSize(6); doc.setTextColor(150); doc.text('no data', x + w / 2 - 3, y + h / 2); return }
  pts.sort((a, b) => a.x - b.x)
  const xmin = Math.min(...xs), xmax = Math.max(...xs)
  const ymin = Math.min(...pts.map((p) => p.y)), ymax = Math.max(...pts.map((p) => p.y))
  const ylo = ymin === ymax ? ymin - 1 : ymin, yhi = ymin === ymax ? ymax + 1 : ymax
  doc.setFontSize(6); doc.setTextColor(120)
  doc.text(String(Math.round(yhi)), x + 0.5, y + 3)
  doc.text(String(Math.round(ylo)), x + 0.5, y + h - 0.5)
  const px = (vx: number) => x + 4 + ((vx - xmin) / (xmax - xmin || 1)) * (w - 5)
  const py = (vy: number) => y + 2 + (1 - (vy - ylo) / (yhi - ylo || 1)) * (h - 4)
  doc.setDrawColor(rgb[0], rgb[1], rgb[2]); doc.setLineWidth(0.5)
  const sm = crSamples(pts.map((p) => ({ x: px(p.x), y: py(p.y) })))
  for (let i = 1; i < sm.length; i++) doc.line(sm[i - 1].x, sm[i - 1].y, sm[i].x, sm[i].y)
}

// Catmull-Rom sampled polyline (smooth PDF line; jsPDF has no native spline).
function crSamples(p: { x: number; y: number }[], seg = 16): { x: number; y: number }[] {
  if (p.length < 3) return p
  const out: { x: number; y: number }[] = [p[0]]
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2
    for (let t = 1; t <= seg; t++) {
      const s = t / seg, s2 = s * s, s3 = s2 * s
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * s + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * s2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * s3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * s + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * s2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * s3),
      })
    }
  }
  return out
}

// Best-effort: render an image URL to a JPEG data-URL via canvas (needs CORS on
// the source; returns null if the canvas would be tainted).
function imgToDataUrl(url: string): Promise<{ dataUrl: string; w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const cv = document.createElement('canvas')
        cv.width = img.naturalWidth; cv.height = img.naturalHeight
        cv.getContext('2d')!.drawImage(img, 0, 0)
        resolve({ dataUrl: cv.toDataURL('image/jpeg', 0.85), w: img.naturalWidth, h: img.naturalHeight })
      } catch { resolve(null) }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

// Smooth Catmull-Rom → cubic-Bézier through pixel points (sorted by x).
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

// ── inline SVG spline chart (+ optional grey design overlay) ──────────────────
// `hovered`: 'm' = measured emphasised, 'd' = design emphasised, null = both.
function LineChart({ xs, ys, color = '#06B6D4', overlay, w = 460, h = 200, xLabel = '', xMin, xMax, xTicks, hovered = null, onHover }:
  { xs: number[]; ys: (number | null)[]; color?: string; overlay?: { xs: number[]; ys: (number | null)[]; color?: string }; w?: number; h?: number; xLabel?: string; xMin?: number; xMax?: number; xTicks?: number[]; hovered?: 'm' | 'd' | null; onHover?: (h: 'm' | 'd' | null) => void }) {
  const pad = { l: 40, r: 10, t: 12, b: 22 }
  const inDomain = (x: number) => (xMin == null || x >= xMin) && (xMax == null || x <= xMax)
  const clean = (cxs: number[], cys: (number | null)[]) =>
    (cys.map((y, i) => ({ x: cxs[i], y })).filter((p) => p.y != null && Number.isFinite(p.y as number) && inDomain(p.x)) as { x: number; y: number }[])
      .sort((a, b) => a.x - b.x)
  const valid = clean(xs, ys)
  const ov = overlay ? clean(overlay.xs, overlay.ys) : []
  const all = [...valid, ...ov]
  if (!all.length) return <div style={{ width: w, height: h, color: C.dim, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>no data</div>
  const xmin = xMin != null ? xMin : Math.min(...all.map((p) => p.x)), xmax = xMax != null ? xMax : Math.max(...all.map((p) => p.x))
  const ymin = Math.min(...all.map((p) => p.y)), ymax = Math.max(...all.map((p) => p.y))
  const ylo = ymin === ymax ? ymin - 1 : ymin, yhi = ymin === ymax ? ymax + 1 : ymax
  const px = (x: number) => pad.l + ((x - xmin) / (xmax - xmin || 1)) * (w - pad.l - pad.r)
  const py = (y: number) => pad.t + (1 - (y - ylo) / (yhi - ylo || 1)) * (h - pad.t - pad.b)
  const path = (pts: { x: number; y: number }[]) => splinePath(pts.map((p) => ({ x: px(p.x), y: py(p.y) })))
  const mOp = hovered == null || hovered === 'm' ? 1 : 0.15
  const dOp = hovered == null || hovered === 'd' ? 1 : 0.15
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <line x1={pad.l} y1={py(yhi)} x2={w - pad.r} y2={py(yhi)} stroke={C.border} strokeWidth={0.5} />
      <line x1={pad.l} y1={py(ylo)} x2={w - pad.r} y2={py(ylo)} stroke={C.border} strokeWidth={0.5} />
      <text x={4} y={py(yhi) + 4} fontSize={12} fill={C.dim}>{yhi.toFixed(yhi % 1 ? 1 : 0)}</text>
      <text x={4} y={py(ylo) + 4} fontSize={12} fill={C.dim}>{ylo.toFixed(ylo % 1 ? 1 : 0)}</text>
      {ov.length > 0 && (
        <path d={path(ov)} fill="none" stroke={overlay?.color || DESIGN_GREY} strokeWidth={hovered === 'd' ? 3 : 1.6} strokeDasharray="3 2" strokeOpacity={dOp}
          onMouseEnter={() => onHover?.('d')} onMouseLeave={() => onHover?.(null)} style={{ cursor: onHover ? 'pointer' : 'default' }} />
      )}
      <path d={path(valid)} fill="none" stroke={color} strokeWidth={hovered === 'm' ? 4.2 : 2.4} strokeOpacity={mOp}
        onMouseEnter={() => onHover?.('m')} onMouseLeave={() => onHover?.(null)} style={{ cursor: onHover ? 'pointer' : 'default' }} />
      {xTicks
        ? xTicks.map((t) => (
            <text key={t} x={px(t)} y={h - 5} fontSize={12} fill={C.dim}
              textAnchor={t === xmin ? 'start' : t === xmax ? 'end' : 'middle'}>{t}</text>
          ))
        : xLabel && <text x={(w + pad.l) / 2} y={h - 5} fontSize={12} fill={C.dim} textAnchor="middle">{xLabel}</text>}
    </svg>
  )
}

const METRICS: { key: keyof Stripe; label: string; color: string; dKey: string; dScale: number }[] = [
  { key: 'draft', label: 'Draft', color: '#06B6D4', dKey: 'draft', dScale: 100 },
  { key: 'camber', label: 'Camber', color: '#34D399', dKey: 'camber', dScale: 100 },
  { key: 'twist', label: 'Twist', color: '#FBBF24', dKey: 'twist', dScale: 1 },
  { key: 'entry', label: 'Entry', color: '#A78BFA', dKey: 'leadAngle', dScale: 1 },
  { key: 'exit', label: 'Exit', color: '#F472B6', dKey: 'trailAngle', dScale: 1 },
  { key: 'fore', label: 'Front%', color: '#60A5FA', dKey: 'frontPct', dScale: 100 },
  { key: 'back', label: 'Back%', color: '#FB923C', dKey: 'backPct', dScale: 100 },
]

const WIND: { key: string; label: string; color: string }[] = [
  { key: 'tws', label: 'TWS (kt)', color: '#06B6D4' },
  { key: 'twa', label: 'TWA (°)', color: '#34D399' },
  { key: 'aws', label: 'AWS (kt)', color: '#FBBF24' },
  { key: 'awa', label: 'AWA (°)', color: '#A78BFA' },
  { key: 'vsPerfPct', label: 'Polar BSP %', color: '#F472B6' },
]

export default function SailScanDetail({ scan, teamId, sails = [], canEdit = false, tags, boatName, sailName, onReassign, onSaveNotes, onDelete, onClose, sessionTzOffset = 0 }:
  { scan: any; teamId: string; sails?: any[]; canEdit?: boolean; tags?: any; boatName?: string | null; sailName?: string | null; onReassign?: (sailId: string | null) => Promise<void>; onSaveNotes?: (notes: string) => Promise<void>; onDelete?: () => Promise<void>; onClose: () => void; sessionTzOffset?: number }) {
  const cond = scan?.conditions || {}
  // Head at the top (87% / 75% for jibs) down to 25% at the foot — matches the
  // North report layout.
  const stripes: Stripe[] = useMemo(
    () => (Array.isArray(scan?.stripes) ? [...scan.stripes].sort((a: Stripe, b: Stripe) => b.pos - a.pos) : []),
    [scan]
  )
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [photoErr, setPhotoErr] = useState<string | null>(null)
  const [win, setWin] = useState<any>(null)
  const [winLoaded, setWinLoaded] = useState(false)
  const [winSource, setWinSource] = useState<string>('') // 'local' | 'cloud' | ''
  const [editing, setEditing] = useState(false)
  const [sailIdSel, setSailIdSel] = useState<string>(scan?.sail_id || '')
  const [busy, setBusy] = useState(false)
  const [notes, setNotes] = useState<string>(scan?.notes || '')
  const [notesBusy, setNotesBusy] = useState(false)
  const [notesMsg, setNotesMsg] = useState('')
  const [shapeHover, setShapeHover] = useState<'m' | 'd' | null>(null) // highlight measured vs design
  const saveNotes = async () => {
    if (!onSaveNotes) return
    setNotesBusy(true); setNotesMsg('')
    try { await onSaveNotes(notes); setNotesMsg('Saved') } catch (e: any) { setNotesMsg(e?.message || 'Save failed') } finally { setNotesBusy(false) }
  }

  useEffect(() => {
    let alive = true
    // Photo
    if (cond.photo_key) {
      fetch(`/api/teams/${teamId}/sail-scans/${scan.id}/photo-url`)
        .then((r) => r.json())
        .then((j) => { if (!alive) return; if (j?.url) setPhotoUrl(j.url); else setPhotoErr(j?.error || 'could not load photo') })
        .catch((e) => { if (alive) setPhotoErr(String(e?.message || e)) })
    }
    // 2-min window: prefer the local log (where a just-uploaded log lives), fall
    // back to the cloud session log.
    const ms = scan?.captured_at ? new Date(scan.captured_at).getTime() : NaN
    const localDate = (cond.captured_local || scan?.captured_at || '').slice(0, 10)
    ;(async () => {
      let w: any = null; let src = ''
      try {
        if (localDate && Number.isFinite(ms)) {
          const ld: any = await getLogData(localDate)
          const rows: any[] = Array.isArray(ld) ? ld : Array.isArray(ld?.rows) ? ld.rows : []
          if (rows.length) { w = computeScanWindow(rows, ms, 120); if (w) src = 'local' }
        }
      } catch { /* ignore local errors */ }
      if (!w) {
        try {
          const j = await fetch(`/api/teams/${teamId}/sail-scans/${scan.id}/conditions`).then((r) => r.json())
          if (j?.window) { w = j.window; src = 'cloud' }
        } catch { /* ignore */ }
      }
      if (alive) { setWin(w); setWinSource(src); setWinLoaded(true) }
    })()
    return () => { alive = false }
  }, [scan?.id, teamId, cond.photo_key]) // eslint-disable-line react-hooks/exhaustive-deps

  const activeSails = (sails || []).filter((s) => !s.retired)
  const doReassign = async () => {
    if (!onReassign) return
    setBusy(true)
    try { await onReassign(sailIdSel || null); setEditing(false) } finally { setBusy(false) }
  }
  const doDelete = async () => {
    if (!onDelete) return
    if (!window.confirm('Delete this scan? This cannot be undone.')) return
    setBusy(true)
    try { await onDelete() } finally { setBusy(false) }
  }

  const title = sailName || cond.sail_name_in_report || cond.sail_code || 'Sail scan'
  const posXs = stripes.map((s) => s.pos)

  const [sharing, setSharing] = useState(false)
  const share = async (download = false) => {
    setSharing(true)
    try {
      // Make sure we have the 2-min window (compute from the local log if the
      // effect hasn't finished, so the PDF always carries the data when present).
      let w2 = win
      if (!w2 && scan?.captured_at) {
        const ms = new Date(scan.captured_at).getTime()
        const localDate = (cond.captured_local || scan.captured_at || '').slice(0, 10)
        try {
          const ld: any = await getLogData(localDate)
          const rows: any[] = Array.isArray(ld) ? ld : Array.isArray(ld?.rows) ? ld.rows : []
          if (rows.length) w2 = computeScanWindow(rows, ms, 120)
        } catch { /* none */ }
      }
      const a = w2?.averages || {}
      // tags fall back into the averages when the log lacks a field.
      const avgTws = a.tws ?? tags?.avgTws ?? scan?.tws_kn ?? null
      const avgTwa = a.twa ?? tags?.avgTwa ?? null

      const jsPDF = await loadJsPdf()
      const doc = new jsPDF({ unit: 'mm', format: 'a4' })
      const PW = 210, PH = 297, M = 12
      let y = 16
      const need = (mm: number) => { if (y + mm > PH - M) { doc.addPage(); y = M + 4 } }

      // Title: boat name — sail
      doc.setFontSize(16); doc.setTextColor(20); doc.setFont('helvetica', 'bold')
      doc.text([boatName, String(title)].filter(Boolean).join(' — '), M, y); y += 7
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(90)
      doc.text([scanLocalDateTime(scan, sessionTzOffset), cond.sail_code ? `Code ${cond.sail_code}` : '', cond.sail_type || ''].filter(Boolean).join('   ·   '), M, y); y += 6
      // tags (same as the thumbnail overview)
      const tg: string[] = []
      if (tags?.pointOfSail) tg.push(tags.pointOfSail)
      ;(tags?.activeSails || []).forEach((s: string) => tg.push(s))
      if (tags?.location) tg.push(`📍 ${tags.location}`)
      tg.push(`TWS ${fmt(avgTws)} kt`, `TWA ${avgTwa != null ? fmt(avgTwa, 0) : '—'}°`)
      doc.setTextColor(60); doc.text(tg.join('  ·  '), M, y); y += 6
      const loads: string[] = []
      if (scan.tws_kn != null) loads.push(`Report TWS ${fmt(scan.tws_kn)}kt`)
      if (cond.forestay_t != null) loads.push(`Forestay ${fmt(cond.forestay_t)}T`)
      if (cond.rake_deg != null) loads.push(`Rake ${fmt(cond.rake_deg, 2)}`)
      if (cond.jib_tack_t != null) loads.push(`JibTack ${fmt(cond.jib_tack_t)}T`)
      if (loads.length) { doc.text(loads.join('    '), M, y); y += 6 }

      // photo + stripe table side by side
      const tableTop = y
      let photoBottom = y
      if (photoUrl) {
        const pic = await imgToDataUrl(photoUrl)
        if (pic) { const w = 85, h = Math.min(110, (w * pic.h) / pic.w); doc.addImage(pic.dataUrl, 'JPEG', M, y, w, h); photoBottom = y + h }
      }
      // table to the right of the photo (or below if no photo)
      const tx = photoUrl ? M + 90 : M
      let ty = photoUrl ? tableTop : y
      const cols = ['St', 'Draft', 'Camb', 'Twist', 'Ent', 'Exit', 'Fr%', 'Bk%']
      const cw = [10, 14, 14, 14, 12, 12, 14, 14]
      const drawRow = (cells: string[], bold = false) => {
        doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(8); doc.setTextColor(20)
        let x = tx
        cells.forEach((c, i) => { doc.text(c, x, ty); x += cw[i] })
        ty += 5
      }
      drawRow(cols, true)
      for (const s of stripes) drawRow([`${s.pos}%`, fmt(s.draft), fmt(s.camber), fmt(s.twist), fmt(s.entry, 0), fmt(s.exit, 0), fmt(s.fore), fmt(s.back)])
      doc.setFont('helvetica', 'normal')
      y = Math.max(photoBottom, ty) + 6

      // 2-min averages line (full)
      doc.setFontSize(10); doc.setTextColor(60)
      doc.text(`2-min avg — TWS ${fmt(avgTws)} · TWA ${avgTwa != null ? fmt(avgTwa, 0) : '—'}° · AWS ${fmt(a.aws)} · AWA ${fmt(a.awa, 0)}° · Polar ${fmt(a.vsPerfPct, 0)}%`, M, y); y += 7
      if (notes && notes.trim()) {
        doc.setFontSize(9); doc.setTextColor(40)
        const wrapped = doc.splitTextToSize(`Notes: ${notes.trim()}`, PW - 2 * M)
        need(wrapped.length * 4 + 2); doc.text(wrapped, M, y); y += wrapped.length * 4 + 3
      }

      // shape charts (value vs stripe %)
      const posXs2 = stripes.map((s) => s.pos)
      const cwd = (PW - 2 * M - 8) / 3, chh = 26
      const rgbOf = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
      doc.setFontSize(11); doc.setTextColor(30); doc.text('Shape charts', M, y); y += 4
      METRICS.forEach((m, i) => {
        const col = i % 3, row = Math.floor(i / 3)
        if (col === 0) { if (row > 0) y += chh + 8; need(chh + 6) }
        pdfLineChart(doc, M + col * (cwd + 4), y + 3, cwd, chh, posXs2, stripes.map((s) => s[m.key] as number | null), rgbOf(m.color), m.label)
      })
      y += chh + 10

      // 2-min wind graphs
      if (w2?.series) {
        need(10); doc.setFontSize(11); doc.setTextColor(30); doc.text('2-min graphs', M, y); y += 4
        const t0 = w2.series.utc?.[0] || 0
        const xs = (w2.series.utc || []).map((u: number) => (u - t0) / 1000)
        WIND.forEach((wf, i) => {
          const col = i % 3, row = Math.floor(i / 3)
          if (col === 0) { if (row > 0) y += chh + 8; need(chh + 6) }
          pdfLineChart(doc, M + col * (cwd + 4), y + 3, cwd, chh, xs, w2.series[wf.key] || [], rgbOf(wf.color), wf.label)
        })
        y += chh + 8
      }

      const blob = doc.output('blob') as Blob
      const file = new File([blob], `SailScan_${[boatName, String(title)].filter(Boolean).join('_').replace(/[^\w.-]+/g, '_')}.pdf`, { type: 'application/pdf' })
      const nav = navigator as any
      if (!download && nav.canShare && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: `SailScan — ${title}` })
      } else {
        const url = URL.createObjectURL(blob)
        const a2 = document.createElement('a'); a2.href = url; a2.download = file.name; a2.click()
        setTimeout(() => URL.revokeObjectURL(url), 4000)
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') alert('Could not generate the PDF: ' + (e?.message || e))
    } finally { setSharing(false) }
  }

  // ── DESIGN target shapes — pick the scan's sail's design, interpolated to the
  // measured TWS (2-min avg → report TWS), clamped to the design window. ──
  const targetSail = useMemo(() => (sails || []).find((s) => s.id === scan?.sail_id) || null, [sails, scan?.sail_id])
  const activeJib = useMemo(() => (tags?.activeSails || []).map(designCodeOf).find((c: any) => c && c !== 'MN') || null, [tags])
  const designTws = win?.averages?.tws ?? tags?.avgTws ?? scan?.tws_kn ?? null
  const design = useMemo(() => pickDesign(sails || [], targetSail, activeJib, designTws), [sails, targetSail, activeJib, designTws])
  const designByPos = useMemo(() => {
    const m: Record<number, any> = {}
    ;(design?.sections || []).forEach((s: any) => { if (s.posPct != null) m[s.posPct] = s })
    return m
  }, [design])

  const td: React.CSSProperties = { padding: '4px 8px', fontSize: 12, color: C.text, textAlign: 'center', borderBottom: `1px solid ${C.border}` }
  const th: React.CSSProperties = { ...td, color: C.dim, fontWeight: 700, fontSize: 11 }
  const kv = (k: string, v: any) => (
    <span style={{ fontSize: 12, color: C.text }}><span style={{ color: C.dim }}>{k} </span><b>{v}</b></span>
  )
  // Which rig controls to surface in the 2-min window depends on the sail being
  // scanned: mainsail trim (outhaul/vang/cunningham/deflectors/traveller + the
  // V0/V1 batten positions) on MAIN scans, headsail trim (jib tack + the
  // up/down + in/out positions) on JIB (headsail) scans. sail_type = 'main' |
  // 'headsail' (null ⇒ unknown, show neither sail-specific set).
  const isMain = cond.sail_type === 'main'
  const isHeadsail = cond.sail_type === 'headsail'
  // Top stripe by sail type: mains have an 87% stripe, jibs (headsails) 75%.
  // Drop design stripes above that (e.g. the 100% design row on mains) from both
  // the table and the charts, and stop the graphs at that height.
  const maxStripe = isMain ? 87 : isHeadsail ? 75 : 100
  const xTicksArr = maxStripe === 75 ? [25, 50, 75] : maxStripe === 87 ? [25, 50, 75, 87] : [25, 50, 75, 100]
  const designSections = (design?.sections || []).filter((s: any) => s.posPct !== 0 && s.posPct <= maxStripe)

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '24px 12px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(1440px, 100%)', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, color: C.text }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: C.head }}>{title}</span>
          {cond.sail_code && <span style={{ fontSize: 11, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 6px' }}>{cond.sail_code}</span>}
          {cond.sail_type && <span style={{ fontSize: 11, color: cond.sail_type === 'main' ? '#34D399' : '#FBBF24' }}>{cond.sail_type}</span>}
          <span style={{ fontSize: 12, color: C.dim }}>{scanLocalDateTime(scan, sessionTzOffset)}</span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginLeft: 'auto', marginRight: 64, marginTop: 10 }}>
            {canEdit && <button onClick={() => { setSailIdSel(scan?.sail_id || ''); setEditing((v) => !v) }} disabled={busy} style={{ background: '#0F2A45', border: `1px solid ${C.border}`, borderRadius: 9, color: C.head, fontWeight: 700, fontSize: 15, padding: '10px 18px', cursor: 'pointer' }}>✎ Edit</button>}
            {canEdit && <button onClick={doDelete} disabled={busy} style={{ background: '#3a1320', border: '1px solid #7f1d1d', borderRadius: 9, color: '#fca5a5', fontWeight: 700, fontSize: 15, padding: '10px 18px', cursor: 'pointer' }}>🗑 Delete</button>}
            <button onClick={() => share(false)} disabled={sharing} style={{ background: C.accent, border: 'none', borderRadius: 9, color: '#001018', fontWeight: 700, fontSize: 15, padding: '10px 20px', cursor: 'pointer', opacity: sharing ? 0.6 : 1 }}>{sharing ? 'Building PDF…' : '↗ Share PDF'}</button>
            <button onClick={() => share(true)} disabled={sharing} style={{ background: '#0F2A45', border: `1px solid ${C.border}`, borderRadius: 9, color: C.head, fontWeight: 700, fontSize: 15, padding: '10px 18px', cursor: 'pointer', opacity: sharing ? 0.6 : 1 }}>⬇ Download</button>
            <button onClick={onClose} style={{ background: '#0F2A45', border: 'none', borderRadius: 9, color: C.text, fontWeight: 700, fontSize: 15, padding: '10px 18px', cursor: 'pointer' }}>✕</button>
          </div>
        </div>

        {editing && canEdit && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: C.dim }}>Sail tag</span>
            <select value={sailIdSel} onChange={(e) => setSailIdSel(e.target.value)} style={{ background: '#0a1c2e', border: `1px solid ${C.border}`, borderRadius: 6, color: C.head, padding: '5px 7px', fontSize: 12 }}>
              <option value="">— unassigned —</option>
              {activeSails.map((s) => <option key={s.id} value={s.id}>{s.category ? `${s.category} · ${s.name}` : s.name}</option>)}
            </select>
            <button onClick={doReassign} disabled={busy} style={{ background: C.good, border: 'none', borderRadius: 6, color: '#001018', fontWeight: 700, fontSize: 12, padding: '6px 12px', cursor: 'pointer' }}>{busy ? '…' : 'Save'}</button>
            <button onClick={() => setEditing(false)} style={{ background: '#334155', border: 'none', borderRadius: 6, color: '#cbd5e1', fontWeight: 700, fontSize: 12, padding: '6px 12px', cursor: 'pointer' }}>Cancel</button>
          </div>
        )}

        {/* event-file tags */}
        {tags && (tags.location || tags.pointOfSail || (tags.activeSails && tags.activeSails.length)) && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {tags.pointOfSail && <span style={{ fontSize: 11, color: C.head, background: '#0F2A45', border: `1px solid ${C.border}`, borderRadius: 4, padding: '2px 8px' }}>{tags.pointOfSail}</span>}
            {(tags.activeSails || []).map((s: string) => <span key={s} style={{ fontSize: 11, color: C.accent, background: '#0F2A45', border: `1px solid ${C.border}`, borderRadius: 4, padding: '2px 8px' }}>{s}</span>)}
            {tags.location && <span style={{ fontSize: 11, color: C.text, background: '#0F2A45', border: `1px solid ${C.border}`, borderRadius: 4, padding: '2px 8px' }}>📍 {tags.location}</span>}
          </div>
        )}

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
              ) : photoErr ? (
                <div style={{ width: '100%', minHeight: 120, background: C.panel, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.warn, fontSize: 12, padding: 12, textAlign: 'center' }}>Photo unavailable: {photoErr}</div>
              ) : (
                <div style={{ width: '100%', height: 240, background: C.panel, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 12 }}>loading photo…</div>
              )
            ) : (
              <div style={{ width: '100%', height: 120, background: C.panel, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 12 }}>No photo stored — re-import the PDF to capture it</div>
            )}
          </div>

          {/* stripe table (measured) + design target directly below it */}
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

            {/* design target shapes (interpolated to the measured TWS) */}
            {design && designSections.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, margin: '12px 0 4px' }}>
                  Design target ({design.sourceCode || targetSail?.category || '—'}) @ {fmt(design.tws, 0)} kn · % = fractions ×100
                  {design.substituted && <span style={{ color: C.warn }}> · {targetSail?.category || 'jib'} outside window → {design.sourceCode}</span>}
                  {design.clamped && !design.substituted && <span style={{ color: C.warn }}> · clamped {fmt(design.twsMin, 0)}–{fmt(design.twsMax, 0)} kn</span>}
                  {activeJib && targetSail?.kind === 'mainsail' && <span style={{ color: C.dim }}> · with {activeJib}</span>}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', background: C.panel, borderRadius: 8 }}>
                  <thead>
                    <tr><th style={th}>Stripe</th><th style={th}>Draft</th><th style={th}>Camber</th><th style={th}>Twist</th><th style={th}>Entry</th><th style={th}>Exit</th><th style={th}>Front%</th><th style={th}>Back%</th></tr>
                  </thead>
                  <tbody>
                    {designSections.map((s: any) => (
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
        </div>

        {/* notes */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.dim, marginBottom: 4 }}>Notes</div>
          {canEdit ? (
            <>
              <textarea
                value={notes}
                onChange={(e) => { setNotes(e.target.value); setNotesMsg('') }}
                placeholder="Add notes about this scan…"
                rows={3}
                style={{ width: '100%', resize: 'vertical', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, color: C.head, fontSize: 13, padding: '8px 10px', fontFamily: 'inherit' }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                <button onClick={saveNotes} disabled={notesBusy || notes === (scan?.notes || '')}
                  style={{ background: C.good, border: 'none', borderRadius: 6, color: '#001018', fontWeight: 700, fontSize: 12, padding: '6px 14px', cursor: 'pointer', opacity: notesBusy || notes === (scan?.notes || '') ? 0.5 : 1 }}>{notesBusy ? 'Saving…' : 'Save notes'}</button>
                {notesMsg && <span style={{ fontSize: 11, color: notesMsg === 'Saved' ? C.good : C.warn }}>{notesMsg}</span>}
              </div>
            </>
          ) : (
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 13, color: notes ? C.text : C.dim, whiteSpace: 'pre-wrap' }}>{notes || 'No notes.'}</div>
          )}
        </div>

        {/* per-metric charts (value vs stripe %) */}
        <div style={{ fontSize: 12, fontWeight: 700, color: C.dim, margin: '16px 0 6px' }}>Shape charts (vs stripe height %)</div>
        <div style={{ fontSize: 11, color: C.dim, marginBottom: 6, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <span onMouseEnter={() => setShapeHover('m')} onMouseLeave={() => setShapeHover(null)}
            style={{ color: C.accent, cursor: 'pointer', fontWeight: shapeHover === 'm' ? 800 : 400, opacity: shapeHover == null || shapeHover === 'm' ? 1 : 0.35 }}>━ measured</span>
          <span onMouseEnter={() => setShapeHover('d')} onMouseLeave={() => setShapeHover(null)}
            style={{ color: DESIGN_GREY, cursor: 'pointer', fontWeight: shapeHover === 'd' ? 800 : 400, opacity: shapeHover == null || shapeHover === 'd' ? 1 : 0.35 }}>— — design</span>
          <span style={{ color: C.dim, opacity: 0.7 }}>· hover to highlight a curve</span>
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {METRICS.map((m) => {
            const overlay = design && designSections.length
              ? { xs: designSections.map((s: any) => s.posPct), ys: designSections.map((s: any) => (s[m.dKey] != null ? s[m.dKey] * m.dScale : null)), color: DESIGN_GREY }
              : undefined
            return (
              <div key={m.key} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ fontSize: 13, color: C.head, fontWeight: 700, marginBottom: 4 }}>{m.label}</div>
                <LineChart xs={posXs} ys={stripes.map((s) => s[m.key] as number | null)} color={m.color} overlay={overlay}
                  xMin={25} xMax={maxStripe} xTicks={xTicksArr} w={720} h={280} hovered={shapeHover} onHover={setShapeHover} />
              </div>
            )
          })}
        </div>
        {design && design.sections.length > 0 && (
          <div style={{ fontSize: 10, color: C.dim, marginTop: 4 }}>
            <span style={{ color: DESIGN_GREY }}>— — grey dashed</span> = design target {design.sourceCode ? `(${design.sourceCode})` : ''} @ {fmt(design.tws, 0)} kn{design.substituted ? ' · substituted by wind range' : design.clamped ? ' (clamped)' : ''}
          </div>
        )}

        {/* 2-minute window: averages + graphs */}
        <div style={{ fontSize: 12, fontWeight: 700, color: C.dim, margin: '18px 0 6px' }}>
          Boat state · 2-min window {win ? `(${win.count} pts · ${winSource} log)` : ''}
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
              {kv('Polar BSP', `${fmt(win.averages.vsPerfPct, 0)}%`)}
              {kv('Forestay', `${fmt(win.averages.forestay)}`)}
              {win.averages.trim != null && kv('Trim', `${fmt(win.averages.trim, 2)}`)}
              {win.averages.keelAng != null && kv('Keel angle', `${fmt(win.averages.keelAng, 2)}°`)}

              {/* MAINSAIL trim — only on main scans, only when the log carries it */}
              {isMain && win.averages.cunninghamLoad != null && kv('Cunningham', `${fmt(win.averages.cunninghamLoad)}`)}
              {isMain && win.averages.outhaul != null && kv('Outhaul', `${fmt(win.averages.outhaul)}`)}
              {isMain && win.averages.vang != null && kv('Vang', `${fmt(win.averages.vang)}`)}
              {isMain && win.averages.upDflctPct != null && kv('Up deflector', `${fmt(win.averages.upDflctPct, 0)}%`)}
              {isMain && win.averages.lwDflctPct != null && kv('Low deflector', `${fmt(win.averages.lwDflctPct, 0)}%`)}
              {isMain && win.averages.travPct != null && kv('Traveller', `${fmt(win.averages.travPct, 0)}%`)}
              {isMain && kv('V0 P', `${fmt(win.averages.v0p, 0)}`)}
              {isMain && kv('V0 S', `${fmt(win.averages.v0s, 0)}`)}
              {isMain && kv('V1 P', `${fmt(win.averages.v1p, 0)}`)}
              {isMain && kv('V1 S', `${fmt(win.averages.v1s, 0)}`)}

              {/* HEADSAIL trim — only on jib (headsail) scans */}
              {isHeadsail && win.averages.jibTackLoad != null && kv('Jib tack', `${fmt(win.averages.jibTackLoad)}`)}
              {isHeadsail && win.averages.jibUpDnStbd != null && kv('Jib U/D stbd', `${fmt(win.averages.jibUpDnStbd, 0)}`)}
              {isHeadsail && win.averages.jibUpDnPort != null && kv('Jib U/D port', `${fmt(win.averages.jibUpDnPort, 0)}`)}
              {isHeadsail && win.averages.jibInOut != null && kv('Jib in/out', `${fmt(win.averages.jibInOut, 0)}`)}

              {win.averages.twaTarg != null && kv('Targ TWA', `${fmt(win.averages.twaTarg, 0)}°`)}
              {win.averages.vsTarget != null && kv('Targ BSP', `${fmt(win.averages.vsTarget)} kt`)}
              {win.averages.targHeel != null && kv('Targ heel', `${fmt(win.averages.targHeel, 1)}°`)}
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {WIND.map((wf) => {
                const ys: (number | null)[] = win.series[wf.key] || []
                const t0 = win.series.utc?.[0] || 0
                const xs = (win.series.utc || []).map((u: number) => (u - t0) / 1000)
                return (
                  <div key={wf.key} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 13, color: C.head, fontWeight: 700, marginBottom: 4 }}>{wf.label}</div>
                    <LineChart xs={xs} ys={ys} color={wf.color} xLabel="seconds" w={720} h={280} />
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

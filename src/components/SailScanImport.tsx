'use client'
// src/components/SailScanImport.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Backfill importer for SailScan trim-stripe PDF reports. Lives at the top of
// the Tools → SailScan section. Accepts multiple PDFs at once and handles all
// three report layouts (auto-detected server-side):
//   • North Sails app export (single page)
//   • thesailcloud "Onboard Sail (Relative)" — single sail
//   • thesailcloud overlay — two sails → two scans from one PDF
//
// Each file POSTs to /api/teams/{teamId}/sail-scans, which parses + stores one
// sail_scans row per scan. Sails are left unassigned here on purpose — the plan
// is to tag each scan to its sail from the day's event-file sail tag later. The
// panel shows a per-file preview (format, dates, TWS, stripe counts) so a
// backfill of dozens of old reports can be eyeballed as it runs.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useRef, useEffect } from 'react'
import { uploadBlobToStorage } from '../lib/bunny-storage-upload'
import { extractLargestJpegBlob } from '../lib/pdfImageExtract'

interface ParsedStripe { pos: number; camber: number | null; draft: number | null; twist: number | null }
interface ParsedScan {
  sailName: string | null
  sailType: 'main' | 'headsail' | null
  imageName: string | null
  capturedAt: string | null
  capturedLocal: string | null
  tws: number | null
  format: string
  stripes: ParsedStripe[]
}
interface FileResult {
  name: string
  status: 'pending' | 'ok' | 'error'
  stage?: string
  format?: string
  count?: number
  scans?: ParsedScan[]
  error?: string
}

const C = {
  panel: '#071624', border: '#1E3A5A', accent: '#06B6D4',
  head: '#E2E8F0', text: '#CBD5E1', dim: '#64748B', ok: '#10B981', warn: '#F59E0B',
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function SailScanImport({
  teamId,
  boatId,
  onImported,
}: {
  teamId?: string | null
  boatId?: string | null
  onImported?: () => void
}) {
  const [results, setResults] = useState<FileResult[]>([])
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // A SailScan report carries a wall-clock with NO timezone. The report is shown
  // in that local time as-is; this zone is only used to place the scan on the true
  // UTC timeline for log-matching. Default to THIS machine's zone (set on mount to
  // avoid SSR drift); the user confirms/adjusts it below.
  const [tzMin, setTzMin] = useState(0)
  useEffect(() => { setTzMin(-new Date().getTimezoneOffset()) }, [])
  const tzLabel = (m: number) => `UTC${m >= 0 ? '+' : ''}${m / 60}`

  if (!teamId || !boatId) {
    return (
      <div style={{ padding: '10px 14px', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, color: C.dim, fontSize: 12 }}>
        ⛵ Import SailScan reports — pick an active boat (Campaign) first to backfill scans.
      </div>
    )
  }

  const runImport = async (files: FileList) => {
    setBusy(true)
    const list: FileResult[] = Array.from(files).map((f) => ({ name: f.name, status: 'pending' as const }))
    setResults((prev) => [...list, ...prev])

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const stage = (s: string) => setResults((prev) => prev.map((row) => (row === list[i] ? { ...row, stage: s } : row)))
      const fd = new FormData()
      fd.append('boat_id', boatId)
      fd.append('tz_offset_min', String(tzMin)) // venue zone for the report wall-clock
      stage('Reading data…')
      try {
        const blob = await extractLargestJpegBlob(file)
        if (blob) {
          stage('Uploading document…')
          const key = `teams/${teamId}/boats/${boatId}/sail-scans/${Date.now()}-${i}-photo.jpg`
          await uploadBlobToStorage({ key, blob, contentType: 'image/jpeg' })
          fd.append('photo_key', key)
        }
      } catch { /* non-fatal */ }

      // A photo-heavy SailScan report is 10–12 MB — far over the API's request-body
      // limit, which rejects it with a plain-text "Request Entity Too Large" before
      // any of our code runs. Only the report's TEXT is needed server-side, so for a
      // large PDF we park the file in Bunny (same path the sail photo already takes)
      // and hand the API a key to fetch instead of the bytes.
      // Small text-only exports (~350 KB) keep the simple inline path.
      //
      // The PDF is TRANSIT ONLY — we keep the parsed scan and the sail photo, not the
      // source document. The server deletes this object as soon as it has read the
      // text (see deleteFromBunnyStorage), hence the `tmp/` prefix: anything left
      // under it is an orphan from a crashed request and is safe to sweep.
      const INLINE_MAX = 3_500_000
      if (file.size > INLINE_MAX) {
        try {
          stage('Uploading report…')
          const key = `tmp/sail-scan-imports/${teamId}/${Date.now()}-${i}-report.pdf`
          await uploadBlobToStorage({ key, blob: file, contentType: 'application/pdf' })
          fd.append('file_key', key)
          fd.append('file_name', file.name)
        } catch (e: any) {
          setResults((prev) => prev.map((row) =>
            row.name === file.name && row.status === 'pending'
              ? { ...row, status: 'error', error: `could not upload the report: ${e?.message || 'failed'}` }
              : row
          ))
          continue
        }
      } else {
        fd.append('file', file)
      }

      stage('Importing…')
      try {
        const res = await fetch(`/api/teams/${teamId}/sail-scans`, { method: 'POST', body: fd })
        // NEVER res.json() blindly: an infrastructure-level rejection (413, 502…) is
        // plain text or HTML, and parsing it threw `Unexpected token 'R'` — hiding the
        // real problem behind a JSON error.
        const raw = await res.text()
        let r: any = null
        try { r = JSON.parse(raw) } catch { /* not JSON — handled below */ }
        if (!r) {
          const msg = res.status === 413
            ? `file too large for the server (${(file.size / 1048576).toFixed(1)} MB)`
            : `server returned ${res.status}: ${raw.slice(0, 120)}`
          throw new Error(msg)
        }
        setResults((prev) => prev.map((row) =>
          row === list[i] || (row.name === file.name && row.status === 'pending')
            ? r.error
              ? { ...row, status: 'error', error: r.error }
              : { ...row, status: 'ok', format: r.format, count: r.count, scans: r.parsed }
            : row
        ))
      } catch (e: any) {
        setResults((prev) => prev.map((row) =>
          row.name === file.name && row.status === 'pending' ? { ...row, status: 'error', error: e?.message || 'failed' } : row
        ))
      }
    }
    setBusy(false)
    if (fileRef.current) fileRef.current.value = ''
    onImported?.()
  }

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 14px', margin: '8px 0' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: C.head }}>⛵ Import SailScan reports</span>
        <span style={{ fontSize: 11, color: C.dim }}>North app · thesailcloud (single &amp; two-sail) — backfill, sails tagged later</span>
        <div style={{ flex: 1 }} />
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          disabled={busy}
          onChange={(e) => { if (e.target.files?.length) runImport(e.target.files) }}
          style={{ fontSize: 12, color: C.text }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          style={{ background: C.accent, border: 'none', borderRadius: 6, color: '#001018', fontWeight: 700, fontSize: 12, padding: '6px 12px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}
        >
          {busy ? 'Importing…' : 'Choose PDFs'}
        </button>
      </div>

      {/* Report timezone — the PDF time has no zone; confirm it (default = this
          computer). Only used to align scans with a day's log on the UTC timeline;
          the scan view always shows the report's own local wall-clock. */}
      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', background: '#0A1929', border: `1px solid ${C.border}`, borderRadius: 6, padding: '7px 10px' }}>
        <span style={{ fontSize: 10, color: C.warn, fontWeight: 700 }}>Report timezone</span>
        <span style={{ fontSize: 10, color: C.dim }}>SailScan PDFs carry no timezone — assumed to be this computer's ({tzLabel(tzMin)}). Adjust if the footage was shot elsewhere:</span>
        <select value={tzMin} onChange={(e) => setTzMin(Number(e.target.value))} disabled={busy}
          style={{ background: '#071624', border: `1px solid ${C.border}`, borderRadius: 5, padding: '4px 7px', color: C.text, fontSize: 11, cursor: 'pointer' }}>
          {Array.from({ length: 27 }, (_, i) => (i - 12) * 60).map((m) => (
            <option key={m} value={m}>{tzLabel(m)}{m === -new Date().getTimezoneOffset() ? ' (this computer)' : ''}</option>
          ))}
        </select>
      </div>

      {results.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {results.map((r, i) => (
            <div key={i} style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 9px', fontSize: 12 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ color: r.status === 'error' ? C.warn : r.status === 'ok' ? C.ok : C.dim }}>
                  {r.status === 'ok' ? '✓' : r.status === 'error' ? '✕' : '…'}
                </span>
                <span style={{ color: C.head, fontWeight: 600 }}>{r.name}</span>
                {r.status === 'pending' && r.stage && <span style={{ color: C.accent }}>{r.stage}</span>}
                {r.format && <span style={{ fontSize: 10, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 4, padding: '0 5px' }}>{r.format}</span>}
                {r.status === 'ok' && r.count != null && <span style={{ color: C.ok }}>Imported {r.count} scan{r.count === 1 ? '' : 's'}</span>}
                {r.error && <span style={{ color: C.warn }}>{r.error}</span>}
              </div>
              {r.scans && r.scans.length > 0 && (
                <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {r.scans.map((s, j) => (
                    <div key={j} style={{ color: C.text, fontSize: 11, paddingLeft: 16 }}>
                      <span style={{ color: C.accent, fontWeight: 700 }}>{s.sailName || 'unassigned'}</span>
                      {s.sailType && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: s.sailType === 'main' ? '#34D399' : '#FBBF24', border: `1px solid ${C.border}`, borderRadius: 4, padding: '0 5px' }}>
                          {s.sailType}
                        </span>
                      )}
                      {' · '}{fmtDate(s.capturedAt)}
                      {s.tws != null && <> · {s.tws} kn</>}
                      {' · '}{s.stripes?.length || 0} stripes
                      {s.imageName && <span style={{ color: C.dim }}> · {s.imageName.length > 48 ? s.imageName.slice(0, 46) + '…' : s.imageName}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

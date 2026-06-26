'use client'
// src/components/BoatConfigTab.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Boat Config — sub-tabs:
//   • Sail inventory  — SSA-owned master list of sail tags (name, build date,
//                       status, certificate). Editable by TL3+. Scans + daily
//                       configs link to these sails.
//   • Sail shapes     — structured trim-stripe scans (ingested from North).
//   • Polar           — target speed reference (design VPP, via lib/polarCalc).
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { uploadBlobToStorage } from '../lib/bunny-storage-upload'
import { parseSailList, sailKindFromType } from '../lib/sailListParse'
import { extractLargestJpegBlob } from '../lib/pdfImageExtract'
import SailScanDetail from './SailScanDetail'
import targetsV14 from '../data/targets-v1.4.json'

interface Sail {
  id: string
  boat_id?: string
  name: string
  kind?: string | null
  category?: string | null
  sailmaker?: string | null
  build_date?: string | null
  in_service_date?: string | null
  retired?: boolean
  certificate_key?: string | null
  certificate_name?: string | null
  notes?: string | null
}
interface Stripe { pos?: number; camber?: number; draft?: number; twist?: number; entry?: number; exit?: number }
interface Scan {
  id: string; sail_id?: string | null; captured_at?: string | null; source?: string | null
  tws_kn?: number | null; stripes?: Stripe[]; conditions?: any
}

const C = {
  bg: '#04101c', card: '#071624', border: '#1E3A5A', accent: '#06B6D4',
  text: '#cbd5e1', dim: '#64748B', head: '#e2e8f0', warn: '#F59E0B', ok: '#10B981',
}
const EDIT_ROLES = ['admin', 'team_manager', 'coach', 'tl3']
const fmt = (v: any, d = 1) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d))
const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' }) : '—'

export default function BoatConfigTab({
  teamId, boatId, role, isMobile,
}: { teamId: string; boatId: string; role?: string; config?: any; isMobile?: boolean }) {
  const canEdit = EDIT_ROLES.includes(role || '')
  const isAdmin = role === 'admin'
  const [view, setView] = useState<'inventory' | 'shapes' | 'rig' | 'polar'>('inventory')
  const [sails, setSails] = useState<Sail[]>([])
  const [scans, setScans] = useState<Scan[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string>('') // sail id being mutated
  const [polar, setPolar] = useState<any>(null)          // active polar row (DB)
  const [matrixKey, setMatrixKey] = useState<'bsp' | 'heel' | 'rudder' | 'awa'>('bsp')
  const [importing, setImporting] = useState(false)
  const [rigTune, setRigTune] = useState<any>(null)      // active rig baseline row (DB)
  const [rigBusy, setRigBusy] = useState(false)
  const [rigErr, setRigErr] = useState('')
  const [rigPdfUrl, setRigPdfUrl] = useState<string | null>(null) // admin-only signed PDF URL
  const [selectedScan, setSelectedScan] = useState<any>(null) // open scan detail modal

  const loadSails = () =>
    fetch(`/api/teams/${teamId}/sails?boat_id=${boatId}`).then((r) => r.json())

  useEffect(() => {
    if (!teamId || !boatId) return
    let alive = true
    setLoading(true); setErr('')
    Promise.all([
      loadSails(),
      fetch(`/api/teams/${teamId}/sail-scans?boat_id=${boatId}&limit=40`).then((r) => r.json()),
    ])
      .then(([s, sc]) => {
        if (!alive) return
        if (s.error || sc.error) setErr(s.error || sc.error)
        setSails(s.sails || []); setScans(sc.scans || [])
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [teamId, boatId]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadPolar = useCallback(() => {
    if (!teamId || !boatId) return
    fetch(`/api/teams/${teamId}/polars?boat_id=${boatId}&active=1`)
      .then((r) => (r.ok ? r.json() : { polars: [] }))
      .then((j) => setPolar((j.polars || [])[0] || null))
      .catch(() => {})
  }, [teamId, boatId])
  useEffect(() => { loadPolar() }, [loadPolar])

  const loadRigTune = useCallback(() => {
    if (!teamId || !boatId) return
    fetch(`/api/teams/${teamId}/rig-tunes?boat_id=${boatId}&active=1`)
      .then((r) => (r.ok ? r.json() : { rigTunes: [] }))
      .then((j) => setRigTune((j.rigTunes || [])[0] || null))
      .catch(() => {})
  }, [teamId, boatId])
  useEffect(() => { loadRigTune() }, [loadRigTune])

  // Admin-only: fetch a short-lived signed URL for the stored source PDF.
  useEffect(() => {
    setRigPdfUrl(null)
    if (!isAdmin || !rigTune?.id || !rigTune?.report_key) return
    let alive = true
    fetch(`/api/teams/${teamId}/rig-tunes/${rigTune.id}/url`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j?.url) setRigPdfUrl(j.url) })
      .catch(() => {})
    return () => { alive = false }
  }, [isAdmin, rigTune?.id, rigTune?.report_key, teamId])

  // Upload + parse a rig tuning sheet PDF → stored as the active baseline,
  // effective-dated today. The original PDF is also stored (Bunny) so admins can
  // download it. TL3+ only (RLS also enforces it).
  const importRigTune = async (file: File) => {
    setRigBusy(true); setRigErr('')
    try {
      // Stash the original PDF in storage first (non-fatal if it fails — the
      // parsed table still gets saved).
      let reportKey: string | null = null
      try {
        const key = `teams/${teamId}/boats/${boatId}/rig-tunes/${Date.now()}-${file.name}`
        await uploadBlobToStorage({ key, blob: file, contentType: 'application/pdf' })
        reportKey = key
      } catch { /* keep going — store the parsed data regardless */ }

      const fd = new FormData()
      fd.append('boat_id', boatId)
      fd.append('file', file)
      if (reportKey) fd.append('report_key', reportKey)
      const r = await fetch(`/api/teams/${teamId}/rig-tunes`, { method: 'POST', body: fd }).then((x) => x.json())
      if (r.error) setRigErr(r.error); else loadRigTune()
    } catch (e: any) { setRigErr(String(e?.message || e)) }
    finally { setRigBusy(false) }
  }

  // Import the bundled V1.4 targets (parsed from the JV VPP) as the boat's
  // active polar. TL3+ only (RLS also enforces it).
  const importTargets = async () => {
    setImporting(true); setErr('')
    try {
      const r = await fetch(`/api/teams/${teamId}/polars`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boat_id: boatId,
          name: (targetsV14 as any).name || 'V1.4 Targets',
          source: 'design_vpp',
          valid_from: (targetsV14 as any).valid_from || null,
          data: targetsV14,
          activate: true,
        }),
      }).then((x) => x.json())
      if (r.error) setErr(r.error); else loadPolar()
    } catch (e: any) { setErr(String(e?.message || e)) }
    finally { setImporting(false) }
  }

  const refreshSails = async () => {
    const s = await loadSails()
    if (s.error) setErr(s.error); else setSails(s.sails || [])
  }
  const createSail = async (body: any) => {
    setBusy('new'); setErr('')
    try {
      const r = await fetch(`/api/teams/${teamId}/sails`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boat_id: boatId, ...body }),
      }).then((x) => x.json())
      if (r.error) setErr(r.error); else await refreshSails()
    } finally { setBusy('') }
  }
  const createSailReturning = async (body: any): Promise<Sail> => {
    const r = await fetch(`/api/teams/${teamId}/sails`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boat_id: boatId, ...body }),
    }).then((x) => x.json())
    if (r.error) throw new Error(r.error)
    await refreshSails()
    return r.sail
  }
  const refreshScans = async () => {
    const r = await fetch(`/api/teams/${teamId}/sail-scans?boat_id=${boatId}&limit=40`).then((x) => x.json())
    if (r.error) setErr(r.error); else setScans(r.scans || [])
  }
  // Import the boat's sail inventory from an Expedition event file's <saillist>.
  const importSailList = async (file: File) => {
    const text = await file.text()
    const parsed = parseSailList(text)
    if (!parsed.items.length) throw new Error('No <saillist> found in this event file.')
    const r = await fetch(`/api/teams/${teamId}/sails/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boat_id: boatId, boat_name: parsed.boatName, sails: parsed.items }),
    }).then((x) => x.json())
    if (r.error) throw new Error(r.error)
    if (r.sails) setSails(r.sails); else await refreshSails()
    return { ...r, boatName: parsed.boatName }
  }
  const importScan = async (file: File, sailId: string | null) => {
    const fd = new FormData()
    fd.append('boat_id', boatId)
    if (sailId) fd.append('sail_id', sailId)
    fd.append('file', file)
    // Stash the analysed sail photo (largest embedded JPEG) for the detail view.
    try {
      const blob = await extractLargestJpegBlob(file)
      if (blob) {
        const key = `teams/${teamId}/boats/${boatId}/sail-scans/${Date.now()}-photo.jpg`
        await uploadBlobToStorage({ key, blob, contentType: 'image/jpeg' })
        fd.append('photo_key', key)
      }
    } catch { /* non-fatal: scan still imports without the photo */ }
    const r = await fetch(`/api/teams/${teamId}/sail-scans`, { method: 'POST', body: fd }).then((x) => x.json())
    if (r.error) throw new Error(r.error)
    await refreshScans()
    return r // { scans, parsed: ParsedScan[], count, format }
  }
  const patchSail = async (id: string, fields: any) => {
    setBusy(id); setErr('')
    try {
      const r = await fetch(`/api/teams/${teamId}/sails`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...fields }),
      }).then((x) => x.json())
      if (r.error) setErr(r.error); else await refreshSails()
    } finally { setBusy('') }
  }
  const uploadCert = async (sail: Sail, file: File) => {
    setBusy(sail.id); setErr('')
    try {
      const key = `teams/${teamId}/sails/${sail.id}/cert-${Date.now()}-${file.name}`
      await uploadBlobToStorage({ key, blob: file, contentType: file.type })
      await patchSail(sail.id, { certificate_key: key, certificate_name: file.name })
    } catch (e: any) { setErr('Certificate upload failed: ' + (e?.message || e)) }
    finally { setBusy('') }
  }

  const sailById = useMemo(() => Object.fromEntries(sails.map((s) => [s.id, s])), [sails])
  const targets: any = polar?.data || null  // { tws, twa, headline, matrices, matrix_meta }

  // ── shared styles ──
  const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: C.dim, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${C.border}` }
  const td: React.CSSProperties = { padding: '6px 8px', color: C.text, fontSize: 12, borderBottom: `1px solid #0d2236` }
  const input: React.CSSProperties = { background: '#0a1c2e', border: `1px solid ${C.border}`, borderRadius: 6, color: C.head, padding: '5px 7px', fontSize: 12 }
  const btn = (bg: string): React.CSSProperties => ({ background: bg, border: 'none', borderRadius: 6, color: '#001018', fontWeight: 700, fontSize: 12, padding: '6px 12px', cursor: 'pointer' })
  const subBtn = (id: string, label: string) => (
    <button onClick={() => setView(id as any)} style={{
      padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
      background: view === id ? C.accent : '#0F2A45', color: view === id ? '#001018' : '#94A3B8',
    }}>{label}</button>
  )

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: C.bg, padding: isMobile ? 10 : 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.head }}>Boat configuration</h2>
        <span style={{ fontSize: 10, color: C.dim }}>{canEdit ? 'inventory editable · TL3+' : 'read-only'}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {subBtn('inventory', 'Sail inventory')}
        {subBtn('shapes', 'Sail shapes')}
        {subBtn('rig', 'Rig settings')}
        {subBtn('polar', 'Targets')}
      </div>

      {err && <div style={{ color: C.warn, fontSize: 12, marginBottom: 12 }}>Error: {err}</div>}
      {loading && <div style={{ color: C.dim, fontSize: 12 }}>Loading…</div>}

      {/* ── SAIL INVENTORY ─────────────────────────────────────────── */}
      {view === 'inventory' && (
        <div>
          {canEdit && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <ImportSailListForm onImport={importSailList} btn={btn} input={input} />
              <AddSailForm onAdd={createSail} busy={busy === 'new'} input={input} btn={btn} />
            </div>
          )}
          {sails.length === 0 && !loading ? (
            <div style={{ color: C.dim, fontSize: 12, marginTop: 8 }}>No sails yet.{canEdit ? ' Import an event file’s sail list, or add one above.' : ''}</div>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Cat</th><th style={th}>Sail name</th><th style={th}>Kind</th>
                    <th style={th}>Sail type</th><th style={th}>Grp</th><th style={th}>Wt (kg)</th>
                    <th style={th}>Build date</th><th style={th}>Status</th><th style={th}>Certificate</th>
                    {canEdit && <th style={th}></th>}
                  </tr>
                </thead>
                <tbody>
                  {sails.map((s) => (
                    <SailRow key={s.id} sail={s} canEdit={canEdit} busy={busy === s.id}
                      td={td} input={input} btn={btn}
                      onPatch={(f: any) => patchSail(s.id, f)} onCert={(f: File) => uploadCert(s, f)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── SAIL SHAPES (scans) ────────────────────────────────────── */}
      {view === 'shapes' && (
        <div>
          {canEdit && (
            <ImportScanForm sails={sails} input={input} btn={btn}
              onImport={importScan} onCreateSail={createSailReturning} />
          )}
          {scans.length === 0 && !loading ? (
            <div style={{ color: C.dim, fontSize: 12, marginTop: 8 }}>No scans yet. Import a North report above, or ingest via the API.</div>
          ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {scans.map((sc) => {
              const sail = sc.sail_id ? sailById[sc.sail_id] : null
              const stripes = Array.isArray(sc.stripes) ? sc.stripes : []
              return (
                <div key={sc.id} onClick={() => setSelectedScan(sc)} title="Open scan detail"
                  style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px', cursor: 'pointer' }}>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: stripes.length ? 6 : 0 }}>
                    <span style={{ fontWeight: 700, color: C.accent, fontSize: 12 }}>{sail?.category || sail?.name || sc.conditions?.sail_code || 'unassigned sail'}</span>
                    <span style={{ fontSize: 11, color: C.text }}>{fmtDate(sc.captured_at)}</span>
                    {sc.tws_kn != null && <span style={{ fontSize: 11, color: C.dim }}>{fmt(sc.tws_kn, 0)} kn</span>}
                    {sc.conditions?.photo_key && <span style={{ fontSize: 10 }}>📷</span>}
                    {sc.source && <span style={{ fontSize: 10, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 4, padding: '0 5px' }}>{sc.source}</span>}
                    <span style={{ fontSize: 10, color: C.accent, marginLeft: 'auto' }}>open ›</span>
                  </div>
                  {stripes.length > 0 && (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr><th style={th}>Pos</th><th style={th}>Camber</th><th style={th}>Draft</th><th style={th}>Twist</th><th style={th}>Entry</th><th style={th}>Exit</th></tr></thead>
                      <tbody>
                        {stripes.map((st, i) => (
                          <tr key={i}>
                            <td style={td}>{fmt(st.pos, 0)}%</td><td style={td}>{fmt(st.camber)}</td>
                            <td style={td}>{fmt(st.draft)}</td><td style={td}>{fmt(st.twist)}</td>
                            <td style={td}>{fmt(st.entry, 0)}</td><td style={td}>{fmt(st.exit, 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )
            })}
          </div>
          )}
        </div>
      )}

      {/* ── RIG SETTINGS (tuning baseline) ─────────────────────────── */}
      {view === 'rig' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: C.head }}>
              {rigTune ? rigTune.name : 'Rig tuning baseline'}
            </span>
            {rigTune?.effective_date && (
              <span style={{ fontSize: 11, color: C.accent, fontWeight: 700 }}>
                effective {fmtDate(rigTune.effective_date)}
              </span>
            )}
            {rigTune?.revision && <span style={{ fontSize: 10, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 6px' }}>{rigTune.revision}</span>}
            {rigTune && (
              <button onClick={() => printRigTune(rigTune.data, rigTune.name, rigTune.effective_date)} style={{ ...btn('#10B981'), marginLeft: 'auto' }}>⎙ Print</button>
            )}
            {canEdit && (
              <label style={{ ...btn('#06B6D4'), marginLeft: rigTune ? 0 : 'auto', opacity: rigBusy ? 0.6 : 1, cursor: rigBusy ? 'default' : 'pointer' }}>
                {rigBusy ? 'Parsing…' : rigTune ? 'Upload new sheet' : 'Upload rig PDF'}
                <input type="file" accept="application/pdf,.pdf" disabled={rigBusy} style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) importRigTune(f); e.currentTarget.value = '' }} />
              </label>
            )}
          </div>
          {rigErr && <div style={{ fontSize: 11, color: '#F59E0B', marginBottom: 8 }}>{rigErr}</div>}

          {!rigTune ? (
            <div style={{ border: `1px dashed ${C.border}`, borderRadius: 10, padding: '20px 16px', textAlign: 'center', color: C.dim }}>
              <div style={{ fontSize: 12, maxWidth: 520, margin: '0 auto', lineHeight: 1.5 }}>
                Upload the JV76 “Sailing Info Summary” rig sheet (PDF). SSA parses the upwind and
                reaching/downwind tables into per-sail-combination settings and stores them as the
                boat’s active baseline, effective from today.
              </div>
            </div>
          ) : (
            <RigTuneTable data={rigTune.data} />
          )}

          {/* Admin-only: source PDF thumbnail + download. */}
          {isAdmin && rigTune?.report_key && (
            <div style={{ marginTop: 14, display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ fontSize: 11, color: C.dim, fontWeight: 700, width: '100%' }}>Source document (admin)</div>
              <div style={{ width: 150, height: 200, border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden', background: '#0a1c2e' }}>
                {rigPdfUrl ? (
                  <embed src={`${rigPdfUrl}#toolbar=0&navpanes=0&view=FitH`} type="application/pdf" style={{ width: '100%', height: '100%' }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 11 }}>📄 loading…</div>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: C.text }}>{rigTune.report_ref || 'rig sheet.pdf'}</span>
                {rigPdfUrl ? (
                  <a href={rigPdfUrl} target="_blank" rel="noopener noreferrer" download
                    style={{ ...btn('#06B6D4'), textDecoration: 'none', display: 'inline-block', width: 'fit-content' }}>⬇ Download PDF</a>
                ) : (
                  <span style={{ fontSize: 11, color: C.dim }}>preparing link…</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TARGETS (active polar) ─────────────────────────────────── */}
      {view === 'polar' && (
        !targets ? (
          <div style={{ border: `1px dashed ${C.border}`, borderRadius: 10, padding: '20px 16px', textAlign: 'center', color: C.dim }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.head, marginBottom: 6 }}>No targets loaded</div>
            <div style={{ fontSize: 12, maxWidth: 460, margin: '0 auto 12px', lineHeight: 1.5 }}>
              Load the boat’s VPP targets — the laminated TARGETS sheet plus the BSP (polar),
              heel, rudder and AWA matrices.
            </div>
            {canEdit && (
              <button onClick={importTargets} disabled={importing} style={{ ...btn('#06B6D4'), opacity: importing ? 0.6 : 1 }}>
                {importing ? 'Importing…' : 'Import V1.4 Targets (JV VPP)'}
              </button>
            )}
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: C.head }}>{polar?.name || targets.name}</span>
              {targets.source_note && <span style={{ fontSize: 11, color: C.dim }}>{targets.source_note}</span>}
              {targets.wind_reference && <span style={{ fontSize: 10, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 4, padding: '1px 6px' }}>{targets.wind_reference}</span>}
              <button onClick={() => printTargets(targets, polar?.name || targets.name)} style={{ ...btn('#10B981'), marginLeft: 'auto' }}>⎙ Print</button>
              {canEdit && (
                <button onClick={importTargets} disabled={importing} style={{ ...btn('#0F2A45'), color: C.head, opacity: importing ? 0.6 : 1 }}>
                  {importing ? 'Re-importing…' : 'Re-import'}
                </button>
              )}
            </div>

            <TargetsTable targets={targets} uploadedAt={polar?.created_at} />

            <div style={{ display: 'flex', gap: 6, margin: '18px 0 10px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: C.dim, marginRight: 4 }}>Matrix:</span>
              {(['bsp', 'heel', 'rudder', 'awa'] as const).map((k) => (
                <button key={k} onClick={() => setMatrixKey(k)} style={{
                  fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', border: 'none',
                  background: matrixKey === k ? C.accent : '#0F2A45', color: matrixKey === k ? '#001018' : '#94A3B8',
                }}>{targets.matrix_meta?.[k]?.label || k}</button>
              ))}
            </div>
            <MatrixTable targets={targets} mkey={matrixKey} uploadedAt={polar?.created_at} />
          </div>
        )
      )}

      {selectedScan && (
        <SailScanDetail
          scan={selectedScan}
          teamId={teamId}
          sailName={(selectedScan.sail_id ? sailById[selectedScan.sail_id]?.name : null) || selectedScan.conditions?.sail_name_in_report}
          onClose={() => setSelectedScan(null)}
        />
      )}
    </div>
  )
}

// ── Heat shade for a value within a matrix's range (blue→white→red) ───────────
function heat(v: number | null, lo: number, hi: number): string {
  if (v == null || Number.isNaN(v)) return 'transparent'
  const t = hi === lo ? 0.5 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
  // 0 = cool blue, 1 = warm red
  const r = Math.round(t < 0.5 ? 120 + t * 270 : 255)
  const g = Math.round(t < 0.5 ? 150 + t * 210 : 255 - (t - 0.5) * 300)
  const b = Math.round(t < 0.5 ? 235 - t * 120 : 200 - (t - 0.5) * 300)
  return `rgba(${r},${g},${Math.max(0, b)},0.55)`
}

// Screen-only "uploaded" caption (bottom-right). Not part of the print sheet.
function UploadedCaption({ uploadedAt }: { uploadedAt?: string | null }) {
  if (!uploadedAt) return null
  return (
    <div style={{ textAlign: 'right', fontSize: 10, color: C.dim, marginTop: 4 }}>
      Uploaded {new Date(uploadedAt).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}
    </div>
  )
}

// ── Rig tuning baseline (per sail-combination columns, Targets-style) ─────────
const RIG_SEC_TINT: Record<string, string> = {
  upwind: 'rgba(244,176,132,0.45)',   // orange
  reaching: 'rgba(180,199,231,0.45)', // blue
  downwind: 'rgba(168,213,186,0.5)',  // green
}
type RigField = { key: string; label: string; render: (c: any) => string; reachingOnly?: boolean }
const RIG_FIELDS: RigField[] = [
  { key: 'twsAtMh', label: 'TWS @ MH (kt)', render: (c) => (c.twsAtMh ?? '—') },
  { key: 'rakeDeg', label: 'Rake (°)', render: (c) => (c.rakeDeg != null ? fmt(c.rakeDeg, 2) : '—') },
  { key: 'mastbasePosition', label: 'Mastbase Position', render: (c) => (c.mastbasePosition ?? '—') },
  { key: 'shimStack', label: 'Shim Stack (mm)', render: (c) => (c.shimStack ?? '—') },
  { key: 'mastbaseLoadT', label: 'Mastbase (t)', render: (c) => (c.mastbaseLoadT != null ? fmt(c.mastbaseLoadT, 1) : '—') },
  { key: 'headstayT', label: 'Headstay (t)', render: (c) => (c.headstayT != null ? fmt(c.headstayT, 1) : '—') },
  { key: 'jibTackT', label: 'Jib Tack (t)', render: (c) => (c.jibTackT != null ? fmt(c.jibTackT, 1) : '—') },
  { key: 'mainCunninghamT', label: 'Main Cunningham (t)', render: (c) => (c.mainCunninghamT != null ? fmt(c.mainCunninghamT, 1) : '—') },
  { key: 'bowspritTackT', label: 'Bowsprit Tack (t)', render: (c) => (c.bowspritTackT != null ? fmt(c.bowspritTackT, 1) : '—'), reachingOnly: true },
  { key: 'upperDeflectorCylStroke', label: 'Upper Defl. Stroke', render: (c) => (c.upperDeflectorCylStroke ?? '—') },
  { key: 'lowerDeflectorCylStroke', label: 'Lower Defl. Stroke', render: (c) => (c.lowerDeflectorCylStroke ?? '—') },
]

function RigSubTable({ cols, heading }: { cols: any[]; heading: string }) {
  if (!cols.length) return null
  // Drop reaching-only fields when the block is upwind.
  const isUpwindOnly = cols.every((c) => c.section === 'upwind')
  const fields = RIG_FIELDS.filter((f) => !(f.reachingOnly && isUpwindOnly))
  const bands: { section: string; span: number }[] = []
  for (const c of cols) {
    const last = bands[bands.length - 1]
    if (last && last.section === c.section) last.span++
    else bands.push({ section: c.section, span: 1 })
  }
  const th: React.CSSProperties = { padding: '5px 8px', fontSize: 11, fontWeight: 700, color: '#0b1f33', borderBottom: '1px solid #1E3A5A', textAlign: 'center', whiteSpace: 'nowrap' }
  const rh: React.CSSProperties = { padding: '5px 10px', fontSize: 11, fontWeight: 700, color: '#0b1f33', textAlign: 'left', borderBottom: '1px solid #d7e2ee', background: '#eef3f8', position: 'sticky', left: 0 }
  const td: React.CSSProperties = { padding: '5px 8px', fontSize: 12, color: '#0b1f33', textAlign: 'center', borderBottom: '1px solid #d7e2ee', whiteSpace: 'nowrap' }
  return (
    <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 8, padding: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: '#0b1f33', padding: '2px 4px 8px' }}>{heading}</div>
      <table style={{ borderCollapse: 'collapse', minWidth: 560 }}>
        <thead>
          <tr>
            <th style={{ ...th, background: '#eef3f8' }}></th>
            {bands.map((b, i) => (
              <th key={i} style={{ ...th, background: RIG_SEC_TINT[b.section] || '#eee' }} colSpan={b.span}>{b.section.toUpperCase()}</th>
            ))}
          </tr>
          <tr>
            <th style={{ ...rh, background: '#dde6ef' }}>Sail combo</th>
            {cols.map((c, i) => (
              <th key={i} style={{ ...th, background: RIG_SEC_TINT[c.section] || '#eee' }}>{c.headsail || '—'}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.key}>
              <td style={rh}>{f.label}</td>
              {cols.map((c, i) => (
                <td key={i} style={{ ...td, background: (RIG_SEC_TINT[c.section] || '#fff').replace('0.45', '0.16').replace('0.5', '0.16') }}>{f.render(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RigTuneTable({ data }: { data: any }) {
  const cols: any[] = Array.isArray(data?.columns) ? data.columns : []
  if (!cols.length) return <div style={{ color: C.dim, fontSize: 12 }}>No rig columns parsed.</div>
  const upwind = cols.filter((c) => c.section === 'upwind')
  const reachDown = cols.filter((c) => c.section !== 'upwind')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <RigSubTable cols={upwind} heading="Upwind" />
      <RigSubTable cols={reachDown} heading="Reaching / Downwind" />
    </div>
  )
}

// ── Headline TARGETS sheet (upwind | TWS | downwind) ─────────────────────────
function TargetsTable({ targets, uploadedAt }: { targets: any; uploadedAt?: string | null }) {
  const rows = targets.headline || []
  const th: React.CSSProperties = { padding: '5px 8px', fontSize: 11, fontWeight: 700, color: '#0b1f33', borderBottom: '1px solid #1E3A5A', textAlign: 'center' }
  const td: React.CSSProperties = { padding: '5px 8px', fontSize: 12, color: '#0b1f33', textAlign: 'center', borderBottom: '1px solid #d7e2ee' }
  const up = 'rgba(244,176,132,0.45)'   // orange tint (upwind)
  const dn = 'rgba(180,199,231,0.45)'   // blue tint (downwind)
  const tws = 'rgba(217,217,217,0.6)'
  return (
    <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 8, padding: 8 }}>
      <table style={{ borderCollapse: 'collapse', margin: '0 auto', minWidth: 560 }}>
        <thead>
          <tr>
            <th style={{ ...th, background: up }} colSpan={5}>UPWIND</th>
            <th style={{ ...th, background: tws }}></th>
            <th style={{ ...th, background: dn }} colSpan={5}>DOWNWIND</th>
          </tr>
          <tr>
            {['RUDD', 'AWA', 'HEEL', 'TWA', 'BSP'].map((h) => <th key={'u' + h} style={{ ...th, background: up }}>{h}</th>)}
            <th style={{ ...th, background: tws }}>TWS</th>
            {['BSP', 'TWA', 'HEEL', 'AWA', 'RUDD'].map((h) => <th key={'d' + h} style={{ ...th, background: dn }}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r: any) => (
            <tr key={r.tws}>
              <td style={{ ...td, background: up }}>{fmt(r.up.rudd)}</td>
              <td style={{ ...td, background: up, fontWeight: 700 }}>{fmt(r.up.awa, 0)}</td>
              <td style={{ ...td, background: up }}>{fmt(r.up.heel, 0)}</td>
              <td style={{ ...td, background: up, fontWeight: 700 }}>{fmt(r.up.twa, 0)}</td>
              <td style={{ ...td, background: up }}>{fmt(r.up.bsp)}</td>
              <td style={{ ...td, background: tws, fontWeight: 800 }}>{r.tws}</td>
              <td style={{ ...td, background: dn }}>{fmt(r.dn.bsp)}</td>
              <td style={{ ...td, background: dn, fontWeight: 700 }}>{fmt(r.dn.twa, 0)}</td>
              <td style={{ ...td, background: dn }}>{fmt(r.dn.heel, 0)}</td>
              <td style={{ ...td, background: dn, fontWeight: 700 }}>{fmt(r.dn.awa, 0)}</td>
              <td style={{ ...td, background: dn }}>{fmt(r.dn.rudd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <UploadedCaption uploadedAt={uploadedAt} />
    </div>
  )
}

// ── One TWS×TWA matrix (BSP / Heel / Rudder / AWA) with heat shading ─────────
function MatrixTable({ targets, mkey, uploadedAt }: { targets: any; mkey: string; uploadedAt?: string | null }) {
  const m: number[][] = targets.matrices?.[mkey] || []
  const twa: number[] = targets.twa || []
  const tws: number[] = targets.tws || []
  const dec = targets.matrix_meta?.[mkey]?.decimals ?? 1
  const flat = m.flat().filter((v) => typeof v === 'number' && !Number.isNaN(v))
  const lo = Math.min(...flat), hi = Math.max(...flat)
  const cell: React.CSSProperties = { padding: '3px 6px', fontSize: 11, textAlign: 'center', color: '#0b1f33', border: '1px solid #e2e8f0', minWidth: 30 }
  const hcell: React.CSSProperties = { ...cell, fontWeight: 700, color: C.dim, background: '#0a1c2e', borderColor: C.border }
  return (
    <div style={{ overflowX: 'auto', background: '#fff', borderRadius: 8, padding: 8 }}>
      <table style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...hcell, color: C.head }}>TWS\TWA</th>
            {twa.map((a) => <th key={a} style={{ ...cell, fontWeight: 700, background: '#eef2f7' }}>{a}</th>)}
          </tr>
        </thead>
        <tbody>
          {m.map((row, i) => (
            <tr key={tws[i]}>
              <td style={{ ...cell, fontWeight: 700, background: '#eef2f7' }}>{tws[i]}</td>
              {row.map((v, j) => (
                <td key={j} style={{ ...cell, background: heat(v, lo, hi) }}>{fmt(v, dec)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <UploadedCaption uploadedAt={uploadedAt} />
    </div>
  )
}

// ── Print the targets as a clean, laminate-ready sheet (new window) ──────────
// Print the rig tuning baseline: upwind table + reaching/downwind table, both
// on a single landscape page.
function printRigTune(data: any, title: string, effectiveDate?: string | null) {
  const esc = (s: any) => String(s == null ? '' : s)
  const cols: any[] = Array.isArray(data?.columns) ? data.columns : []
  const SEC_TINT: Record<string, string> = { upwind: '#f8d8bf', reaching: '#cdd9f0', downwind: '#bfe3cd' }
  const t1 = (v: any) => (v != null ? Number(v).toFixed(1) : '')
  const fields: { label: string; get: (c: any) => string; reachingOnly?: boolean }[] = [
    { label: 'TWS @ MH (kt)', get: (c) => esc(c.twsAtMh) },
    { label: 'Rake (°)', get: (c) => (c.rakeDeg != null ? Number(c.rakeDeg).toFixed(2) : '') },
    { label: 'Mastbase Position', get: (c) => esc(c.mastbasePosition) },
    { label: 'Shim Stack (mm)', get: (c) => esc(c.shimStack) },
    { label: 'Mastbase (t)', get: (c) => t1(c.mastbaseLoadT) },
    { label: 'Headstay (t)', get: (c) => t1(c.headstayT) },
    { label: 'Jib Tack (t)', get: (c) => t1(c.jibTackT) },
    { label: 'Main Cunningham (t)', get: (c) => t1(c.mainCunninghamT) },
    { label: 'Bowsprit Tack (t)', get: (c) => t1(c.bowspritTackT), reachingOnly: true },
    { label: 'Upper Defl. Stroke', get: (c) => esc(c.upperDeflectorCylStroke) },
    { label: 'Lower Defl. Stroke', get: (c) => esc(c.lowerDeflectorCylStroke) },
  ]
  const tableFor = (subset: any[], heading: string) => {
    if (!subset.length) return ''
    const isUpwindOnly = subset.every((c) => c.section === 'upwind')
    const fs = fields.filter((f) => !(f.reachingOnly && isUpwindOnly))
    const head = `<tr><th class="rh">Sail combo</th>${subset.map((c) => `<th style="background:${SEC_TINT[c.section] || '#eee'}">${esc(c.headsail) || '—'}</th>`).join('')}</tr>`
    const body = fs.map((f) => `<tr><th class="rh">${f.label}</th>${subset.map((c) => `<td style="background:${(SEC_TINT[c.section] || '#fff')}33">${f.get(c)}</td>`).join('')}</tr>`).join('')
    return `<h3>${esc(heading)}</h3><table class="rig">${head}${body}</table>`
  }
  const upwind = cols.filter((c) => c.section === 'upwind')
  const reachDown = cols.filter((c) => c.section !== 'upwind')

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    @page { size: landscape; margin: 8mm; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 10px; }
    h1 { font-size: 18px; margin: 0 0 2px; } h2 { font-size: 11px; font-weight: normal; color: #555; margin: 0 0 8px; }
    h3 { font-size: 12px; margin: 12px 0 4px; }
    table.rig { border-collapse: collapse; width: 100%; table-layout: fixed; }
    table.rig th, table.rig td { border: 1px solid #aaa; padding: 3px 4px; text-align: center; font-size: 10px; }
    table.rig th.rh { text-align: left; background: #eef2f7; white-space: nowrap; width: 120px; }
  </style></head><body>
    <h1>${esc(title)}</h1>
    <h2>Rig tuning baseline${effectiveDate ? ' · effective ' + esc(effectiveDate) : ''}${data?.revision ? ' · ' + esc(data.revision) : ''}</h2>
    ${tableFor(upwind, 'UPWIND')}
    ${tableFor(reachDown, 'REACHING / DOWNWIND')}
    <script>window.onload = function(){ window.print(); }<\/script>
  </body></html>`

  const w = window.open('', '_blank')
  if (!w) return
  w.document.open(); w.document.write(html); w.document.close()
}

function printTargets(targets: any, title: string) {
  const esc = (s: any) => String(s)
  const fmtN = (v: any, d = 1) => (v == null || Number.isNaN(Number(v)) ? '' : Number(v).toFixed(d))
  const headline = targets.headline || []
  const twa: number[] = targets.twa || []
  const tws: number[] = targets.tws || []

  const headlineRows = headline.map((r: any) => `
    <tr>
      <td class="up">${fmtN(r.up.rudd)}</td><td class="up b">${fmtN(r.up.awa,0)}</td><td class="up">${fmtN(r.up.heel,0)}</td><td class="up b">${fmtN(r.up.twa,0)}</td><td class="up">${fmtN(r.up.bsp)}</td>
      <td class="tws">${r.tws}</td>
      <td class="dn">${fmtN(r.dn.bsp)}</td><td class="dn b">${fmtN(r.dn.twa,0)}</td><td class="dn">${fmtN(r.dn.heel,0)}</td><td class="dn b">${fmtN(r.dn.awa,0)}</td><td class="dn">${fmtN(r.dn.rudd)}</td>
    </tr>`).join('')

  const matrix = (mkey: string) => {
    const m: number[][] = targets.matrices?.[mkey] || []
    const dec = targets.matrix_meta?.[mkey]?.decimals ?? 1
    const label = targets.matrix_meta?.[mkey]?.label || mkey
    const head = `<tr><th>TWS\\TWA</th>${twa.map((a) => `<th>${a}</th>`).join('')}</tr>`
    const body = m.map((row, i) => `<tr><th>${tws[i]}</th>${row.map((v) => `<td>${fmtN(v, dec)}</td>`).join('')}</tr>`).join('')
    return `<h3>${esc(label)}</h3><table class="mx">${head}${body}</table>`
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    @page { size: landscape; margin: 10mm; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; padding: 12px; }
    h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 12px; font-weight: normal; color: #555; margin: 0 0 12px; }
    h3 { font-size: 13px; margin: 16px 0 4px; }
    table { border-collapse: collapse; }
    .hl td, .hl th { border: 1px solid #999; padding: 4px 8px; text-align: center; font-size: 12px; }
    .hl .grp { font-weight: 700; }
    .up { background: #f8d8bf; } .dn { background: #cdd9f0; } .tws { background: #dcdcdc; font-weight: 800; } .b { font-weight: 700; }
    .mx td, .mx th { border: 1px solid #ccc; padding: 2px 5px; text-align: center; font-size: 10px; }
    .mx th { background: #eef2f7; }
    .page-break { page-break-before: always; }
  </style></head><body>
    <h1>${esc(title)}</h1>
    <h2>${esc(targets.source_note || '')}${targets.wind_reference ? ' · ' + esc(targets.wind_reference) : ''}</h2>
    <table class="hl">
      <tr><td class="up grp" colspan="5">UPWIND</td><td class="tws"></td><td class="dn grp" colspan="5">DOWNWIND</td></tr>
      <tr><td class="up">RUDD</td><td class="up">AWA</td><td class="up">HEEL</td><td class="up">TWA</td><td class="up">BSP</td><td class="tws">TWS</td><td class="dn">BSP</td><td class="dn">TWA</td><td class="dn">HEEL</td><td class="dn">AWA</td><td class="dn">RUDD</td></tr>
      ${headlineRows}
    </table>
    <div class="page-break"></div>
    ${matrix('bsp')}
    ${matrix('heel')}
    ${matrix('rudder')}
    ${matrix('awa')}
    <script>window.onload = function(){ window.print(); }<\/script>
  </body></html>`

  const w = window.open('', '_blank')
  if (!w) return
  w.document.open(); w.document.write(html); w.document.close()
}

// ── Add-sail form ────────────────────────────────────────────────────────────
// ── Import the sail inventory from an Expedition event file's <saillist> ──────
function ImportSailListForm({ onImport, btn, input }: any) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const fileRef = React.useRef<HTMLInputElement>(null)
  const submit = async (file: File) => {
    setBusy(true); setErr(''); setMsg('')
    try {
      const r = await onImport(file)
      setMsg(`Imported ${r?.count ?? 0} sail${(r?.count ?? 0) === 1 ? '' : 's'} (${r?.inserted ?? 0} new, ${r?.updated ?? 0} updated, ${r?.retired ?? 0} retired)${r?.boatName ? ` · ${r.boatName}` : ''}.`)
    } catch (e: any) { setErr(e?.message || 'Import failed.') }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = '' }
  }
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 12px', background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8 }}>
      <span style={{ fontSize: 11, color: '#64748B', fontWeight: 700 }}>Import sail list</span>
      <span style={{ fontSize: 10, color: '#475569' }}>Expedition event file (.ev.xml) — its &lt;saillist&gt;</span>
      <input ref={fileRef} type="file" accept=".xml,.ev.xml,text/xml,application/xml" disabled={busy} style={{ ...input, padding: 4 }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) submit(f) }} />
      <button onClick={() => fileRef.current?.click()} disabled={busy} style={{ ...btn('#06B6D4'), opacity: busy ? 0.5 : 1 }}>{busy ? 'Importing…' : 'Choose file'}</button>
      {msg && <span style={{ fontSize: 11, color: '#10B981' }}>{msg}</span>}
      {err && <span style={{ fontSize: 11, color: '#F59E0B' }}>{err}</span>}
    </div>
  )
}

// Descriptive sail types (matches the Expedition <saillist> sailtype values).
const SAIL_TYPES = [
  'Mainsail', 'Jib', 'Genoa', 'Genoa Staysail', 'Spinnaker Staysail',
  'Masthead Spinnaker', 'Fractional Spinnaker', 'Masthead Gennaker', 'Fractional Gennaker', 'Code', 'Other',
]
const SAIL_GROUPS = [
  { v: 'M', label: 'M · main' },
  { v: 'H', label: 'H · headsail' },
  { v: 'S', label: 'S · spinnaker' },
]
// "A1.5_2026" → "A1.5"; otherwise the name as-is.
const categoryFromName = (name: string): string => name.replace(/_\d{4}$/, '').trim() || name
const groupForKind = (kind: string): string => (kind === 'mainsail' ? 'M' : kind === 'spinnaker' ? 'S' : 'H')

// Manual add — same shape as the <saillist> import rows: name + sail type +
// group + weight, with `kind` derived and the rest stored under `specs`.
function AddSailForm({ onAdd, busy, input, btn }: any) {
  const [name, setName] = useState('')
  const [sailType, setSailType] = useState('Jib')
  const [group, setGroup] = useState('')
  const [weight, setWeight] = useState('')
  const [build, setBuild] = useState('')
  const submit = () => {
    if (!name.trim()) return
    const kind = sailKindFromType(sailType, group)
    const wt = weight.trim() ? parseFloat(weight.replace(',', '.')) : null
    onAdd({
      name: name.trim(),
      kind,
      category: categoryFromName(name.trim()),
      build_date: build || null,
      specs: {
        sail_type: sailType || null,
        sail_group: group || groupForKind(kind),
        weight_kg: wt != null && !Number.isNaN(wt) ? wt : null,
        source: 'manual',
      },
    })
    setName(''); setSailType('Jib'); setGroup(''); setWeight(''); setBuild('')
  }
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 12px', background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8 }}>
      <input style={{ ...input, width: 150 }} placeholder="Sail name *" value={name} onChange={(e) => setName(e.target.value)} />
      <label style={{ fontSize: 11, color: '#64748B' }}>Type
        <select style={{ ...input, marginLeft: 4 }} value={sailType} onChange={(e) => setSailType(e.target.value)}>
          {SAIL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <label style={{ fontSize: 11, color: '#64748B' }}>Grp
        <select style={{ ...input, marginLeft: 4 }} value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">auto</option>
          {SAIL_GROUPS.map((g) => <option key={g.v} value={g.v}>{g.label}</option>)}
        </select>
      </label>
      <input style={{ ...input, width: 80 }} type="number" step="0.1" placeholder="Wt (kg)" value={weight} onChange={(e) => setWeight(e.target.value)} />
      <label style={{ fontSize: 11, color: '#64748B' }}>Build <input type="date" style={input} value={build} onChange={(e) => setBuild(e.target.value)} /></label>
      <button onClick={submit} disabled={busy || !name.trim()} style={{ ...btn('#06B6D4'), opacity: busy || !name.trim() ? 0.5 : 1 }}>{busy ? '…' : '+ Add sail'}</button>
    </div>
  )
}

// ── Import-and-assign a North scan ───────────────────────────────────────────
// File-picker for a North SailScan PDF + a sail selector (existing inventory,
// "assign later", or inline-create a new sail tag). Posts to /sail-scans, which
// parses the report into a structured row linked to the chosen sail.
function ImportScanForm({ sails, onImport, onCreateSail, input, btn }: any) {
  const active = (sails || []).filter((s: any) => !s.retired)
  const [file, setFile] = useState<File | null>(null)
  const [sailId, setSailId] = useState<string>('')   // '' = assign later, '__new' = create
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const fileRef = React.useRef<HTMLInputElement>(null)

  const submit = async () => {
    if (!file) { setErr('Pick a North report PDF first.'); return }
    setBusy(true); setErr(''); setMsg('')
    try {
      let assignTo: string | null = sailId && sailId !== '__new' ? sailId : null
      if (sailId === '__new') {
        if (!newName.trim()) { setErr('Name the new sail, or choose “assign later”.'); setBusy(false); return }
        const created = await onCreateSail({ name: newName.trim() })
        assignTo = created?.id || null
      }
      const res = await onImport(file, assignTo)
      const scans = res?.parsed || []
      const total = scans.reduce((a: number, s: any) => a + (s?.stripes?.length || 0), 0)
      const names = scans.map((s: any) => s?.sailName).filter(Boolean).join(', ')
      setMsg(`Imported ${res?.count ?? scans.length} scan${(res?.count ?? scans.length) === 1 ? '' : 's'}${names ? ` — ${names}` : ''}, ${total} stripe${total === 1 ? '' : 's'}.`)
      setFile(null); setNewName(''); setSailId('')
      if (fileRef.current) fileRef.current.value = ''
    } catch (e: any) {
      setErr(e?.message || 'Import failed.')
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 12px', background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8 }}>
      <span style={{ fontSize: 11, color: '#64748B', fontWeight: 700 }}>Import SailScan report</span>
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" style={{ ...input, padding: 4 }}
        onChange={(e) => { setFile(e.target.files?.[0] || null); setErr(''); setMsg('') }} />
      <select style={input} value={sailId} onChange={(e) => setSailId(e.target.value)}>
        <option value="">— assign later —</option>
        {active.map((s: any) => (
          <option key={s.id} value={s.id}>{s.category ? `${s.category} · ${s.name}` : s.name}</option>
        ))}
        <option value="__new">+ New sail…</option>
      </select>
      {sailId === '__new' && (
        <input style={{ ...input, width: 150 }} placeholder="New sail name *" value={newName} onChange={(e) => setNewName(e.target.value)} />
      )}
      <button onClick={submit} disabled={busy || !file} style={{ ...btn('#06B6D4'), opacity: busy || !file ? 0.5 : 1 }}>{busy ? '…' : 'Import'}</button>
      {msg && <span style={{ fontSize: 11, color: '#10B981' }}>{msg}</span>}
      {err && <span style={{ fontSize: 11, color: '#F59E0B' }}>{err}</span>}
    </div>
  )
}

// ── One inventory row (view + inline edit) ───────────────────────────────────
function SailRow({ sail, canEdit, busy, td, input, btn, onPatch, onCert }: any) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(sail.name)
  const [category, setCategory] = useState(sail.category || '')
  const [build, setBuild] = useState(sail.build_date || '')
  const fileRef = React.useRef<HTMLInputElement>(null)
  const save = () => { onPatch({ name: name.trim(), category: category.trim() || null, build_date: build || null }); setEditing(false) }

  const spec = sail.specs || {}
  const sailType = spec.sail_type || '—'
  const sailGroup = spec.sail_group || '—'
  const weight = spec.weight_kg != null ? fmt(spec.weight_kg, 1) : '—'

  if (editing) {
    return (
      <tr>
        <td style={td}><input style={{ ...input, width: 60 }} value={category} onChange={(e) => setCategory(e.target.value)} /></td>
        <td style={td}><input style={{ ...input, width: 150 }} value={name} onChange={(e) => setName(e.target.value)} /></td>
        <td style={td}>{sail.kind || '—'}</td>
        <td style={td}>{sailType}</td>
        <td style={td}>{sailGroup}</td>
        <td style={td}>{weight}</td>
        <td style={td}><input type="date" style={input} value={build || ''} onChange={(e) => setBuild(e.target.value)} /></td>
        <td style={td} colSpan={2}>
          <button onClick={save} disabled={busy} style={btn('#10B981')}>Save</button>{' '}
          <button onClick={() => setEditing(false)} style={{ ...btn('#334155'), color: '#cbd5e1' }}>Cancel</button>
        </td>
        <td style={td}></td>
      </tr>
    )
  }
  return (
    <tr style={{ opacity: sail.retired ? 0.55 : 1 }}>
      <td style={{ ...td, fontWeight: 700, color: '#06B6D4' }}>{sail.category || '—'}</td>
      <td style={td}>{sail.name}</td>
      <td style={td}>{sail.kind || '—'}</td>
      <td style={td}>{sailType}</td>
      <td style={td}>{sailGroup}</td>
      <td style={td}>{weight}</td>
      <td style={td}>{sail.build_date ? new Date(sail.build_date).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
      <td style={td}>
        {canEdit ? (
          <button onClick={() => onPatch({ retired: !sail.retired })} disabled={busy}
            style={{ background: sail.retired ? '#334155' : '#10B98122', color: sail.retired ? '#94A3B8' : '#10B981', border: `1px solid ${sail.retired ? '#334155' : '#10B981'}`, borderRadius: 6, fontSize: 11, fontWeight: 700, padding: '3px 9px', cursor: 'pointer' }}>
            {sail.retired ? 'Retired' : 'Active'}
          </button>
        ) : (sail.retired ? 'Retired' : 'Active')}
      </td>
      <td style={td}>
        {sail.certificate_name ? <span title={sail.certificate_name}>📄 {sail.certificate_name.length > 16 ? sail.certificate_name.slice(0, 14) + '…' : sail.certificate_name}</span> : <span style={{ color: '#64748B' }}>—</span>}
        {canEdit && (
          <>
            {' '}
            <button onClick={() => fileRef.current?.click()} disabled={busy} style={{ background: 'none', border: '1px solid #1E3A5A', color: '#06B6D4', borderRadius: 6, fontSize: 11, padding: '2px 7px', cursor: 'pointer' }}>{busy ? '…' : sail.certificate_name ? 'Replace' : 'Upload'}</button>
            <input ref={fileRef} type="file" accept=".pdf,image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) onCert(f); e.target.value = '' }} />
          </>
        )}
      </td>
      {canEdit && <td style={td}><button onClick={() => setEditing(true)} style={{ background: 'none', border: 'none', color: '#64748B', cursor: 'pointer', fontSize: 13 }}>✎</button></td>}
    </tr>
  )
}

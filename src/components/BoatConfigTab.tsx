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
  tws_kn?: number | null; stripes?: Stripe[]
}

const C = {
  bg: '#04101c', card: '#071624', border: '#1E3A5A', accent: '#06B6D4',
  text: '#cbd5e1', dim: '#64748B', head: '#e2e8f0', warn: '#F59E0B', ok: '#10B981',
}
const KINDS = ['jib', 'genoa', 'staysail', 'mainsail', 'spinnaker', 'gennaker', 'code', 'other']
const EDIT_ROLES = ['admin', 'team_manager', 'coach', 'tl3']
const fmt = (v: any, d = 1) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d))
const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' }) : '—'

export default function BoatConfigTab({
  teamId, boatId, role, isMobile,
}: { teamId: string; boatId: string; role?: string; config?: any; isMobile?: boolean }) {
  const canEdit = EDIT_ROLES.includes(role || '')
  const [view, setView] = useState<'inventory' | 'shapes' | 'rig' | 'polar'>('inventory')
  const [sails, setSails] = useState<Sail[]>([])
  const [scans, setScans] = useState<Scan[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string>('') // sail id being mutated
  const [polar, setPolar] = useState<any>(null)          // active polar row (DB)
  const [matrixKey, setMatrixKey] = useState<'bsp' | 'heel' | 'rudder' | 'awa'>('bsp')
  const [importing, setImporting] = useState(false)

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
  const importScan = async (file: File, sailId: string | null) => {
    const fd = new FormData()
    fd.append('boat_id', boatId)
    if (sailId) fd.append('sail_id', sailId)
    fd.append('file', file)
    const r = await fetch(`/api/teams/${teamId}/sail-scans`, { method: 'POST', body: fd }).then((x) => x.json())
    if (r.error) throw new Error(r.error)
    await refreshScans()
    return r.parsed
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
          {canEdit && <AddSailForm onAdd={createSail} busy={busy === 'new'} input={input} btn={btn} />}
          {sails.length === 0 && !loading ? (
            <div style={{ color: C.dim, fontSize: 12, marginTop: 8 }}>No sails yet.{canEdit ? ' Add one above.' : ''}</div>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Cat</th><th style={th}>Sail name</th><th style={th}>Type</th>
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
                <div key={sc.id} style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px' }}>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: stripes.length ? 6 : 0 }}>
                    <span style={{ fontWeight: 700, color: C.accent, fontSize: 12 }}>{sail?.category || sail?.name || 'unassigned sail'}</span>
                    <span style={{ fontSize: 11, color: C.text }}>{fmtDate(sc.captured_at)}</span>
                    {sc.tws_kn != null && <span style={{ fontSize: 11, color: C.dim }}>{fmt(sc.tws_kn, 0)} kn</span>}
                    {sc.source && <span style={{ fontSize: 10, color: C.dim, border: `1px solid ${C.border}`, borderRadius: 4, padding: '0 5px' }}>{sc.source}</span>}
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

      {/* ── RIG SETTINGS (placeholder) ─────────────────────────────── */}
      {view === 'rig' && (
        <div style={{ border: `1px dashed ${C.border}`, borderRadius: 10, padding: '20px 16px', textAlign: 'center', color: C.dim }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.head, marginBottom: 6 }}>Rig settings</div>
          <div style={{ fontSize: 12, maxWidth: 460, margin: '0 auto', lineHeight: 1.5 }}>
            Rig tuning matrix — coming soon. Upload a rig-tune table here and SSA will
            store it as the boat's tuning baseline (wind-banded settings linked to runs).
            Share the table format you use and this view will be built to match it.
          </div>
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
function AddSailForm({ onAdd, busy, input, btn }: any) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [kind, setKind] = useState('jib')
  const [build, setBuild] = useState('')
  const submit = () => {
    if (!name.trim()) return
    onAdd({ name: name.trim(), category: category.trim() || null, kind, build_date: build || null })
    setName(''); setCategory(''); setBuild('')
  }
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 12px', background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8 }}>
      <input style={{ ...input, width: 150 }} placeholder="Sail name *" value={name} onChange={(e) => setName(e.target.value)} />
      <input style={{ ...input, width: 80 }} placeholder="Cat (J2)" value={category} onChange={(e) => setCategory(e.target.value)} />
      <select style={input} value={kind} onChange={(e) => setKind(e.target.value)}>
        {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
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
      const parsed = await onImport(file, assignTo)
      const n = parsed?.stripes?.length ?? 0
      setMsg(`Imported ${parsed?.sailName || 'scan'} — ${n} stripe${n === 1 ? '' : 's'}${parsed?.tws != null ? `, ${parsed.tws} kn` : ''}.`)
      setFile(null); setNewName(''); setSailId('')
      if (fileRef.current) fileRef.current.value = ''
    } catch (e: any) {
      setErr(e?.message || 'Import failed.')
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 12px', background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8 }}>
      <span style={{ fontSize: 11, color: '#64748B', fontWeight: 700 }}>Import North scan</span>
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

  if (editing) {
    return (
      <tr>
        <td style={td}><input style={{ ...input, width: 60 }} value={category} onChange={(e) => setCategory(e.target.value)} /></td>
        <td style={td}><input style={{ ...input, width: 150 }} value={name} onChange={(e) => setName(e.target.value)} /></td>
        <td style={td}>{sail.kind || '—'}</td>
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

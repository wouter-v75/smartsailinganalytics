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

import React, { useEffect, useMemo, useState } from 'react'
import { loadPolarFromLS, preparePolar, polarVMGTarget } from '../lib/polarCalc'
import { uploadBlobToStorage } from '../lib/bunny-storage-upload'

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
  const [polar, setPolar] = useState<{ name: string; polar: any } | null>(null)

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

  useEffect(() => {
    try {
      const stored: any = loadPolarFromLS()
      if (stored?.data) setPolar({ name: stored.filename || 'polar', polar: preparePolar(stored.data) })
    } catch { /* none */ }
  }, [])

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
  const polarTargets = useMemo(() => {
    if (!polar?.polar) return []
    const out: any[] = []
    for (const tws of [6, 8, 10, 12, 14, 16, 18, 20]) {
      try { const t: any = polarVMGTarget(polar.polar, tws); if (t) out.push({ tws, t }) } catch {}
    }
    return out
  }, [polar])

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
        {subBtn('polar', 'Polar')}
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

      {/* ── POLAR ──────────────────────────────────────────────────── */}
      {view === 'polar' && (
        !polar ? (
          <div style={{ color: C.dim, fontSize: 12 }}>No polar loaded. Import a design/VPP polar (used across the analytics view).</div>
        ) : polarTargets.length === 0 ? (
          <div style={{ color: C.dim, fontSize: 12 }}>Polar loaded ({polar.name}) — targets not available in this build.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ fontSize: 11, color: C.dim, marginBottom: 6 }}>{polar.name}</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>TWS</th><th style={th}>Up tgt</th><th style={th}>Up TWA</th><th style={th}>Dn tgt</th><th style={th}>Dn TWA</th></tr></thead>
              <tbody>
                {polarTargets.map(({ tws, t }) => (
                  <tr key={tws}>
                    <td style={td}>{tws} kn</td>
                    <td style={td}>{fmt(t.up?.bsp ?? t.up?.speed)}</td>
                    <td style={td}>{fmt(t.up?.twa ?? t.up?.angle, 0)}°</td>
                    <td style={td}>{fmt(t.dn?.bsp ?? t.dn?.speed)}</td>
                    <td style={td}>{fmt(t.dn?.twa ?? t.dn?.angle, 0)}°</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
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

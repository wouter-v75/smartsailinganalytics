'use client'
// SailListDiffModal — shown after an event-file upload when its sail names don't
// all match the boat's SSA sail inventory. For each unmatched name the user can:
//   (i)  Add it to the inventory as a NEW sail, or
//   (ii) Link it to an existing inventory sail (stores the event name as an alias
//        on that sail so it resolves to the inventory name across the app).
// Writes go through the sails API (RLS gates to team leadership).

import React, { useState } from 'react'
import type { InvSail } from '../lib/sailResolve'

const C = {
  bg: '#0A1929', panel: '#0d2236', border: '#1E3A5A', accent: '#06B6D4',
  head: '#E2E8F0', text: '#CBD5E1', dim: '#64748B', warn: '#F59E0B', good: '#10B981',
}

type RowState = { status: 'pending' | 'busy' | 'done' | 'error'; msg?: string; how?: string }

export default function SailListDiffModal({ teamId, boatId, canEdit, inventory, names, onClose, onResolved }:
  { teamId: string; boatId: string; canEdit: boolean; inventory: InvSail[]; names: string[]; onClose: () => void; onResolved?: () => void }) {
  const [rows, setRows] = useState<Record<string, RowState>>(() => Object.fromEntries(names.map((n) => [n, { status: 'pending' }])))
  const [linkTo, setLinkTo] = useState<Record<string, string>>({}) // name -> sail id
  const active = (inventory || []).filter((s) => !s.retired)

  const set = (name: string, st: RowState) => setRows((p) => ({ ...p, [name]: st }))

  const addNew = async (name: string) => {
    set(name, { status: 'busy' })
    try {
      const r = await fetch(`/api/teams/${teamId}/sails`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boat_id: boatId, name }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || 'add failed')
      set(name, { status: 'done', how: `added as “${name}”` })
      onResolved?.()
    } catch (e: unknown) { set(name, { status: 'error', msg: (e as Error)?.message || 'failed' }) }
  }

  const linkExisting = async (name: string) => {
    const sailId = linkTo[name]
    const sail = active.find((s) => s.id === sailId)
    if (!sail) { set(name, { status: 'error', msg: 'pick a sail first' }); return }
    set(name, { status: 'busy' })
    try {
      const existing = Array.isArray(sail.specs?.aliases) ? (sail.specs!.aliases as string[]) : []
      const aliases = Array.from(new Set([...existing, name]))
      const specs = { ...(sail.specs || {}), aliases }
      const r = await fetch(`/api/teams/${teamId}/sails`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sailId, specs }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || 'link failed')
      set(name, { status: 'done', how: `linked → ${sail.name}` })
      onResolved?.()
    } catch (e: unknown) { set(name, { status: 'error', msg: (e as Error)?.message || 'failed' }) }
  }

  const allDone = names.every((n) => rows[n]?.status === 'done')

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: '32px 12px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(640px, 100%)', background: C.bg, border: `1px solid ${C.warn}55`, borderRadius: 12, padding: 18, color: C.text }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: C.warn }}>⚠ Sail list differs from sail inventory</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: '#0F2A45', border: 'none', borderRadius: 8, color: C.text, fontWeight: 700, fontSize: 13, padding: '7px 12px', cursor: 'pointer' }}>{allDone ? 'Done' : 'Later'}</button>
        </div>
        <div style={{ fontSize: 12, color: C.dim, marginBottom: 12 }}>
          These sail names in the event file aren’t in the boat’s sail inventory. Add each as a new sail, or link it to an existing one (the event name becomes an alias, so the inventory name is used across the app).
        </div>

        {!canEdit && <div style={{ fontSize: 12, color: C.warn, background: '#2a1f0a', border: `1px solid ${C.warn}40`, borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>You don’t have permission to edit the sail inventory — ask a team lead to reconcile these.</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {names.map((name) => {
            const st = rows[name] || { status: 'pending' }
            return (
              <div key={name} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, color: C.head, fontSize: 13, fontFamily: 'monospace' }}>{name}</span>
                  {st.status === 'done' && <span style={{ fontSize: 11, color: C.good }}>✓ {st.how}</span>}
                  {st.status === 'error' && <span style={{ fontSize: 11, color: '#fca5a5' }}>✗ {st.msg}</span>}
                </div>
                {canEdit && st.status !== 'done' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                    <button disabled={st.status === 'busy'} onClick={() => addNew(name)}
                      style={{ background: C.accent, border: 'none', borderRadius: 6, color: '#001018', fontWeight: 700, fontSize: 12, padding: '6px 12px', cursor: 'pointer', opacity: st.status === 'busy' ? 0.6 : 1 }}>+ Add as new sail</button>
                    <span style={{ fontSize: 11, color: C.dim }}>or link to</span>
                    <select value={linkTo[name] || ''} onChange={(e) => setLinkTo((p) => ({ ...p, [name]: e.target.value }))}
                      style={{ background: '#071624', border: `1px solid ${C.border}`, borderRadius: 6, color: C.head, padding: '5px 7px', fontSize: 12 }}>
                      <option value="">— inventory sail —</option>
                      {active.map((s) => <option key={s.id} value={s.id}>{s.category ? `${s.category} · ${s.name}` : s.name}</option>)}
                    </select>
                    <button disabled={st.status === 'busy' || !linkTo[name]} onClick={() => linkExisting(name)}
                      style={{ background: linkTo[name] ? C.good : '#334155', border: 'none', borderRadius: 6, color: linkTo[name] ? '#001018' : '#64748B', fontWeight: 700, fontSize: 12, padding: '6px 12px', cursor: linkTo[name] ? 'pointer' : 'default' }}>Link</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

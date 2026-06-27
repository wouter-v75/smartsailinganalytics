'use client'
// src/components/LogProfilePanel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Per-boat log profile editor. The upload AUTO-DETECTS the file format; this
// panel lets a boat add channel-label ALIASES on top, for when its Expedition
// setup labels a channel differently from the built-in defaults. Stored in
// localStorage `ssa:log-profile:active` (read by parseCsvWithTz → parseLog).
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react'
import { DEFAULT_ALIASES, type LogField } from '../lib/logProfile'

const C = { bg: '#0A1929', panel: '#0d2236', border: '#1E3A5A', accent: '#06B6D4', head: '#E2E8F0', text: '#CBD5E1', dim: '#64748B', good: '#10B981', warn: '#F59E0B' }
const LS_KEY = 'ssa:log-profile:active'

const FIELD_LABEL: Partial<Record<LogField, string>> = {
  bsp: 'Boat speed', awa: 'AWA', aws: 'AWS', twa: 'TWA', tws: 'TWS', twd: 'TWD',
  heel: 'Heel', trim: 'Trim', sog: 'SOG', cog: 'COG', vmg: 'VMG', rudder: 'Rudder',
  polarBspPct: 'Polar BSP %', forestay: 'Forestay', rake: 'Rake', keelAng: 'Keel angle',
  upDflctPct: 'Upper deflector %', lwDflctPct: 'Lower deflector %', travPct: 'Traveller %', cunnoPct: 'Cunningham %',
  jibTackLoad: 'Jib-tack load', cunninghamLoad: 'Cunningham load', mastAng: 'Mast angle', mastButt: 'Mast butt',
  leeway: 'Leeway', set: 'Set', drift: 'Drift', hdg: 'Heading',
  targHeel: 'Target heel', targTwa: 'Target TWA', targBsp: 'Target BSP', targVmg: 'Target VMG',
  targFsty: 'Target forestay', targBsty: 'Target backstay', targKeel: 'Target keel',
  lat: 'Latitude', lon: 'Longitude', polBsp: 'Polar BSP',
}

type Overrides = Partial<Record<LogField, string[]>>

function load(): Overrides {
  try { const p = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); return (p && p.aliases) || {} } catch { return {} }
}

export default function LogProfilePanel({ canEdit }: { canEdit: boolean }) {
  const [overrides, setOverrides] = useState<Overrides>(() => (typeof window === 'undefined' ? {} : load()))
  const [field, setField] = useState<LogField>('polarBspPct')
  const [labels, setLabels] = useState('')
  const [msg, setMsg] = useState('')

  const fields = useMemo(() => (Object.keys(DEFAULT_ALIASES) as LogField[]), [])
  const entries = Object.entries(overrides).filter(([, v]) => (v || []).length) as [LogField, string[]][]

  const add = () => {
    const ls = labels.split(',').map((s) => s.trim()).filter(Boolean)
    if (!ls.length) return
    setOverrides((o) => ({ ...o, [field]: Array.from(new Set([...(o[field] || []), ...ls])) }))
    setLabels(''); setMsg('')
  }
  const removeField = (f: LogField) => setOverrides((o) => { const n = { ...o }; delete n[f]; return n })
  const save = () => {
    const aliases: Overrides = {}
    for (const [f, v] of Object.entries(overrides)) if ((v || []).length) aliases[f as LogField] = v
    try { localStorage.setItem(LS_KEY, JSON.stringify({ aliases })); setMsg('Saved — applies to the next log upload') }
    catch (e: any) { setMsg('Save failed: ' + (e?.message || e)) }
  }

  const inp: React.CSSProperties = { background: '#071624', border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 8px', color: C.head, fontSize: 12 }

  return (
    <div style={{ color: C.text }}>
      <div style={{ fontSize: 12, color: C.dim, marginBottom: 12, lineHeight: 1.5, maxWidth: 640 }}>
        The log <b style={{ color: C.text }}>format</b> (Expedition raw / flat-CSV) is detected automatically from each file.
        Use this only when a channel in <i>this boat's</i> log is <b style={{ color: C.text }}>labelled differently</b> from the
        defaults — add the boat's label and it maps to our field without a code change. Most boats need nothing here.
      </div>

      {/* Add an override */}
      {canEdit && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10 }}>
          <label style={{ fontSize: 10, color: C.dim }}>Field
            <select value={field} onChange={(e) => setField(e.target.value as LogField)} style={{ ...inp, display: 'block', marginTop: 3, minWidth: 180 }}>
              {fields.map((f) => <option key={f} value={f}>{FIELD_LABEL[f] || f}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 10, color: C.dim, flex: 1, minWidth: 200 }}>This boat's column/channel label(s) — comma-separated
            <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="e.g. MyPolar%, Polar BSP" style={{ ...inp, display: 'block', marginTop: 3, width: '100%' }} />
          </label>
          <button onClick={add} style={{ background: C.accent, border: 'none', borderRadius: 6, color: '#001018', fontWeight: 700, fontSize: 12, padding: '8px 14px', cursor: 'pointer' }}>Add</button>
        </div>
      )}

      {/* Current overrides */}
      {entries.length === 0 ? (
        <div style={{ fontSize: 12, color: C.dim }}>No custom aliases — using built-in defaults for every field.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {entries.map(([f, v]) => (
            <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '7px 10px' }}>
              <span style={{ fontWeight: 700, color: C.accent, fontSize: 13, minWidth: 150 }}>{FIELD_LABEL[f] || f}</span>
              <span style={{ flex: 1, fontSize: 12 }}>{v.join(' · ')}</span>
              <span style={{ fontSize: 10, color: C.dim }}>default: {DEFAULT_ALIASES[f].join(', ')}</span>
              {canEdit && <button onClick={() => removeField(f)} style={{ background: 'none', border: 'none', color: '#EF4444', cursor: 'pointer', fontSize: 15 }}>×</button>}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
          <button onClick={save} style={{ background: C.good, border: 'none', borderRadius: 7, color: '#001018', fontWeight: 700, fontSize: 13, padding: '8px 16px', cursor: 'pointer' }}>Save log profile</button>
          {msg && <span style={{ fontSize: 11, color: msg.startsWith('Saved') ? C.good : C.warn }}>{msg}</span>}
        </div>
      )}
    </div>
  )
}

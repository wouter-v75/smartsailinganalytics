// Campaign tab — the team's operating system for the work-up.
//
// Sub-tabs: Plan (global calendar, built here) · Backlog · Day (coming next).
// Gated upstream: only mounted when the team has features.campaign_engine on.
//
// Theme: dark inline styles to match the host SPA (not the light Tailwind
// admin panels). Mobile-friendly: single column, wrapping chips.
//
// Permissions (per Wouter's model):
//   • canEditPlan  (coach / team_manager / admin) — make & edit the plan.
//   • canEditDates (team_manager / admin)         — set campaign target date.
//   • canSeeTesting (tl2 and above)               — see technical/speed-testing
//        blocks. Race-training + other are visible to everyone.

import React, { useState, useEffect, useCallback } from 'react'

const BLOCK_META = {
  'technical-testing': { label: 'Technical testing', c: '#F59E0B', testing: true },
  'speed-testing':     { label: 'Speed testing',     c: '#06B6D4', testing: true },
  'race-training':     { label: 'Race training',     c: '#1D9E75', testing: false },
  'other':             { label: 'Other',             c: '#64748B', testing: false },
}
const BLOCK_ORDER = ['technical-testing', 'speed-testing', 'race-training', 'other']

const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}
const fmtDay = (iso) => {
  // Parse as local date (avoid TZ shift from Date('YYYY-MM-DD') = UTC midnight).
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}
const daysBetween = (fromIso, toIso) => {
  const [ay, am, ad] = fromIso.split('-').map(Number)
  const [by, bm, bd] = toIso.split('-').map(Number)
  const a = Date.UTC(ay, am - 1, ad)
  const b = Date.UTC(by, bm - 1, bd)
  return Math.round((b - a) / 86400000)
}
const minToHHMM = (m) =>
  m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const hhmmToMin = (s) => {
  if (!s) return null
  const [h, m] = s.split(':').map(Number)
  if (Number.isNaN(h)) return null
  return h * 60 + (m || 0)
}

export default function CampaignTab({ teamId, boatId, role, config, isMobile }) {
  const [sub, setSub] = useState('plan')
  const canEditPlan = ['admin', 'coach', 'team_manager'].includes(role)
  const canEditDates = ['admin', 'team_manager'].includes(role)
  const canSeeTesting = ['admin', 'team_manager', 'coach', 'tl2', 'consultant'].includes(role)

  const subTab = (id, label) => (
    <button
      key={id}
      onClick={() => setSub(id)}
      style={{
        padding: '7px 16px',
        borderRadius: 8,
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 700,
        background: sub === id ? '#06B6D4' : '#0F2A45',
        color: sub === id ? '#000' : '#94A3B8',
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        background: '#030F1A',
        color: '#E2E8F0',
        padding: isMobile ? '14px 12px 40px' : '20px 24px 60px',
      }}
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        {subTab('plan', 'Plan')}
        {subTab('backlog', 'Backlog')}
        {subTab('day', 'Day')}
      </div>

      {sub === 'plan' && (
        <PlanView
          teamId={teamId}
          boatId={boatId}
          canEditPlan={canEditPlan}
          canEditDates={canEditDates}
          canSeeTesting={canSeeTesting}
          isMobile={isMobile}
        />
      )}
      {sub === 'backlog' && (
        <Placeholder title="Backlog" note="The one prioritised backlog — coming next." />
      )}
      {sub === 'day' && (
        <Placeholder title="Day plan" note="Today's plan + wind-adaptive selection — coming next." />
      )}
    </div>
  )
}

function Placeholder({ title, note }) {
  return (
    <div
      style={{
        border: '1px dashed #1E3A5A',
        borderRadius: 12,
        padding: 40,
        textAlign: 'center',
        color: '#475569',
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, color: '#64748B', marginBottom: 6 }}>
        {title}
      </div>
      <div style={{ fontSize: 12 }}>{note}</div>
    </div>
  )
}

function PlanView({ teamId, boatId, canEditPlan, canEditDates, canSeeTesting, isMobile }) {
  const [sessions, setSessions] = useState([])
  const [targetDate, setTargetDate] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [newDate, setNewDate] = useState('')

  const base = `/api/teams/${teamId}/boats/${boatId}/campaign`

  const load = useCallback(async () => {
    setErr(null)
    try {
      const res = await fetch(`${base}/calendar`)
      if (!res.ok) {
        setErr((await res.json().catch(() => ({}))).error || `failed (${res.status})`)
        return
      }
      const j = await res.json()
      setSessions(j.sessions || [])
      setTargetDate(j.targetDate || null)
    } finally {
      setLoading(false)
    }
  }, [base])

  useEffect(() => {
    load()
  }, [load])

  const today = todayStr()
  const trainingDaysToGo = sessions.filter((s) => s.date >= today).length
  const daysToGo = targetDate ? Math.max(0, daysBetween(today, targetDate)) : null

  async function addDay(e) {
    e.preventDefault()
    if (!newDate) return
    const res = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: newDate }),
    })
    if (!res.ok) {
      setErr((await res.json().catch(() => ({}))).error || 'could not add day')
      return
    }
    setNewDate('')
    load()
  }

  async function saveTarget(date) {
    const res = await fetch(`/api/teams/${teamId}/campaign/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_date: date || null }),
    })
    if (res.ok) setTargetDate(date || null)
    else setErr((await res.json().catch(() => ({}))).error || 'could not save date')
  }

  return (
    <div>
      {/* Countdown header */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 18,
        }}
      >
        <Counter big value={daysToGo == null ? '—' : daysToGo} label="Days to go" sub={targetDate ? `to ${fmtDay(targetDate)}` : 'no target set'} />
        <Counter big value={trainingDaysToGo} label="Training days to go" sub={`${sessions.length} day${sessions.length === 1 ? '' : 's'} planned`} />
      </div>

      {canEditDates && (
        <div style={{ marginBottom: 16, fontSize: 12, color: '#64748B', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>Campaign target date:</span>
          <input
            type="date"
            defaultValue={targetDate || ''}
            onChange={(e) => saveTarget(e.target.value)}
            style={inputStyle}
          />
        </div>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14, fontSize: 11, color: '#64748B' }}>
        {BLOCK_ORDER.filter((t) => canSeeTesting || !BLOCK_META[t].testing).map((t) => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: BLOCK_META[t].c, display: 'inline-block' }} />
            {BLOCK_META[t].label}
          </span>
        ))}
      </div>

      {/* Add day */}
      {canEditPlan && (
        <form onSubmit={addDay} style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} style={inputStyle} />
          <button type="submit" disabled={!newDate} style={btnPrimary}>+ Add test day</button>
        </form>
      )}

      {err && <div style={{ color: '#EF4444', fontSize: 13, marginBottom: 12 }}>{err}</div>}

      {loading ? (
        <div style={{ color: '#475569', fontSize: 13 }}>Loading calendar…</div>
      ) : sessions.length === 0 ? (
        <div style={{ color: '#475569', fontSize: 13, textAlign: 'center', padding: 30, border: '1px dashed #1E3A5A', borderRadius: 12 }}>
          No test days yet.{canEditPlan ? ' Add the first one above.' : ''}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sessions.map((s) => (
            <DayCard
              key={s.id}
              base={base}
              session={s}
              isPast={s.date < today}
              canEditPlan={canEditPlan}
              canSeeTesting={canSeeTesting}
              isMobile={isMobile}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Counter({ value, label, sub }) {
  return (
    <div
      style={{
        background: '#0A1929',
        border: '1px solid #1E3A5A',
        borderRadius: 12,
        padding: '14px 20px',
        minWidth: 150,
        flex: '1 1 150px',
      }}
    >
      <div style={{ fontSize: 34, fontWeight: 800, color: '#06B6D4', lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#E2E8F0', marginTop: 6 }}>{label}</div>
      <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>{sub}</div>
    </div>
  )
}

function DayCard({ base, session, isPast, canEditPlan, canSeeTesting, isMobile, onChanged }) {
  const [objective, setObjective] = useState(session.objective || '')
  const [objDirty, setObjDirty] = useState(false)
  const [adding, setAdding] = useState(false)

  const visibleBlocks = (session.blocks || []).filter(
    (b) => canSeeTesting || !BLOCK_META[b.block_type]?.testing
  )

  async function saveObjective() {
    await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: session.date, objective }),
    })
    setObjDirty(false)
    onChanged()
  }

  return (
    <div
      style={{
        background: '#0A1929',
        border: '1px solid #1E3A5A',
        borderRadius: 12,
        padding: 14,
        opacity: isPast ? 0.7 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: '#E2E8F0' }}>{fmtDay(session.date)}</span>
        {isPast && <span style={{ fontSize: 10, color: '#475569' }}>past</span>}
      </div>

      {/* Objective */}
      {canEditPlan ? (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <input
            value={objective}
            onChange={(e) => { setObjective(e.target.value); setObjDirty(true) }}
            placeholder="Day objective…"
            style={{ ...inputStyle, flex: 1 }}
          />
          {objDirty && <button onClick={saveObjective} style={btnSmall}>Save</button>}
        </div>
      ) : (
        objective && <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 10 }}>{objective}</div>
      )}

      {/* Blocks */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visibleBlocks.length === 0 ? (
          <div style={{ fontSize: 11, color: '#475569' }}>No blocks{canSeeTesting ? '' : ' visible'}.</div>
        ) : (
          visibleBlocks.map((b) => (
            <BlockRow key={b.id} base={base} block={b} canEditPlan={canEditPlan} onChanged={onChanged} />
          ))
        )}
      </div>

      {canEditPlan && (
        adding ? (
          <BlockForm
            base={base}
            sessionId={session.id}
            seq={(session.blocks || []).length}
            onDone={() => { setAdding(false); onChanged() }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button onClick={() => setAdding(true)} style={{ ...btnGhost, marginTop: 8 }}>+ Add block</button>
        )
      )}
    </div>
  )
}

function BlockRow({ base, block, canEditPlan, onChanged }) {
  const meta = BLOCK_META[block.block_type] || BLOCK_META.other
  const time =
    block.start_min != null
      ? `${minToHHMM(block.start_min)}${block.end_min != null ? '–' + minToHHMM(block.end_min) : ''}`
      : ''

  async function remove() {
    if (!confirm('Delete this block?')) return
    await fetch(`${base}/blocks/${block.id}`, { method: 'DELETE' })
    onChanged()
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: '#071624',
        borderLeft: `3px solid ${meta.c}`,
        borderRadius: 6,
        padding: '7px 10px',
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 700, color: meta.c }}>{meta.label}</span>
      {block.label && <span style={{ fontSize: 12, color: '#E2E8F0' }}>· {block.label}</span>}
      {time && <span style={{ fontSize: 11, color: '#475569', fontFamily: 'monospace' }}>{time}</span>}
      {block.objective && <span style={{ fontSize: 11, color: '#64748B' }}>— {block.objective}</span>}
      <div style={{ flex: 1 }} />
      {canEditPlan && (
        <button onClick={remove} title="Delete block" style={{ background: 'none', border: 'none', color: '#EF4444', cursor: 'pointer', fontSize: 13 }}>✕</button>
      )}
    </div>
  )
}

function BlockForm({ base, sessionId, seq, onDone, onCancel }) {
  const [type, setType] = useState('speed-testing')
  const [label, setLabel] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function add() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`${base}/blocks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          block_type: type,
          label: label || null,
          seq,
          start_min: hhmmToMin(start),
          end_min: hhmmToMin(end),
        }),
      })
      if (!res.ok) {
        setErr((await res.json().catch(() => ({}))).error || 'could not add block')
        return
      }
      onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 8, background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8, padding: 10, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <select value={type} onChange={(e) => setType(e.target.value)} style={inputStyle}>
        {BLOCK_ORDER.map((t) => (
          <option key={t} value={t}>{BLOCK_META[t].label}</option>
        ))}
      </select>
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" style={{ ...inputStyle, flex: 1, minWidth: 120 }} />
      <input type="time" value={start} onChange={(e) => setStart(e.target.value)} style={inputStyle} title="Start" />
      <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} style={inputStyle} title="End" />
      <button onClick={add} disabled={busy} style={btnSmall}>Add</button>
      <button onClick={onCancel} style={btnGhost}>Cancel</button>
      {err && <div style={{ color: '#EF4444', fontSize: 12, width: '100%' }}>{err}</div>}
    </div>
  )
}

const inputStyle = {
  background: '#071624',
  border: '1px solid #1E3A5A',
  borderRadius: 6,
  color: '#E2E8F0',
  padding: '6px 9px',
  fontSize: 13,
}
const btnPrimary = {
  background: '#06B6D4',
  border: 'none',
  borderRadius: 6,
  color: '#000',
  fontWeight: 700,
  fontSize: 13,
  padding: '6px 14px',
  cursor: 'pointer',
}
const btnSmall = {
  background: '#06B6D4',
  border: 'none',
  borderRadius: 6,
  color: '#000',
  fontWeight: 700,
  fontSize: 12,
  padding: '6px 12px',
  cursor: 'pointer',
}
const btnGhost = {
  background: '#1E3A5A',
  border: 'none',
  borderRadius: 6,
  color: '#94A3B8',
  fontSize: 12,
  padding: '6px 12px',
  cursor: 'pointer',
}

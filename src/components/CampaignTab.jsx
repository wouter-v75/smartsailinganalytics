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
import { uploadBlobToStorage } from '../lib/bunny-storage-upload'

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
const datesInRange = (aIso, bIso) => {
  if (!aIso) return []
  const end = bIso && bIso >= aIso ? bIso : aIso
  const out = []
  const [y, m, d] = aIso.split('-').map(Number)
  let cur = new Date(y, m - 1, d)
  const [ey, em, ed] = end.split('-').map(Number)
  const stop = new Date(ey, em - 1, ed)
  let guard = 0
  while (cur <= stop && guard < 120) {
    out.push(
      `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`
    )
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1)
    guard++
  }
  return out
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
        <BacklogView
          teamId={teamId}
          boatId={boatId}
          role={role}
          config={config}
          canEditPlan={canEditPlan}
          isMobile={isMobile}
        />
      )}
      {sub === 'day' && (
        <DayView
          teamId={teamId}
          boatId={boatId}
          role={role}
          canEditPlan={canEditPlan}
          isMobile={isMobile}
        />
      )}
    </div>
  )
}

// ── Backlog ──────────────────────────────────────────────────────────────────
const CAT_COLOR = { racing: '#1D9E75', technical: '#F59E0B', 'whole-team': '#8B5CF6' }
const KIND_LABEL = { action: 'Action', fmea: 'FMEA', task: 'Task', deliverable: 'Deliverable', milestone: 'Milestone' }
const PRIO_COLOR = { 1: '#EF4444', 2: '#F97316', 3: '#F59E0B', 4: '#64748B', 5: '#475569' }
const ANSWER_META = {
  unanswered: { label: 'Not tested', c: '#64748B' },
  partial: { label: 'Partial', c: '#F59E0B' },
  answered: { label: 'Answered', c: '#1D9E75' },
}
const WRITE_ROLES = ['admin', 'team_manager', 'coach', 'tl1', 'tl2']

function BacklogView({ teamId, boatId, role, config, canEditPlan, isMobile }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [filterSub, setFilterSub] = useState('all') // 'all' | 'mine' | subteamId
  const [showDone, setShowDone] = useState(false)
  const [adding, setAdding] = useState(false)

  const subteams = (config?.subteams || []).filter((s) => s.active !== false)
  const mySubteamIds = config?.mySubteamIds || []
  const canAdd = WRITE_ROLES.includes(role)
  const base = `/api/teams/${teamId}/boats/${boatId}/campaign`

  const canEditItem = useCallback(
    (it) => canEditPlan || (it.subteam_id && mySubteamIds.includes(it.subteam_id)),
    [canEditPlan, mySubteamIds]
  )

  const load = useCallback(async () => {
    setErr(null)
    try {
      const res = await fetch(`${base}/backlog`)
      if (!res.ok) {
        setErr((await res.json().catch(() => ({}))).error || `failed (${res.status})`)
        return
      }
      setItems((await res.json()).items || [])
    } finally {
      setLoading(false)
    }
  }, [base])

  useEffect(() => { load() }, [load])

  const visible = items.filter((it) => {
    if (!showDone && (it.status === 'done' || it.status === 'wontfix')) return false
    if (filterSub === 'mine') return it.subteam_id && mySubteamIds.includes(it.subteam_id)
    if (filterSub !== 'all') return it.subteam_id === filterSub
    return true
  })

  async function patch(id, body) {
    const res = await fetch(`${base}/backlog/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error || 'update failed'); return }
    load()
  }
  async function remove(id) {
    if (!confirm('Delete this backlog item?')) return
    await fetch(`${base}/backlog/${id}`, { method: 'DELETE' })
    load()
  }

  const chip = (key, label) => (
    <button
      key={key}
      onClick={() => setFilterSub(key)}
      style={{
        fontSize: 11, borderRadius: 999, padding: '4px 10px', cursor: 'pointer',
        border: `1px solid ${filterSub === key ? '#06B6D4' : '#1E3A5A'}`,
        background: filterSub === key ? '#06B6D4' : 'transparent',
        color: filterSub === key ? '#000' : '#94A3B8',
      }}
    >{label}</button>
  )

  return (
    <div>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        {chip('all', 'All')}
        {mySubteamIds.length > 0 && chip('mine', 'My sub-teams')}
        {subteams.map((s) => chip(s.id, s.label))}
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: 11, color: '#64748B', display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> show done
        </label>
      </div>

      {canAdd && (
        adding
          ? <AddItemForm base={base} subteams={subteams} mySubteamIds={mySubteamIds} canEditPlan={canEditPlan} onDone={() => { setAdding(false); load() }} onCancel={() => setAdding(false)} />
          : <button onClick={() => setAdding(true)} style={{ ...btnPrimary, marginBottom: 14 }}>+ New item</button>
      )}

      {err && <div style={{ color: '#EF4444', fontSize: 13, marginBottom: 10 }}>{err}</div>}

      {loading ? (
        <div style={{ color: '#475569', fontSize: 13 }}>Loading backlog…</div>
      ) : visible.length === 0 ? (
        <div style={{ color: '#475569', fontSize: 13, textAlign: 'center', padding: 30, border: '1px dashed #1E3A5A', borderRadius: 12 }}>
          No items{filterSub !== 'all' ? ' in this filter' : ''}.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {visible.map((it) => (
            <ItemCard
              key={it.id}
              item={it}
              editable={canEditItem(it)}
              canSetPriority={canEditPlan}
              onPatch={(body) => patch(it.id, body)}
              onDelete={() => remove(it.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ItemCard({ item, editable, canSetPriority, onPatch, onDelete }) {
  const sub = item.subteams
  const catColor = sub ? CAT_COLOR[sub.category] || '#64748B' : '#334155'
  const [pct, setPct] = useState(item.progress_pct ?? 0)
  useEffect(() => { setPct(item.progress_pct ?? 0) }, [item.progress_pct])
  const windBand =
    item.wind_min_kt != null || item.wind_max_kt != null
      ? `${item.wind_min_kt ?? '0'}–${item.wind_max_kt ?? '∞'} kt`
      : null

  return (
    <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderLeft: `4px solid ${catColor}`, borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        {/* Priority */}
        {canSetPriority ? (
          <select
            value={item.priority ?? ''}
            onChange={(e) => onPatch({ priority: e.target.value === '' ? null : Number(e.target.value) })}
            title="Priority"
            style={{ ...inputStyle, padding: '2px 4px', fontSize: 11, color: PRIO_COLOR[item.priority] || '#64748B', fontWeight: 800 }}
          >
            <option value="">P–</option>
            {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>P{p}</option>)}
          </select>
        ) : (
          <span style={{ fontSize: 12, fontWeight: 800, color: PRIO_COLOR[item.priority] || '#475569' }}>
            {item.priority ? `P${item.priority}` : 'P–'}
          </span>
        )}
        <span style={{ fontSize: 14, fontWeight: 700, color: '#E2E8F0', flex: 1, minWidth: 120 }}>{item.title}</span>
        <span style={{ fontSize: 9, color: '#64748B', border: '1px solid #1E3A5A', borderRadius: 4, padding: '1px 5px' }}>{KIND_LABEL[item.kind] || item.kind}</span>
        {sub && <span style={{ fontSize: 9, color: catColor, border: `1px solid ${catColor}55`, borderRadius: 4, padding: '1px 5px' }}>{sub.label}</span>}
        {windBand && <span style={{ fontSize: 9, color: '#7DD3FC', fontFamily: 'monospace' }}>{windBand}</span>}
      </div>

      {item.body && <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 6 }}>{item.body}</div>}

      {/* Completion control */}
      <div style={{ marginTop: 10 }}>
        {item.completion === 'progress' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, height: 8, background: '#071624', borderRadius: 4, overflow: 'hidden', border: '1px solid #1E3A5A' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? '#1D9E75' : '#06B6D4', transition: 'width .2s' }} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 800, color: pct >= 100 ? '#1D9E75' : '#06B6D4', width: 38, textAlign: 'right' }}>{pct}%</span>
            {editable && (
              <input
                type="range" min={0} max={100} step={5} value={pct}
                onChange={(e) => setPct(Number(e.target.value))}
                onMouseUp={(e) => onPatch({ progress_pct: Number(e.target.value) })}
                onTouchEnd={(e) => onPatch({ progress_pct: Number(e.target.value) })}
                style={{ width: 120 }}
                title="Confidence"
              />
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {Object.keys(ANSWER_META).map((st) => {
              const on = (item.answer_state || 'unanswered') === st
              const m = ANSWER_META[st]
              return (
                <button
                  key={st}
                  disabled={!editable}
                  onClick={() => editable && onPatch({ answer_state: st })}
                  style={{
                    fontSize: 11, borderRadius: 6, padding: '4px 10px',
                    cursor: editable ? 'pointer' : 'default',
                    border: `1px solid ${on ? m.c : '#1E3A5A'}`,
                    background: on ? m.c : 'transparent',
                    color: on ? '#001018' : '#64748B', fontWeight: on ? 800 : 500,
                    opacity: editable || on ? 1 : 0.6,
                  }}
                >{m.label}</button>
              )
            })}
          </div>
        )}
      </div>

      {editable && (
        <div style={{ marginTop: 10, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={item.status} onChange={(e) => onPatch({ status: e.target.value })} style={{ ...inputStyle, fontSize: 11, padding: '4px 6px' }}>
            {['open', 'in_progress', 'done', 'parked', 'wontfix'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div style={{ flex: 1 }} />
          <button onClick={onDelete} style={{ background: 'none', border: 'none', color: '#EF4444', cursor: 'pointer', fontSize: 12 }}>Delete</button>
        </div>
      )}
    </div>
  )
}

function AddItemForm({ base, subteams, mySubteamIds, canEditPlan, onDone, onCancel }) {
  // Non-coach members can only file into their own sub-teams.
  const allowedSubteams = canEditPlan ? subteams : subteams.filter((s) => mySubteamIds.includes(s.id))
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState('action')
  const [completion, setCompletion] = useState('binary')
  const [subteamId, setSubteamId] = useState(allowedSubteams[0]?.id || '')
  const [priority, setPriority] = useState('')
  const [wmin, setWmin] = useState('')
  const [wmax, setWmax] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function add() {
    if (!title.trim()) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`${base}/backlog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, kind, completion,
          subteam_id: subteamId || null,
          priority: priority === '' ? null : Number(priority),
          wind_min_kt: wmin === '' ? null : Number(wmin),
          wind_max_kt: wmax === '' ? null : Number(wmax),
        }),
      })
      if (!res.ok) { setErr((await res.json().catch(() => ({}))).error || 'could not add'); return }
      onDone()
    } finally { setBusy(false) }
  }

  return (
    <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 10, padding: 12, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing / answering?" style={{ ...inputStyle, fontSize: 14 }} autoFocus />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={inputStyle} title="Kind">
          {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={completion} onChange={(e) => setCompletion(e.target.value)} style={inputStyle} title="Completion">
          <option value="binary">Question (answered y/n)</option>
          <option value="progress">Goal (0–100%)</option>
        </select>
        <select value={subteamId} onChange={(e) => setSubteamId(e.target.value)} style={inputStyle} title="Sub-team">
          <option value="">— sub-team —</option>
          {allowedSubteams.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        {canEditPlan && (
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={inputStyle} title="Priority">
            <option value="">Priority…</option>
            {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>P{p}</option>)}
          </select>
        )}
        <input type="number" value={wmin} onChange={(e) => setWmin(e.target.value)} placeholder="wind min" style={{ ...inputStyle, width: 90 }} title="Testable wind min (kt)" />
        <input type="number" value={wmax} onChange={(e) => setWmax(e.target.value)} placeholder="wind max" style={{ ...inputStyle, width: 90 }} title="Testable wind max (kt)" />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={add} disabled={busy || !title.trim()} style={btnPrimary}>Add item</button>
        <button onClick={onCancel} style={btnGhost}>Cancel</button>
        {err && <span style={{ color: '#EF4444', fontSize: 12, alignSelf: 'center' }}>{err}</span>}
      </div>
    </div>
  )
}

// ── Day sub-tab ──────────────────────────────────────────────────────────────
const safeName = (n) => n.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)

function DayView({ teamId, boatId, role, canEditPlan, isMobile }) {
  const [date, setDate] = useState(todayStr())
  const [session, setSession] = useState(null) // {id, objective, blocks} | null
  const [allDates, setAllDates] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const canSeeTesting = ['admin', 'team_manager', 'coach', 'tl2', 'consultant'].includes(role)
  const canEditDebrief = WRITE_ROLES.includes(role)
  const base = `/api/teams/${teamId}/boats/${boatId}/campaign`

  const loadCalendar = useCallback(async () => {
    try {
      const res = await fetch(`${base}/calendar`)
      if (!res.ok) return
      const j = await res.json()
      const list = j.sessions || []
      setAllDates(list.map((s) => s.date))
      setSession(list.find((s) => s.date === date) || null)
    } finally {
      setLoading(false)
    }
  }, [base, date])

  useEffect(() => { loadCalendar() }, [loadCalendar])

  const blocks = (session?.blocks || []).filter(
    (b) => canSeeTesting || !BLOCK_META[b.block_type]?.testing
  )

  return (
    <div>
      {/* Date selector */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
        {allDates.length > 0 && (
          <select value={allDates.includes(date) ? date : ''} onChange={(e) => e.target.value && setDate(e.target.value)} style={inputStyle}>
            <option value="">Jump to planned day…</option>
            {allDates.map((d) => <option key={d} value={d}>{fmtDay(d)}</option>)}
          </select>
        )}
        {date === todayStr() && <span style={{ fontSize: 11, color: '#1D9E75', fontWeight: 700 }}>● Today</span>}
      </div>

      {err && <div style={{ color: '#EF4444', fontSize: 13, marginBottom: 10 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 14, flexDirection: isMobile ? 'column' : 'row', alignItems: 'stretch' }}>
        {/* Plan for today */}
        <div style={{ flex: isMobile ? 'none' : '1.1 1 0', background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0', marginBottom: 10 }}>Plan for {fmtDay(date)}</div>
          {loading ? (
            <div style={{ color: '#475569', fontSize: 13 }}>Loading…</div>
          ) : !session ? (
            <div style={{ color: '#475569', fontSize: 12 }}>
              No plan for this day yet.{canEditPlan ? ' Add it in the Plan tab (blocks) — backlog-item selection lands next.' : ''}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {session.objective && (
                <div style={{ fontSize: 12, color: '#94A3B8', borderLeft: '2px solid #06B6D4', paddingLeft: 8 }}>{session.objective}</div>
              )}
              {blocks.length === 0 ? (
                <div style={{ fontSize: 12, color: '#475569' }}>No blocks{canSeeTesting ? '' : ' visible'} for this day.</div>
              ) : (
                blocks.map((b) => {
                  const meta = BLOCK_META[b.block_type] || BLOCK_META.other
                  const time = b.start_min != null ? `${minToHHMM(b.start_min)}${b.end_min != null ? '–' + minToHHMM(b.end_min) : ''}` : ''
                  return (
                    <div key={b.id} style={{ background: '#071624', borderLeft: `3px solid ${meta.c}`, borderRadius: 6, padding: '8px 10px' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: meta.c }}>{meta.label}</span>
                        {b.label && <span style={{ fontSize: 12, color: '#E2E8F0' }}>· {b.label}</span>}
                        {time && <span style={{ fontSize: 11, color: '#475569', fontFamily: 'monospace' }}>{time}</span>}
                      </div>
                      {b.objective && <div style={{ fontSize: 11, color: '#64748B', marginTop: 3 }}>{b.objective}</div>}
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>

        {/* Debrief notes */}
        <DebriefCard
          base={base}
          date={date}
          canEdit={canEditDebrief}
          isMobile={isMobile}
        />
      </div>
    </div>
  )
}

function DebriefCard({ base, date, canEdit, isMobile }) {
  const [learnings, setLearnings] = useState('')
  const [nextFocus, setNextFocus] = useState('')
  const [docs, setDocs] = useState([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState(null)

  const load = useCallback(async () => {
    setErr(null)
    const res = await fetch(`${base}/debrief?date=${date}`)
    if (!res.ok) { setErr('could not load debrief'); return }
    const j = await res.json()
    setLearnings(j.debrief?.learnings || '')
    setNextFocus(j.debrief?.next_focus || '')
    setDocs(j.debrief?.documents || [])
    setDirty(false)
  }, [base, date])

  useEffect(() => { load() }, [load])

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      const res = await fetch(`${base}/debrief`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, learnings, next_focus: nextFocus }),
      })
      if (!res.ok) { setErr((await res.json().catch(() => ({}))).error || 'save failed'); return }
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  async function onPickFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setErr(null)
    try {
      const key = `campaign/debriefs/${date}/${Date.now()}-${safeName(file.name)}`
      await uploadBlobToStorage({ key, blob: file, contentType: file.type })
      const res = await fetch(`${base}/debrief/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, name: file.name, key, bytes: file.size, content_type: file.type }),
      })
      if (!res.ok) { setErr((await res.json().catch(() => ({}))).error || 'could not register document'); return }
      load()
    } catch (e2) {
      setErr(e2?.message || 'upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function removeDoc(key) {
    if (!confirm('Remove this document?')) return
    await fetch(`${base}/debrief/documents`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, key }),
    })
    load()
  }

  const section = (label, value, setter) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>{label}</div>
      {canEdit ? (
        <textarea
          value={value}
          onChange={(e) => { setter(e.target.value); setDirty(true) }}
          rows={4}
          placeholder={`${label}…`}
          style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.4 }}
        />
      ) : (
        <div style={{ fontSize: 13, color: value ? '#E2E8F0' : '#475569', whiteSpace: 'pre-wrap' }}>{value || '—'}</div>
      )}
    </div>
  )

  return (
    <div style={{ flex: isMobile ? 'none' : '1 1 0', background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0', flex: 1 }}>Debrief notes</div>
        {canEdit && dirty && (
          <button onClick={save} disabled={saving} style={btnSmall}>{saving ? 'Saving…' : 'Save'}</button>
        )}
      </div>

      {err && <div style={{ color: '#EF4444', fontSize: 12, marginBottom: 8 }}>{err}</div>}

      {section('Learnings', learnings, setLearnings)}
      {section('Next focus points', nextFocus, setNextFocus)}

      {/* Documents */}
      <div style={{ marginTop: 4 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Documents</div>
        {docs.length === 0 && <div style={{ fontSize: 12, color: '#475569', marginBottom: 6 }}>None yet.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
          {docs.map((d) => (
            <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#071624', borderRadius: 6, padding: '6px 9px' }}>
              <span style={{ fontSize: 13 }}>📄</span>
              {d.url ? (
                <a href={d.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#06B6D4', textDecoration: 'none', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</a>
              ) : (
                <span style={{ fontSize: 12, color: '#94A3B8', flex: 1 }}>{d.name}</span>
              )}
              {canEdit && (
                <button onClick={() => removeDoc(d.key)} style={{ background: 'none', border: 'none', color: '#EF4444', cursor: 'pointer', fontSize: 12 }}>✕</button>
              )}
            </div>
          ))}
        </div>
        {canEdit && (
          <label style={{ ...btnGhost, display: 'inline-block', cursor: uploading ? 'default' : 'pointer' }}>
            {uploading ? 'Uploading…' : '+ Upload document'}
            <input type="file" onChange={onPickFile} disabled={uploading} style={{ display: 'none' }} />
          </label>
        )}
      </div>
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
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const [addingDays, setAddingDays] = useState(false)

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

  async function addDays(e) {
    e.preventDefault()
    const dates = datesInRange(rangeStart, rangeEnd)
    if (dates.length === 0) return
    setAddingDays(true)
    setErr(null)
    try {
      for (const date of dates) {
        const res = await fetch(`${base}/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date }),
        })
        if (!res.ok) {
          setErr((await res.json().catch(() => ({}))).error || `could not add ${date}`)
          break
        }
      }
      setRangeStart('')
      setRangeEnd('')
      load()
    } finally {
      setAddingDays(false)
    }
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
        <form onSubmit={addDays} style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} style={inputStyle} title="From" />
          <span style={{ color: '#475569', fontSize: 12 }}>to</span>
          <input type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} style={inputStyle} title="To (optional — leave blank for a single day)" />
          <button type="submit" disabled={!rangeStart || addingDays} style={btnPrimary}>
            {addingDays ? 'Adding…' : '+ Add training days'}
          </button>
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

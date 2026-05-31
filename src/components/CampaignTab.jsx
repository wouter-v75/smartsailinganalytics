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

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { uploadBlobToStorage } from '../lib/bunny-storage-upload'

const BLOCK_META = {
  'technical-testing': { label: 'Technical testing', c: '#F59E0B', testing: true },
  'speed-testing':     { label: 'Speed testing',     c: '#06B6D4', testing: true },
  'race-training':     { label: 'Race training',     c: '#1D9E75', testing: false },
  'racing':            { label: 'Racing',            c: '#EF4444', testing: false },
  'shore':             { label: 'Shore',             c: '#9333EA', testing: false },
  'other':             { label: 'Other',             c: '#64748B', testing: false },
}
const BLOCK_ORDER = ['technical-testing', 'speed-testing', 'race-training', 'racing', 'shore', 'other']

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

export default function CampaignTab({ teamId, boatId, role, config, isMobile, onOpenVideo }) {
  // Consultants only get the Day sub-tab (no Plan / Backlog).
  const consultantOnly = role === 'consultant'
  const [sub, setSub] = useState(consultantOnly ? 'day' : 'plan')
  const effSub = consultantOnly ? 'day' : sub
  const canEditPlan = EDIT_ROLES.includes(role)
  // Clicking a backlog-item link in a debrief jumps to the Backlog sub-tab and
  // highlights that item.
  const [highlightItem, setHighlightItem] = useState(null)
  const onOpenItem = (id) => { if (!consultantOnly) { setSub('backlog'); setHighlightItem(id) } }
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
      {!consultantOnly && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
          {subTab('plan', 'Plan')}
          {subTab('backlog', 'Backlog')}
          {subTab('day', 'Day')}
        </div>
      )}

      {effSub === 'plan' && (
        <PlanView
          teamId={teamId}
          boatId={boatId}
          canEditPlan={canEditPlan}
          canEditDates={canEditDates}
          canSeeTesting={canSeeTesting}
          isMobile={isMobile}
        />
      )}
      {effSub === 'backlog' && (
        <BacklogView
          teamId={teamId}
          boatId={boatId}
          role={role}
          config={config}
          canEditPlan={canEditPlan}
          isMobile={isMobile}
          highlightId={highlightItem}
        />
      )}
      {effSub === 'day' && (
        <DayView
          teamId={teamId}
          boatId={boatId}
          role={role}
          canEditPlan={canEditPlan}
          isMobile={isMobile}
          onOpenVideo={onOpenVideo}
          onOpenItem={onOpenItem}
        />
      )}
    </div>
  )
}

// ── Backlog ──────────────────────────────────────────────────────────────────
const CAT_COLOR = { racing: '#1D9E75', technical: '#F59E0B', 'whole-team': '#8B5CF6' }
const KIND_LABEL = { action: 'Action', fmea: 'FMEA', task: 'Task', test: 'Test', training: 'Training', deliverable: 'Deliverable', milestone: 'Milestone' }
// Kinds offered when creating an item (existing action/deliverable/milestone stay valid for old rows).
const KIND_ADD_OPTIONS = [['task', 'Task'], ['test', 'Test'], ['training', 'Training'], ['fmea', 'FMEA']]
const VENUES = [['on-water', 'On the water'], ['dock', 'Dock'], ['shed', 'Shed']]
const VENUE_LABEL = { 'on-water': 'On the water', dock: 'Dock', shed: 'Shed' }
const PRIO_COLOR = { 1: '#EF4444', 2: '#F97316', 3: '#F59E0B', 4: '#64748B', 5: '#475569' }
const ANSWER_META = {
  unanswered: { label: 'Not tested', c: '#64748B' },
  partial: { label: 'Partial', c: '#F59E0B' },
  answered: { label: 'Answered', c: '#1D9E75' },
}
const WRITE_ROLES = ['admin', 'team_manager', 'coach', 'tl1', 'tl2']
const TAG_ROLES = ['admin', 'team_manager', 'coach', 'tl2', 'consultant'] // TL2 and up
// TL3 and above may EDIT plan / backlog / day / debrief / speed notes / weather.
const EDIT_ROLES = ['admin', 'team_manager', 'coach', 'tl3']
// TL2 and above may see the "what can we test now" picker.
const TESTNOW_ROLES = ['admin', 'team_manager', 'coach', 'tl3', 'tl2']
const WIND_STEPS = [0, 5, 10, 15, 20, 25, 30]
const SOD = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
// FMEA: RPN = S×O×D (1–1000). High severity is top priority regardless of RPN.
const fmeaRpn = (m) => (Number(m?.severity) || 0) * (Number(m?.occurrence) || 0) * (Number(m?.detection) || 0)
const rpnToPriority = (m) => {
  const sev = Number(m?.severity) || 0
  const rpn = fmeaRpn(m)
  if (sev >= 9 || rpn >= 200) return 1
  if (rpn >= 120) return 2
  if (rpn >= 60) return 3
  if (rpn >= 30) return 4
  return 5
}

function BacklogView({ teamId, boatId, role, config, canEditPlan, isMobile, highlightId }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [filterSub, setFilterSub] = useState('all') // 'all' | 'mine' | subteamId
  const [showDone, setShowDone] = useState(false)
  const [adding, setAdding] = useState(false)

  const [availableTags, setAvailableTags] = useState([])
  const [days, setDays] = useState([]) // [{id,date}] planned test days, for the planned-day picker
  const subteams = (config?.subteams || []).filter((s) => s.active !== false)
  const members = config?.members || []
  const meId = config?.meId || null
  const mySubteamIds = config?.mySubteamIds || []
  const canAdd = EDIT_ROLES.includes(role)
  const canTag = EDIT_ROLES.includes(role)
  const base = `/api/teams/${teamId}/boats/${boatId}/campaign`

  // Only TL3 and above may edit backlog items.
  const canEditItem = useCallback(() => canEditPlan, [canEditPlan])

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

  // When an item is highlighted (via a debrief link), make sure it's visible.
  useEffect(() => {
    if (highlightId) { setFilterSub('all'); setShowDone(true) }
  }, [highlightId])

  // Shared tag vocabulary (same list the video tagger uses, per team+boat).
  useEffect(() => {
    let cancelled = false
    fetch(`/api/teams/${teamId}/tag-list?boat_id=${boatId}`)
      .then((r) => (r.ok ? r.json() : { tags: [] }))
      .then((j) => { if (!cancelled) setAvailableTags(j.tags || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [teamId, boatId])

  // Planned test days for the planned-day picker (target_session_id).
  useEffect(() => {
    let cancelled = false
    fetch(`${base}/calendar`)
      .then((r) => (r.ok ? r.json() : { sessions: [] }))
      .then((j) => { if (!cancelled) setDays((j.sessions || []).map((s) => ({ id: s.id, date: s.date }))) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [base])

  async function addVocabTag(tag) {
    const t = String(tag).trim().toLowerCase()
    if (!t || availableTags.includes(t)) return
    const next = [...availableTags, t].sort()
    setAvailableTags(next)
    await fetch(`/api/teams/${teamId}/tag-list`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: next, boat_id: boatId }),
    }).catch(() => {})
  }

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
          ? <ItemForm subteams={subteams} mySubteamIds={mySubteamIds} members={members} days={days} meId={meId} canEditPlan={canEditPlan} submitLabel="Add item"
              onCancel={() => setAdding(false)}
              onSubmit={async (payload) => {
                const res = await fetch(`${base}/backlog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'could not add')
                setAdding(false); load()
              }} />
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
              canTag={canTag}
              availableTags={availableTags}
              onAddVocabTag={addVocabTag}
              members={members}
              days={days}
              meId={meId}
              subteams={subteams}
              mySubteamIds={mySubteamIds}
              highlight={it.id === highlightId}
              onPatch={(body) => patch(it.id, body)}
              onDelete={() => remove(it.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ItemCard({ item, editable, canSetPriority, canTag, availableTags = [], onAddVocabTag, members = [], days = [], meId, subteams = [], mySubteamIds = [], highlight, onPatch, onDelete }) {
  const cardRef = useRef(null)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (highlight && cardRef.current) {
      try { cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch { /* ignore */ }
    }
  }, [highlight])

  if (editing) {
    return (
      <div ref={cardRef} style={{ background: '#071018', border: '1px solid #06B6D4', borderRadius: 10, padding: 4 }}>
        <ItemForm
          initial={item}
          subteams={subteams}
          mySubteamIds={mySubteamIds}
          members={members}
          days={days}
          meId={meId}
          canEditPlan={canSetPriority}
          submitLabel="Save changes"
          onCancel={() => setEditing(false)}
          onSubmit={async (payload) => { await onPatch(payload); setEditing(false) }}
        />
      </div>
    )
  }
  const sub = item.subteams
  const catColor = sub ? CAT_COLOR[sub.category] || '#64748B' : '#334155'
  const ownerName = members.find((m) => m.id === item.owner_user_id)?.name || null
  const plannedDate = days.find((d) => d.id === item.target_session_id)?.date || null
  const isFmea = item.kind === 'fmea'
  const meta = item.meta || {}
  const rpn = isFmea ? fmeaRpn(meta) : 0
  const [pct, setPct] = useState(item.progress_pct ?? 0)
  useEffect(() => { setPct(item.progress_pct ?? 0) }, [item.progress_pct])
  const [showTagPicker, setShowTagPicker] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const tags = item.tags || []
  const addTag = (t) => {
    const v = String(t).trim().toLowerCase()
    if (!v || tags.includes(v)) { setTagInput(''); return }
    onPatch({ tags: [...tags, v] })
    onAddVocabTag?.(v)
    setTagInput('')
  }
  const removeTag = (t) => onPatch({ tags: tags.filter((x) => x !== t) })
  const suggestable = availableTags.filter((t) => !tags.includes(t))
  const windBand =
    item.wind_min_kt != null || item.wind_max_kt != null
      ? `${item.wind_min_kt ?? '0'}–${item.wind_max_kt ?? '∞'} kt`
      : null

  return (
    <div ref={cardRef} style={{ background: '#0A1929', border: `1px solid ${highlight ? '#06B6D4' : '#1E3A5A'}`, borderLeft: `4px solid ${catColor}`, borderRadius: 10, padding: 12, boxShadow: highlight ? '0 0 0 2px #06B6D455' : 'none', transition: 'box-shadow .3s' }}>
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
        {item.venue && <span style={{ fontSize: 9, color: '#94A3B8', border: '1px solid #334155', borderRadius: 4, padding: '1px 5px' }}>{VENUE_LABEL[item.venue]}</span>}
        {windBand && <span style={{ fontSize: 9, color: '#7DD3FC', fontFamily: 'monospace' }}>{windBand}</span>}
        {isFmea && (
          <span style={{ fontSize: 9, fontWeight: 800, color: PRIO_COLOR[rpnToPriority(meta)] || '#64748B', border: `1px solid ${(PRIO_COLOR[rpnToPriority(meta)] || '#334155')}66`, borderRadius: 4, padding: '1px 5px' }}>
            RPN {rpn || '—'}
          </span>
        )}
      </div>

      {item.body && <div style={{ fontSize: 12, color: '#94A3B8', marginTop: 6 }}>{item.body}</div>}

      {/* Tags */}
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
        {tags.map((t) => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#A78BFA', background: '#8B5CF620', border: '1px solid #8B5CF640', borderRadius: 4, padding: '1px 6px', fontFamily: 'monospace' }}>
            {t}
            {canTag && <button onClick={() => removeTag(t)} style={{ background: 'none', border: 'none', color: '#A78BFA', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 0 }}>×</button>}
          </span>
        ))}
        {tags.length === 0 && !canTag && <span style={{ fontSize: 10, color: '#334155' }}>no tags</span>}
        {canTag && (
          showTagPicker ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <input
                list={`tags-${item.id}`}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput) } }}
                placeholder="tag…"
                autoFocus
                style={{ ...inputStyle, padding: '2px 6px', fontSize: 11, width: 110 }}
              />
              <datalist id={`tags-${item.id}`}>
                {suggestable.map((t) => <option key={t} value={t} />)}
              </datalist>
              <button onClick={() => addTag(tagInput)} style={{ ...btnSmall, padding: '3px 8px', fontSize: 11 }}>Add</button>
              <button onClick={() => { setShowTagPicker(false); setTagInput('') }} style={{ background: 'none', border: 'none', color: '#64748B', cursor: 'pointer', fontSize: 11 }}>done</button>
            </span>
          ) : (
            <button onClick={() => setShowTagPicker(true)} style={{ fontSize: 10, color: '#64748B', background: 'none', border: '1px dashed #334155', borderRadius: 4, padding: '1px 7px', cursor: 'pointer' }}>+ tag</button>
          )
        )}
      </div>

      {/* Owner / planned day / due date */}
      {editable ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <select value={item.owner_user_id || ''} onChange={(e) => onPatch({ owner_user_id: e.target.value || null })} style={{ ...inputStyle, fontSize: 11, padding: '3px 6px' }} title="Owner">
            <option value="">Owner…</option>
            {meId && <option value={meId}>Me</option>}
            {members.filter((m) => m.id !== meId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select value={item.target_session_id || ''} onChange={(e) => onPatch({ target_session_id: e.target.value || null })} style={{ ...inputStyle, fontSize: 11, padding: '3px 6px' }} title="Planned test day">
            <option value="">Planned day…</option>
            {days.map((d) => <option key={d.id} value={d.id}>{fmtDay(d.date)}</option>)}
          </select>
          <span style={{ fontSize: 10, color: '#64748B' }}>due</span>
          <input type="date" value={item.due_date || ''} onChange={(e) => onPatch({ due_date: e.target.value || null })} style={{ ...inputStyle, fontSize: 11, padding: '3px 6px' }} title="Due date" />
          <select value={item.venue || ''} onChange={(e) => onPatch({ venue: e.target.value || null })} style={{ ...inputStyle, fontSize: 11, padding: '3px 6px' }} title="Venue">
            <option value="">Venue…</option>
            {VENUES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      ) : (
        (ownerName || plannedDate || item.due_date) && (
          <div style={{ fontSize: 11, color: '#64748B', marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {ownerName && <span>👤 {ownerName}</span>}
            {plannedDate && <span>🗓 {fmtDay(plannedDate)}</span>}
            {item.due_date && <span>⏰ due {item.due_date}</span>}
          </div>
        )
      )}

      {/* FMEA scoring */}
      {isFmea && (
        <FmeaBlock
          meta={meta}
          editable={editable}
          canSetPriority={canSetPriority}
          onApply={(newMeta, suggestedPriority) =>
            onPatch(suggestedPriority != null ? { meta: newMeta, priority: suggestedPriority } : { meta: newMeta })
          }
        />
      )}

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
          <button onClick={() => setEditing(true)} style={{ ...btnGhost, fontSize: 12, padding: '4px 12px' }}>Edit</button>
          <button onClick={onDelete} style={{ background: 'none', border: 'none', color: '#EF4444', cursor: 'pointer', fontSize: 12 }}>Delete</button>
        </div>
      )}
    </div>
  )
}

function FmeaBlock({ meta, editable, canSetPriority, onApply }) {
  const init = () => ({
    severity: meta.severity ?? '',
    occurrence: meta.occurrence ?? '',
    detection: meta.detection ?? '',
    failure_mode: meta.failure_mode ?? '',
    effect: meta.effect ?? '',
    cause: meta.cause ?? '',
    controls: meta.controls ?? '',
  })
  const [m, setM] = useState(init)
  const [dirty, setDirty] = useState(false)
  useEffect(() => { setM(init()); setDirty(false) }, [meta]) // re-sync after reload
  const set = (k, v) => { setM((p) => ({ ...p, [k]: v })); setDirty(true) }
  const rpn = fmeaRpn(m)
  const sugg = rpnToPriority(m)
  const complete = m.severity && m.occurrence && m.detection

  function apply() {
    const newMeta = {
      ...meta,
      severity: Number(m.severity) || null,
      occurrence: Number(m.occurrence) || null,
      detection: Number(m.detection) || null,
      failure_mode: m.failure_mode || null,
      effect: m.effect || null,
      cause: m.cause || null,
      controls: m.controls || null,
      rpn: complete ? rpn : null,
    }
    onApply(newMeta, canSetPriority && complete ? sugg : null)
    setDirty(false)
  }

  const sodColor = '#1E3A5A'
  if (!editable) {
    return (
      <div style={{ marginTop: 10, background: '#071624', borderRadius: 8, padding: 10, fontSize: 12, color: '#94A3B8' }}>
        <div style={{ display: 'flex', gap: 14, marginBottom: m.failure_mode || m.effect || m.cause || m.controls ? 6 : 0 }}>
          <span>S <b style={{ color: '#E2E8F0' }}>{m.severity || '–'}</b></span>
          <span>O <b style={{ color: '#E2E8F0' }}>{m.occurrence || '–'}</b></span>
          <span>D <b style={{ color: '#E2E8F0' }}>{m.detection || '–'}</b></span>
          <span>RPN <b style={{ color: PRIO_COLOR[sugg] }}>{rpn || '–'}</b></span>
        </div>
        {m.failure_mode && <div>Mode: {m.failure_mode}</div>}
        {m.effect && <div>Effect: {m.effect}</div>}
        {m.cause && <div>Cause: {m.cause}</div>}
        {m.controls && <div>Controls: {m.controls}</div>}
      </div>
    )
  }

  const sodSelect = (key, label) => (
    <label style={{ fontSize: 11, color: '#94A3B8', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {label}
      <select value={m[key]} onChange={(e) => set(key, e.target.value)} style={{ ...inputStyle, padding: '2px 4px', fontSize: 11, borderColor: sodColor }}>
        <option value="">–</option>
        {SOD.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  )

  return (
    <div style={{ marginTop: 10, background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#F59E0B', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>FMEA scoring</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        {sodSelect('severity', 'Severity')}
        {sodSelect('occurrence', 'Occurrence')}
        {sodSelect('detection', 'Detection')}
        <span style={{ fontSize: 12, color: '#94A3B8' }}>RPN <b style={{ color: PRIO_COLOR[sugg] }}>{rpn || '–'}</b></span>
        {complete && <span style={{ fontSize: 11, color: PRIO_COLOR[sugg], fontWeight: 700 }}>→ suggests P{sugg}{!canSetPriority ? ' (a lead sets priority)' : ''}</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input value={m.failure_mode} onChange={(e) => set('failure_mode', e.target.value)} placeholder="Failure mode — how it breaks" style={{ ...inputStyle, fontSize: 12 }} />
        <input value={m.effect} onChange={(e) => set('effect', e.target.value)} placeholder="Effect — consequence (drives Severity)" style={{ ...inputStyle, fontSize: 12 }} />
        <input value={m.cause} onChange={(e) => set('cause', e.target.value)} placeholder="Cause — why it happens (drives Occurrence)" style={{ ...inputStyle, fontSize: 12 }} />
        <input value={m.controls} onChange={(e) => set('controls', e.target.value)} placeholder="Current controls / detection (drives Detection)" style={{ ...inputStyle, fontSize: 12 }} />
      </div>
      {dirty && (
        <button onClick={apply} style={{ ...btnSmall, marginTop: 8 }}>
          Save FMEA{canSetPriority && complete ? ` → set P${sugg}` : ''}
        </button>
      )}
    </div>
  )
}

// Add / edit form for a backlog item. With `initial` it pre-fills and edits;
// without it, it creates. `onSubmit(payload)` does the request (POST or PATCH).
function ItemForm({ subteams, mySubteamIds, members = [], days = [], meId, canEditPlan, initial = null, submitLabel = 'Add item', onSubmit, onCancel }) {
  // Non-coach members can only file into their own sub-teams.
  const allowedSubteams = canEditPlan ? subteams : subteams.filter((s) => mySubteamIds.includes(s.id))
  const [title, setTitle] = useState(initial?.title || '')
  const [body, setBody] = useState(initial?.body || '')
  const [kind, setKind] = useState(initial?.kind || 'task')
  const [venue, setVenue] = useState(initial?.venue || '')
  const [completion, setCompletion] = useState(initial?.completion || 'binary')
  const [subteamId, setSubteamId] = useState(initial ? (initial.subteam_id || '') : (allowedSubteams[0]?.id || ''))
  const [priority, setPriority] = useState(initial?.priority != null ? String(initial.priority) : '')
  const [wmin, setWmin] = useState(initial?.wind_min_kt != null ? String(initial.wind_min_kt) : '')
  const [wmax, setWmax] = useState(initial?.wind_max_kt != null ? String(initial.wind_max_kt) : '')
  const [ownerId, setOwnerId] = useState(initial?.owner_user_id || '')
  const [plannedDayId, setPlannedDayId] = useState(initial?.target_session_id || '')
  const [dueDate, setDueDate] = useState(initial?.due_date || '')
  const [fmea, setFmea] = useState({
    severity: initial?.meta?.severity ?? '', occurrence: initial?.meta?.occurrence ?? '', detection: initial?.meta?.detection ?? '',
    failure_mode: initial?.meta?.failure_mode ?? '', effect: initial?.meta?.effect ?? '', cause: initial?.meta?.cause ?? '', controls: initial?.meta?.controls ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const fmeaRpnLive = fmeaRpn(fmea)
  const fmeaSugg = rpnToPriority(fmea)
  const fmeaComplete = fmea.severity && fmea.occurrence && fmea.detection
  // Keep the item's existing kind selectable even if it isn't a default option.
  const kindOptions = (() => {
    const opts = KIND_ADD_OPTIONS.slice()
    if (initial?.kind && !opts.some(([k]) => k === initial.kind)) opts.unshift([initial.kind, KIND_LABEL[initial.kind] || initial.kind])
    return opts
  })()

  async function submit() {
    if (!title.trim()) return
    setBusy(true); setErr(null)
    try {
      const isFmea = kind === 'fmea'
      const meta = isFmea
        ? {
            severity: Number(fmea.severity) || null,
            occurrence: Number(fmea.occurrence) || null,
            detection: Number(fmea.detection) || null,
            failure_mode: fmea.failure_mode || null,
            effect: fmea.effect || null,
            cause: fmea.cause || null,
            controls: fmea.controls || null,
            rpn: fmeaComplete ? fmeaRpnLive : null,
          }
        : null
      // FMEA auto-suggests priority (overrides the blank field); manual wins if set.
      const effPriority =
        priority !== '' ? Number(priority) : isFmea && fmeaComplete ? fmeaSugg : null
      await onSubmit({
        title: title.trim(), body: body || null, kind, completion,
        subteam_id: subteamId || null,
        venue: venue || null,
        priority: effPriority,
        owner_user_id: ownerId || null,
        target_session_id: plannedDayId || null,
        due_date: dueDate || null,
        wind_min_kt: wmin === '' ? null : Number(wmin),
        wind_max_kt: wmax === '' ? null : Number(wmax),
        meta,
      })
    } catch (e) {
      setErr(e?.message || 'could not save')
    } finally { setBusy(false) }
  }

  return (
    <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 10, padding: 12, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing / answering?" style={{ ...inputStyle, fontSize: 14 }} autoFocus />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Details (optional)…" rows={2} style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: 13 }} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={inputStyle} title="Type">
          {kindOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={venue} onChange={(e) => setVenue(e.target.value)} style={inputStyle} title="Venue">
          <option value="">Venue…</option>
          {VENUES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
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
        <select value={wmin} onChange={(e) => setWmin(e.target.value)} style={inputStyle} title="Testable wind min (kt)">
          <option value="">wind min</option>
          {WIND_STEPS.map((w) => <option key={w} value={w}>{w} kt</option>)}
        </select>
        <select value={wmax} onChange={(e) => setWmax(e.target.value)} style={inputStyle} title="Testable wind max (kt)">
          <option value="">wind max</option>
          {WIND_STEPS.map((w) => <option key={w} value={w}>{w} kt</option>)}
        </select>
        <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} style={inputStyle} title="Owner">
          <option value="">Owner…</option>
          {meId && <option value={meId}>Me</option>}
          {members.filter((m) => m.id !== meId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select value={plannedDayId} onChange={(e) => setPlannedDayId(e.target.value)} style={inputStyle} title="Planned test day">
          <option value="">Planned day…</option>
          {days.map((d) => <option key={d.id} value={d.id}>{fmtDay(d.date)}</option>)}
        </select>
        <span style={{ fontSize: 10, color: '#64748B' }}>due</span>
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={inputStyle} title="Due date" />
      </div>

      {kind === 'fmea' && (
        <div style={{ background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            {['severity', 'occurrence', 'detection'].map((k) => (
              <label key={k} style={{ fontSize: 11, color: '#94A3B8', display: 'inline-flex', alignItems: 'center', gap: 4, textTransform: 'capitalize' }}>
                {k}
                <select value={fmea[k]} onChange={(e) => setFmea((p) => ({ ...p, [k]: e.target.value }))} style={{ ...inputStyle, padding: '2px 4px', fontSize: 11 }}>
                  <option value="">–</option>
                  {SOD.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            ))}
            <span style={{ fontSize: 12, color: '#94A3B8' }}>RPN <b style={{ color: PRIO_COLOR[fmeaSugg] }}>{fmeaRpnLive || '–'}</b></span>
            {fmeaComplete && <span style={{ fontSize: 11, color: PRIO_COLOR[fmeaSugg], fontWeight: 700 }}>→ P{fmeaSugg}</span>}
          </div>
          <input value={fmea.failure_mode} onChange={(e) => setFmea((p) => ({ ...p, failure_mode: e.target.value }))} placeholder="Failure mode — how it breaks" style={{ ...inputStyle, fontSize: 12 }} />
          <input value={fmea.effect} onChange={(e) => setFmea((p) => ({ ...p, effect: e.target.value }))} placeholder="Effect — consequence (drives Severity)" style={{ ...inputStyle, fontSize: 12 }} />
          <input value={fmea.cause} onChange={(e) => setFmea((p) => ({ ...p, cause: e.target.value }))} placeholder="Cause — why it happens (drives Occurrence)" style={{ ...inputStyle, fontSize: 12 }} />
          <input value={fmea.controls} onChange={(e) => setFmea((p) => ({ ...p, controls: e.target.value }))} placeholder="Current controls / detection (drives Detection)" style={{ ...inputStyle, fontSize: 12 }} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={busy || !title.trim()} style={btnPrimary}>{busy ? 'Saving…' : submitLabel}</button>
        <button onClick={onCancel} style={btnGhost}>Cancel</button>
        {err && <span style={{ color: '#EF4444', fontSize: 12, alignSelf: 'center' }}>{err}</span>}
      </div>
    </div>
  )
}

// ── Day sub-tab ──────────────────────────────────────────────────────────────
const safeName = (n) => n.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)

function PlanItemRow({ item, highlight, selectable, checked, onToggle }) {
  const sub = item.subteams
  const catColor = sub ? CAT_COLOR[sub.category] || '#64748B' : '#334155'
  const wind = item.wind_min_kt != null || item.wind_max_kt != null
    ? `${item.wind_min_kt ?? '0'}–${item.wind_max_kt ?? '∞'}kt`
    : null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#071624', borderLeft: `3px solid ${highlight ? '#06B6D4' : catColor}`, borderRadius: 6, padding: '6px 9px', flexWrap: 'wrap' }}>
      {selectable && <input type="checkbox" checked={!!checked} onChange={() => onToggle?.(item.id)} style={{ margin: 0, cursor: 'pointer' }} />}
      <span style={{ fontSize: 11, fontWeight: 800, color: PRIO_COLOR[item.priority] || '#475569' }}>{item.priority ? `P${item.priority}` : 'P–'}</span>
      <span style={{ fontSize: 12, color: '#E2E8F0', flex: 1, minWidth: 100 }}>{item.title}</span>
      {sub && <span style={{ fontSize: 9, color: catColor }}>{sub.label}</span>}
      {item.venue && <span style={{ fontSize: 9, color: '#94A3B8' }}>{VENUE_LABEL[item.venue]}</span>}
      {wind && <span style={{ fontSize: 9, color: '#7DD3FC', fontFamily: 'monospace' }}>{wind}</span>}
    </div>
  )
}

function DayView({ teamId, boatId, role, canEditPlan, isMobile, onOpenVideo, onOpenItem }) {
  const [date, setDate] = useState(todayStr())
  const [session, setSession] = useState(null) // {id, objective, blocks} | null
  const [allDays, setAllDays] = useState([]) // [{id, date}]
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const canSeeTesting = ['admin', 'team_manager', 'coach', 'tl3', 'tl2', 'consultant'].includes(role)
  // TL3 and above edit notes, weather, plan/timings.
  const canEditDebrief = EDIT_ROLES.includes(role)
  const canSeeForecast = role !== 'guest'   // TL1+ (consultant within window via RLS)
  const canEditForecast = EDIT_ROLES.includes(role)
  const canSeeTestNow = TESTNOW_ROLES.includes(role)  // TL2+
  const canMoveTests = EDIT_ROLES.includes(role)      // TL3+
  const base = `/api/teams/${teamId}/boats/${boatId}/campaign`

  const loadCalendar = useCallback(async () => {
    try {
      const res = await fetch(`${base}/calendar`)
      if (!res.ok) return
      const j = await res.json()
      const list = j.sessions || []
      setAllDays(list.map((s) => ({ id: s.id, date: s.date })))
      setSession(list.find((s) => s.date === date) || null)
    } finally {
      setLoading(false)
    }
  }, [base, date])
  useEffect(() => { loadCalendar() }, [loadCalendar])

  const blocks = (session?.blocks || []).filter(
    (b) => canSeeTesting || !BLOCK_META[b.block_type]?.testing
  )

  // Backlog (for the on-the-water Tests & tasks card).
  const [items, setItems] = useState([])
  const reloadItems = useCallback(() => {
    fetch(`${base}/backlog`).then((r) => (r.ok ? r.json() : { items: [] })).then((j) => setItems(j.items || [])).catch(() => {})
  }, [base])
  useEffect(() => { reloadItems() }, [reloadItems])

  const allDates = allDays.map((d) => d.date)

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

      {/* Weather forecast (PDF only) — TL1+ view, TL3+ edit. */}
      {canSeeForecast && (
        <WeatherCard base={base} date={date} canEdit={canEditForecast} />
      )}

      {/* Row 1 — Plan | On-the-water Tests & tasks */}
      <div style={{ display: 'flex', gap: 14, flexDirection: isMobile ? 'column' : 'row', alignItems: 'stretch' }}>
        <div style={{ flex: isMobile ? 'none' : '1 1 0', background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0', marginBottom: 10 }}>Plan for {fmtDay(date)}</div>
          {loading ? (
            <div style={{ color: '#475569', fontSize: 13 }}>Loading…</div>
          ) : !session ? (
            <div style={{ color: '#475569', fontSize: 12 }}>
              No plan for this day yet.{canEditPlan ? ' Add the day + blocks in the Plan tab.' : ''}
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
                        {b.venue && <span style={{ fontSize: 10, color: '#94A3B8', border: '1px solid #334155', borderRadius: 4, padding: '0 5px' }}>{VENUE_LABEL[b.venue]}</span>}
                      </div>
                      {b.objective && <div style={{ fontSize: 11, color: '#64748B', marginTop: 3 }}>{b.objective}</div>}
                    </div>
                  )
                })
              )}
            </div>
          )}

          {/* PLAN + TIMINGS — TL3+ edit, all view (one fetch via PlanConditions) */}
          <PlanConditions base={base} date={date} canEdit={canEditPlan} />
        </div>

        <OnWaterCard
          base={base}
          items={items}
          allDays={allDays}
          sessionId={session?.id || null}
          canSeeTestNow={canSeeTestNow}
          canMoveTests={canMoveTests}
          isMobile={isMobile}
          onChanged={reloadItems}
        />
      </div>

      {/* Row 2 — Debrief notes | Speed team meeting notes */}
      <div style={{ display: 'flex', gap: 14, flexDirection: isMobile ? 'column' : 'row', alignItems: 'stretch', marginTop: 14 }}>
        <NotesCard
          title="Debrief notes"
          fields={[{ key: 'learnings', label: 'Learnings' }, { key: 'next_focus', label: 'Next focus points' }]}
          showDocuments
          wrapperStyle={{ flex: isMobile ? 'none' : '1 1 0' }}
          base={base} date={date} teamId={teamId} boatId={boatId} role={role}
          canEdit={canEditDebrief} isMobile={isMobile} onOpenVideo={onOpenVideo} onOpenItem={onOpenItem}
        />
        <NotesCard
          title="Speed team meeting notes"
          fields={[
            { key: 'speed_learnings', label: 'Learnings' },
            { key: 'speed_focus_today', label: 'Focus for today' },
            { key: 'speed_long_term', label: 'Long term development points' },
          ]}
          showDocuments={false}
          wrapperStyle={{ flex: isMobile ? 'none' : '1 1 0' }}
          base={base} date={date} teamId={teamId} boatId={boatId} role={role}
          canEdit={canEditDebrief} isMobile={isMobile} onOpenVideo={onOpenVideo} onOpenItem={onOpenItem}
        />
      </div>
    </div>
  )
}

// View-by-default block: shows full content (auto-expands), with an Edit
// button for editors. When empty + canEdit, shows a "+ Add {label}" affordance.
// When empty + !canEdit, renders nothing. Each save is field-scoped so the
// surrounding fetch state isn't disturbed.
function EditableTextBlock({ label, value, canEdit, placeholder, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value || '')
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (!editing) setDraft(value || '') }, [value, editing])

  const hasContent = !!(value && value.trim())
  if (!canEdit && !hasContent) return null

  async function commit() {
    setSaving(true)
    try {
      await onSave(draft)
      setEditing(false)
    } finally { setSaving(false) }
  }

  return (
    <div style={{ marginTop: 14, borderTop: '1px solid #1E3A5A', paddingTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6, gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, flex: 1 }}>{label}</span>
        {canEdit && !editing && hasContent && (
          <button onClick={() => setEditing(true)} style={btnGhost}>Edit</button>
        )}
        {canEdit && editing && (
          <>
            <button onClick={commit} disabled={saving} style={btnSmall}>{saving ? 'Saving…' : 'Save'}</button>
            <button onClick={() => { setDraft(value || ''); setEditing(false) }} style={btnGhost}>Cancel</button>
          </>
        )}
      </div>
      {editing ? (
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} placeholder={placeholder}
          autoFocus
          style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.4 }} />
      ) : hasContent ? (
        <div style={{ fontSize: 13, color: '#E2E8F0', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{value}</div>
      ) : (
        <button onClick={() => setEditing(true)} style={{ ...btnGhost, alignSelf: 'flex-start' }}>
          + Add {label.toLowerCase()}
        </button>
      )}
    </div>
  )
}

// PLAN + TIMINGS — single fetch, two view/edit blocks. TL3+ edit; everyone
// (TL1+ / consultant-in-window) views via the same RLS-gated GET.
function PlanConditions({ base, date, canEdit }) {
  const [plan, setPlan] = useState('')
  const [timings, setTimings] = useState('')
  const [loaded, setLoaded] = useState(false)
  const load = useCallback(async () => {
    const res = await fetch(`${base}/conditions?date=${date}`)
    if (!res.ok) { setLoaded(true); return }
    const j = await res.json()
    setPlan(j.plan || '')
    setTimings(j.timings || '')
    setLoaded(true)
  }, [base, date])
  useEffect(() => { setLoaded(false); load() }, [load])

  async function patch(field, val) {
    await fetch(`${base}/conditions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, [field]: val }),
    })
    if (field === 'plan') setPlan(val); else if (field === 'timings') setTimings(val)
  }

  if (!loaded) return null
  return (
    <>
      <EditableTextBlock
        label="Plan"
        value={plan}
        canEdit={canEdit}
        placeholder="Today's plan, intent, focus areas…"
        onSave={(v) => patch('plan', v)}
      />
      <EditableTextBlock
        label="Timings"
        value={timings}
        canEdit={canEdit}
        placeholder="Dock out, warning signal, first start…"
        onSave={(v) => patch('timings', v)}
      />
    </>
  )
}

// On-the-water Tests & tasks: SELECTED items for the day (TL1+) and the
// wind-range "what can we test now" picker (TL2+ view, TL3+ move-to-day).
function OnWaterCard({ base, items, allDays, sessionId, canSeeTestNow, canMoveTests, isMobile, onChanged }) {
  const [wmin, setWmin] = useState('')
  const [wmax, setWmax] = useState('')
  const [picked, setPicked] = useState(new Set())
  const [targetDay, setTargetDay] = useState(sessionId || '')
  const [moving, setMoving] = useState(false)
  useEffect(() => { setTargetDay(sessionId || '') }, [sessionId])

  const selected = sessionId ? items.filter((it) => it.target_session_id === sessionId) : []
  const lo = wmin === '' ? null : Number(wmin)
  const hi = wmax === '' ? null : Number(wmax)
  // Item testable if its wind band overlaps the entered range (open bounds = ∞).
  const overlaps = (it) => {
    if (lo == null && hi == null) return true
    if (hi != null && it.wind_min_kt != null && it.wind_min_kt > hi) return false
    if (lo != null && it.wind_max_kt != null && it.wind_max_kt < lo) return false
    return true
  }
  const candidates = items
    .filter((it) => it.status !== 'done' && it.status !== 'wontfix' && overlaps(it))
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .slice(0, 12)

  const toggle = (id) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  async function move() {
    if (!picked.size || !targetDay) return
    setMoving(true)
    try {
      for (const id of picked) {
        await fetch(`${base}/backlog/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_session_id: targetDay }) })
      }
      setPicked(new Set())
      onChanged()
    } finally { setMoving(false) }
  }

  return (
    <div style={{ flex: isMobile ? 'none' : '1 1 0', background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0', marginBottom: 10 }}>On the water — tests & tasks</div>

      {/* SELECTED (TL1+) */}
      <div style={{ fontSize: 11, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Selected</div>
      {selected.length === 0 ? (
        <div style={{ fontSize: 12, color: '#475569' }}>Nothing selected for this day yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {selected.map((it) => <PlanItemRow key={it.id} item={it} />)}
        </div>
      )}

      {/* WHAT CAN WE TEST NOW (TL2+) */}
      {canSeeTestNow && (
        <div style={{ marginTop: 14, borderTop: '1px solid #1E3A5A', paddingTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1 }}>What can we test now?</span>
            <span style={{ fontSize: 11, color: '#64748B' }}>wind</span>
            <input type="number" value={wmin} onChange={(e) => setWmin(e.target.value)} placeholder="min" style={{ ...inputStyle, width: 56, fontSize: 12 }} />
            <span style={{ fontSize: 11, color: '#64748B' }}>–</span>
            <input type="number" value={wmax} onChange={(e) => setWmax(e.target.value)} placeholder="max" style={{ ...inputStyle, width: 56, fontSize: 12 }} />
            <span style={{ fontSize: 11, color: '#64748B' }}>kt</span>
          </div>
          {candidates.length === 0 ? (
            <div style={{ fontSize: 12, color: '#475569' }}>Nothing testable in this wind range.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {candidates.map((it) => (
                <PlanItemRow key={it.id} item={it} highlight={lo != null || hi != null}
                  selectable={canMoveTests} checked={picked.has(it.id)} onToggle={toggle} />
              ))}
            </div>
          )}
          {canMoveTests && picked.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: '#94A3B8' }}>Move {picked.size} to</span>
              <select value={targetDay} onChange={(e) => setTargetDay(e.target.value)} style={{ ...inputStyle, fontSize: 12 }}>
                {sessionId && <option value={sessionId}>Today ({allDays.find((d) => d.id === sessionId) ? fmtDay(allDays.find((d) => d.id === sessionId).date) : 'this day'})</option>}
                {allDays.filter((d) => d.id !== sessionId).map((d) => <option key={d.id} value={d.id}>{fmtDay(d.date)}</option>)}
              </select>
              <button onClick={move} disabled={moving || !targetDay} style={btnSmall}>{moving ? 'Moving…' : 'Move'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function WeatherCard({ base, date, canEdit }) {
  const [docs, setDocs] = useState([])
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState(null)

  const load = useCallback(async () => {
    setErr(null)
    const res = await fetch(`${base}/attachments?date=${date}&kind=weather`)
    if (!res.ok) { setErr('could not load forecast'); return }
    const j = await res.json()
    setDocs(j.attachments || [])
  }, [base, date])
  useEffect(() => { load() }, [load])

  async function onPick(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setErr(null)
    try {
      const key = `campaign/weather/${date}/${Date.now()}-${safeName(file.name)}`
      await uploadBlobToStorage({ key, blob: file, contentType: file.type })
      const res = await fetch(`${base}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, kind: 'weather', name: file.name, key, bytes: file.size, content_type: file.type }),
      })
      if (!res.ok) { setErr((await res.json().catch(() => ({}))).error || 'could not register file'); return }
      load()
    } catch (e2) {
      setErr(e2?.message || 'upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function remove(id) {
    if (!confirm('Remove this forecast?')) return
    await fetch(`${base}/attachments`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    load()
  }

  return (
    <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: docs.length ? 10 : 0, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0' }}>🌦 Weather forecast</span>
        <div style={{ flex: 1 }} />
        {canEdit && (
          <label style={{ ...btnGhost, display: 'inline-block', cursor: uploading ? 'default' : 'pointer' }}>
            {uploading ? 'Uploading…' : '+ Upload forecast (PDF)'}
            <input type="file" accept="application/pdf,image/*" onChange={onPick} disabled={uploading} style={{ display: 'none' }} />
          </label>
        )}
      </div>

      {err && <div style={{ color: '#EF4444', fontSize: 12, marginBottom: 8 }}>{err}</div>}

      {docs.length === 0 ? (
        <div style={{ fontSize: 12, color: '#475569' }}>
          No forecast for this day.{canEdit ? ' Upload the weather/strategy deck as a PDF.' : ''}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {docs.map((d) => (
            <ForecastThumb key={d.id} doc={d} canEdit={canEdit} onRemove={() => remove(d.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

// Compact clickable thumbnail (~1/4 the old size). PDFs show their actual
// first page via a scaled, clipped, non-interactive iframe; click opens a new
// tab. No PDF library needed — the browser's built-in viewer renders the page.
const THUMB_W = 96
const THUMB_H = 60
function ForecastThumb({ doc, canEdit, onRemove }) {
  const isImg = /^image\//.test(doc.content_type || '') || /\.(png|jpe?g|gif|webp)$/i.test(doc.name || '')
  const isPdf = !isImg
  return (
    <div style={{ width: THUMB_W }}>
      <a href={doc.url || '#'} target="_blank" rel="noreferrer"
        title={`Open ${doc.name} in a new tab`}
        onClick={(e) => { if (!doc.url) e.preventDefault() }}
        style={{ display: 'block', textDecoration: 'none' }}>
        <div style={{ position: 'relative', width: THUMB_W, height: THUMB_H, borderRadius: 6, overflow: 'hidden', border: '1px solid #1E3A5A', background: '#fff', cursor: 'pointer' }}>
          {isImg && doc.url ? (
            <img src={doc.url} alt={doc.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : isPdf && doc.url ? (
            // 4× iframe scaled to 0.25 → renders the first page into the box.
            <iframe
              src={`${doc.url}#page=1&toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
              title={doc.name}
              scrolling="no"
              style={{ position: 'absolute', top: 0, left: 0, width: THUMB_W * 4, height: THUMB_H * 4, border: 'none', transform: 'scale(0.25)', transformOrigin: '0 0', pointerEvents: 'none', background: '#fff' }}
            />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(160deg,#f8fafc,#e2e8f0)' }}><span style={{ fontSize: 24 }}>📄</span></div>
          )}
          {isPdf && <span style={{ position: 'absolute', top: 3, right: 3, background: '#DC2626', color: '#fff', fontSize: 7, fontWeight: 800, borderRadius: 2, padding: '0 3px', letterSpacing: 0.5 }}>PDF</span>}
          <span style={{ position: 'absolute', bottom: 2, right: 3, background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 9, borderRadius: 3, padding: '0 3px' }}>↗</span>
        </div>
      </a>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 3 }}>
        <span title={doc.name} style={{ fontSize: 9, color: '#94A3B8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.name}</span>
        {canEdit && <button onClick={onRemove} title="Remove" style={{ background: 'none', border: 'none', color: '#EF4444', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 0 }}>✕</button>}
      </div>
    </div>
  )
}

const normTag = (t) => String(t).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')

// Local HH:MM from a UTC timestamp + the session's tz offset (minutes).
const localHM = (utc, tzMin) => {
  if (!utc) return ''
  const d = new Date(new Date(utc).getTime() + (tzMin || 0) * 60000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
// Tags worth showing on a clip's @-link label: race events (start/topmark/mark)
// + sail tags. Drops position/manoeuvre/auto tags (upwind, reach, downwind,
// tack, gybe, tws-…, Nx-…) and the mainsail tag.
const RACE_EVENT_LABEL = { 'race-start': 'start', topmark: 'topmark', mark: 'mark' }
const NOTE_NOISE_TAGS = new Set(['upwind', 'reach', 'reaching', 'downwind', 'tack', 'gybe', 'local', 'cloud', 'training', 'race', 'today'])
const NOTE_SAIL_SKIP = /^(main|msail|mainsail|main-)/
function noteClipTags(tags) {
  const arr = Array.isArray(tags) ? tags : []
  const events = []
  const sails = []
  for (const raw of arr) {
    const t = String(raw)
    if (RACE_EVENT_LABEL[t]) { events.push(RACE_EVENT_LABEL[t]); continue }
    if (NOTE_NOISE_TAGS.has(t)) continue
    if (NOTE_SAIL_SKIP.test(t)) continue
    if (t.startsWith('tws-')) continue
    if (/^\d+x-/.test(t)) continue
    sails.push(t)
  }
  return [...events, ...sails]
}

function renderTagsSegment(seg, base) {
  return seg.split(/(#[\w-]+)/g).map((p, i) =>
    /^#[\w-]+$/.test(p)
      ? <span key={base + 'h' + i} style={{ color: '#A78BFA', fontWeight: 600 }}>{p}</span>
      : <span key={base + 't' + i}>{p}</span>
  )
}

// Render read-only debrief text: colour #hashtags and turn [[clip:id|label]] /
// [[item:id|label]] tokens into clickable chips (onOpenRef handles the click).
function renderRich(text, onOpenRef) {
  if (!text) return '—'
  const linkRe = /\[\[(clip|item):([^|\]]+)\|([^\]]+)\]\]/g
  const out = []
  let last = 0
  let m
  let k = 0
  while ((m = linkRe.exec(text)) !== null) {
    if (m.index > last) out.push(...renderTagsSegment(text.slice(last, m.index), 's' + k++))
    const kind = m[1]
    const id = m[2]
    const label = m[3]
    out.push(
      <button key={'lnk' + k++} type="button" onClick={() => onOpenRef && onOpenRef(kind, id, label)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 12, border: '1px solid #06B6D455', background: '#06B6D415', color: '#7DD3FC', borderRadius: 5, padding: '0 6px', cursor: 'pointer', margin: '0 1px' }}>
        {kind === 'clip' ? '▶' : '◳'} {label}
      </button>
    )
    last = linkRe.lastIndex
  }
  if (last < text.length) out.push(...renderTagsSegment(text.slice(last), 's' + k++))
  return out
}

// Textarea with inline autocomplete: '#' → tag picker, '@' → link picker
// (clips / backlog items, only when allowLinks). Plus a click-to-insert palette.
function TagTextArea({ value, onChange, placeholder, availableTags = [], onAddTag, links = [], allowLinks = false, rows = 4 }) {
  const ref = useRef(null)
  const [menu, setMenu] = useState(null) // { mode:'tag'|'link', token, start, caret, items }
  const [active, setActive] = useState(0)

  function detect() {
    const el = ref.current
    if (!el) return
    const caret = el.selectionStart
    const before = el.value.slice(0, caret)
    const m = before.match(/(^|\s)([#@])([\w-]*)$/)
    if (!m) { setMenu(null); return }
    const trigger = m[2]
    const token = m[3]
    const start = caret - token.length - 1
    if (trigger === '#') {
      const items = availableTags.filter((t) => t.includes(token.toLowerCase())).slice(0, 8)
      setMenu({ mode: 'tag', token, start, caret, items })
    } else if (trigger === '@' && allowLinks) {
      const q = token.toLowerCase()
      const items = links.filter((l) => (l.label || '').toLowerCase().includes(q)).slice(0, 8)
      setMenu({ mode: 'link', token, start, caret, items })
    } else { setMenu(null); return }
    setActive(0)
  }

  function applyInsert(insertText, atCaret) {
    const el = ref.current
    if (!el) return
    const caret = el.selectionStart
    const useMenu = menu && !atCaret
    const start = useMenu ? menu.start : caret
    const end = useMenu ? menu.caret : caret
    const needSpace = start > 0 && !/\s/.test(value[start - 1] || '')
    const ins = (needSpace ? ' ' : '') + insertText
    const next = value.slice(0, start) + ins + value.slice(end)
    onChange(next)
    setMenu(null)
    requestAnimationFrame(() => {
      const pos = start + ins.length
      el.focus()
      try { el.setSelectionRange(pos, pos) } catch { /* ignore */ }
    })
  }

  function insertTag(raw, atCaret) {
    const t = normTag(raw)
    if (!t) { setMenu(null); return }
    onAddTag?.(t)
    applyInsert('#' + t + ' ', atCaret)
  }
  function insertLink(l) {
    const label = String(l.label || '').replace(/[|\]]/g, ' ').trim() || l.kind
    applyInsert(`[[${l.kind}:${l.id}|${label}]] `)
  }

  function chooseOption(idx) {
    if (!menu) return
    if (menu.mode === 'tag') {
      if (idx < menu.items.length) insertTag(menu.items[idx])
      else insertTag(menu.token)
    } else if (idx < menu.items.length) {
      insertLink(menu.items[idx])
    }
  }

  function onKeyDown(e) {
    if (!menu) return
    const showCreate = menu.mode === 'tag' && menu.token && !availableTags.includes(menu.token.toLowerCase())
    const total = menu.items.length + (showCreate ? 1 : 0)
    if (total === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % total) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + total) % total) }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseOption(active) }
    else if (e.key === 'Escape') { setMenu(null) }
  }

  const rowStyle = (on, kind) => ({ padding: '6px 10px', fontSize: 12, cursor: 'pointer', fontFamily: kind === 'tag' ? 'monospace' : 'inherit', color: on ? '#001018' : (kind === 'tag' ? '#A78BFA' : '#E2E8F0'), background: on ? '#06B6D4' : 'transparent' })
  const showCreate = menu && menu.mode === 'tag' && menu.token && !availableTags.includes(menu.token.toLowerCase())
  return (
    <div style={{ position: 'relative' }}>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyUp={detect}
        onClick={detect}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setMenu(null), 150)}
        rows={rows}
        placeholder={placeholder}
        style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.4 }}
      />
      {menu && (menu.items.length > 0 || showCreate) && (
        <div style={{ position: 'absolute', zIndex: 30, left: 0, right: 0, background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 8, marginTop: 2, maxHeight: 200, overflowY: 'auto', boxShadow: '0 6px 16px rgba(0,0,0,0.45)' }}>
          {menu.items.map((it, i) => (
            menu.mode === 'tag' ? (
              <div key={it} onMouseDown={(e) => { e.preventDefault(); insertTag(it) }} style={rowStyle(i === active, 'tag')}>#{it}</div>
            ) : (
              <div key={it.kind + it.id} onMouseDown={(e) => { e.preventDefault(); insertLink(it) }} style={rowStyle(i === active, 'link')}>
                <span style={{ fontSize: 9, marginRight: 6, fontWeight: 700, color: i === active ? '#001018' : (it.kind === 'clip' ? '#06B6D4' : '#A78BFA') }}>{it.kind === 'clip' ? '▶ CLIP' : '◳ ITEM'}</span>{it.label}
              </div>
            )
          ))}
          {showCreate && (
            <div onMouseDown={(e) => { e.preventDefault(); insertTag(menu.token) }}
              style={{ padding: '6px 10px', fontSize: 12, cursor: 'pointer', color: active >= menu.items.length ? '#001018' : '#7DD3FC', background: active >= menu.items.length ? '#06B6D4' : 'transparent', borderTop: menu.items.length ? '1px solid #1E3A5A' : 'none' }}>
              + Create #{normTag(menu.token)}
            </div>
          )}
        </div>
      )}
      <div style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>
        {allowLinks
          ? 'Type # to add tags, type @ to link to videos, photos or backlog items.'
          : 'Type # to add tags.'}
      </div>
    </div>
  )
}

// Generic notes card used for both Debrief notes and Speed-team-meeting notes.
// `fields` is [{key,label}]; all share one debrief row (one endpoint). Supports
// #tag + @link editing and (optionally) document uploads.
function NotesCard({ title, fields, showDocuments, wrapperStyle, base, date, teamId, boatId, role, canEdit, isMobile, onOpenVideo, onOpenItem }) {
  const [values, setValues] = useState({})
  const [docs, setDocs] = useState([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState(null)
  const [availableTags, setAvailableTags] = useState([])
  const [links, setLinks] = useState([])
  const photoUrlRef = useRef({})
  // Adding links is TL3-and-up; clicking works for any viewer.
  const allowLinks = EDIT_ROLES.includes(role)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/teams/${teamId}/tag-list?boat_id=${boatId}`)
      .then((r) => (r.ok ? r.json() : { tags: [] }))
      .then((j) => { if (!cancelled) setAvailableTags(j.tags || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [teamId, boatId])

  async function addVocabTag(tag) {
    const t = normTag(tag)
    if (!t || availableTags.includes(t)) return
    const next = [...availableTags, t].sort()
    setAvailableTags(next)
    fetch(`/api/teams/${teamId}/tag-list`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: next, boat_id: boatId }),
    }).catch(() => {})
  }

  // @-link candidates: this day's clips + photos + the boat's backlog items.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch(`/api/teams/${teamId}/boats/${boatId}/videos?date=${date}`).then((r) => (r.ok ? r.json() : { videos: [] })).catch(() => ({ videos: [] })),
      fetch(`/api/teams/${teamId}/boats/${boatId}/photos`).then((r) => (r.ok ? r.json() : { photos: [] })).catch(() => ({ photos: [] })),
      fetch(`${base}/backlog`).then((r) => (r.ok ? r.json() : { items: [] })).catch(() => ({ items: [] })),
      fetch(`${base}/calendar`).then((r) => (r.ok ? r.json() : { sessions: [] })).catch(() => ({ sessions: [] })),
    ]).then(([v, p, b, cal]) => {
      if (cancelled) return
      const sess = (cal.sessions || []).find((s) => s.date === date)
      const tzMin = sess?.tz_offset_minutes ?? 0
      // Clip label = local start time + meaningful tags (no filename).
      const clips = (v.videos || []).map((c) => {
        const hm = localHM(c.start_utc, tzMin)
        const tags = noteClipTags(c.tags)
        const label = [hm, ...tags].filter(Boolean).join(' ') || 'clip'
        return { kind: 'clip', id: c.id, label }
      })
      const dayPhotos = (p.photos || []).filter((ph) => (ph.sessions?.date || ph.date) === date)
      const urlMap = {}
      const photos = dayPhotos.map((ph, i) => {
        urlMap[ph.id] = ph.thumbnail_url || ph.url || null
        const hm = localHM(ph.taken_utc, tzMin)
        return { kind: 'photo', id: ph.id, label: `photo ${hm || i + 1}` }
      })
      photoUrlRef.current = urlMap
      const items = (b.items || []).map((it) => ({ kind: 'item', id: it.id, label: it.title }))
      setLinks([...clips, ...photos, ...items])
    })
    return () => { cancelled = true }
  }, [teamId, boatId, date, base])

  const onOpenRef = (kind, id) => {
    if (kind === 'clip') onOpenVideo && onOpenVideo(date, id)
    else if (kind === 'item') onOpenItem && onOpenItem(id)
    else if (kind === 'photo') { const u = photoUrlRef.current[id]; if (u) window.open(u, '_blank') }
  }

  const load = useCallback(async () => {
    setErr(null)
    const res = await fetch(`${base}/debrief?date=${date}`)
    if (!res.ok) { setErr('could not load notes'); return }
    const j = await res.json()
    const d = j.debrief || {}
    const vals = {}
    for (const f of fields) vals[f.key] = d[f.key] || ''
    setValues(vals)
    if (showDocuments) setDocs(d.documents || [])
    setDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, date])

  useEffect(() => { load() }, [load])

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      const payload = { date }
      for (const f of fields) payload[f.key] = values[f.key] ?? ''
      const res = await fetch(`${base}/debrief`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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

  const setField = (key, v) => { setValues((prev) => ({ ...prev, [key]: v })); setDirty(true) }

  return (
    <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14, ...(wrapperStyle || {}) }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0', flex: 1 }}>{title}</div>
        {canEdit && dirty && (
          <button onClick={save} disabled={saving} style={btnSmall}>{saving ? 'Saving…' : 'Save'}</button>
        )}
      </div>

      {err && <div style={{ color: '#EF4444', fontSize: 12, marginBottom: 8 }}>{err}</div>}

      {fields.map((f) => (
        <div key={f.key} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 5 }}>{f.label}</div>
          {canEdit ? (
            <TagTextArea
              value={values[f.key] || ''}
              onChange={(v) => setField(f.key, v)}
              placeholder={`${f.label}…`}
              availableTags={availableTags}
              onAddTag={addVocabTag}
              links={links}
              allowLinks={allowLinks}
              rows={4}
            />
          ) : (
            <div style={{ fontSize: 13, color: values[f.key] ? '#E2E8F0' : '#475569', whiteSpace: 'pre-wrap' }}>{renderRich(values[f.key], onOpenRef)}</div>
          )}
        </div>
      ))}

      {showDocuments && (
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
      {block.venue && <span style={{ fontSize: 10, color: '#94A3B8', border: '1px solid #334155', borderRadius: 4, padding: '0 5px' }}>{VENUE_LABEL[block.venue]}</span>}
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
  const [venue, setVenue] = useState('')
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
          venue: venue || null,
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
      <select value={venue} onChange={(e) => setVenue(e.target.value)} style={inputStyle} title="Venue">
        <option value="">Venue…</option>
        {VENUES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
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

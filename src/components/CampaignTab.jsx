// Campaign tab — the team's operating system for the work-up.
//
// Sub-tabs: Plan (global calendar, built here) · Backlog · Day.
// Available to every team. Per-team isolation is enforced by RLS on all
// campaign tables (team_id + boat_id scoping). Teams that haven't seeded
// sub-teams just see an empty list in the Backlog filter chips.
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
import { generateThumbnail } from '../lib/photoStore'
import { RichText, FormatHint } from './RichText'
import AudioBrief from './AudioBrief'

const BLOCK_META = {
  'technical-testing': { label: 'Technical testing', c: '#F59E0B', testing: true },
  'speed-testing':     { label: 'Speed testing',     c: '#06B6D4', testing: true },
  'race-training':     { label: 'Race training',     c: '#1D9E75', testing: false },
  'racing':            { label: 'Racing',            c: '#EF4444', testing: false },
  'shore':             { label: 'Shore',             c: '#9333EA', testing: false },
  'other':             { label: 'Other',             c: '#64748B', testing: false },
}
const BLOCK_ORDER = ['technical-testing', 'speed-testing', 'race-training', 'racing', 'shore', 'other']
// Block types a Training block can be made of (everything except `racing`,
// which is what defines a Regatta). Order = the order chips are shown in.
const TRAINING_BLOCK_TYPES = ['race-training', 'speed-testing', 'technical-testing', 'shore', 'other']

const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}
const fmtDay = (iso) => {
  // Parse as local date (avoid TZ shift from Date('YYYY-MM-DD') = UTC midnight).
  // Force en-GB so the label is always day-first (European), never US MM/DD,
  // regardless of the viewer's browser locale.
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString('en-GB', {
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

// ── Date-range safety ──────────────────────────────────────────────────────
// Native <input type="date"> yields ISO (YYYY-MM-DD) values, so ordering is
// unambiguous. But a fat-fingered / far-future "to" date used to silently
// create ~120 days (June + 120 ≈ late October) and fire hundreds of sequential
// writes → the "saving hangs" bug. We now reject invalid / reversed / oversized
// ranges up front and hard-cap the generated list.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_RANGE_DAYS = 45 // a training block or regatta never spans > ~6 weeks
const isValidIso = (s) => typeof s === 'string' && ISO_DATE_RE.test(s) && Number(s.slice(0, 4)) >= 2000
// Returns a human error string if the range can't be saved, else null.
const rangeError = (aIso, bIso) => {
  if (!isValidIso(aIso)) return 'pick a valid start date'
  const end = bIso || aIso
  if (bIso && !isValidIso(bIso)) return 'pick a valid end date'
  if (end < aIso) return 'the end date is before the start date'
  if (daysBetween(aIso, end) + 1 > MAX_RANGE_DAYS) return `that range is too long (max ${MAX_RANGE_DAYS} days)`
  return null
}
const datesInRange = (aIso, bIso) => {
  if (!isValidIso(aIso)) return []
  const end = bIso && isValidIso(bIso) && bIso >= aIso ? bIso : aIso
  const out = []
  const [y, m, d] = aIso.split('-').map(Number)
  let cur = new Date(y, m - 1, d)
  const [ey, em, ed] = end.split('-').map(Number)
  const stop = new Date(ey, em - 1, ed)
  let guard = 0
  while (cur <= stop && guard < MAX_RANGE_DAYS) {
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
  // Plan + Backlog pruned (non-compounding planning/task surfaces). The tab now
  // exposes only the data spine: Regattas (event reference) + Day (runs/configs/
  // debriefs). Default to Day.
  const consultantOnly = role === 'consultant'
  const [sub, setSub] = useState('day')
  const effSub = consultantOnly ? 'day' : sub
  const canEditPlan = EDIT_ROLES.includes(role)
  // Cross-boat editors (admin + team_manager) manage the team as a whole —
  // they should be able to edit any boat's Plan + Regattas from any one
  // workspace, without switching membership. Coach / tl3 stay scoped to
  // their active boat (the URL boatId).
  const crossBoatEdit = role === 'admin' || role === 'team_manager'
  // Clicking a backlog-item link in a debrief jumps to the Backlog sub-tab and
  // highlights that item.
  const [highlightItem, setHighlightItem] = useState(null)
  const onOpenItem = () => { /* backlog pruned — debrief→item links are no-ops */ }
  // Clicking "Day details" on a Plan DayCard jumps to the Day sub-tab on that
  // date. DayView consumes pendingDayDate via initialDate (one-shot consume).
  const [pendingDayDate, setPendingDayDate] = useState(null)
  const onOpenDay = (date) => { setSub('day'); setPendingDayDate(date) }
  const canEditDates = ['admin', 'team_manager'].includes(role)
  const canSeeTesting = ['admin', 'team_manager', 'coach', 'tl2', 'consultant'].includes(role)

  // Campaign belongs to the TEAM, which may run more than one boat at once
  // (e.g. an old hull + new hull during a transition). The Plan calendar
  // always shows the whole team; Day and Backlog can be scoped to one boat
  // or to "both / all" boats via the selector here.
  const [boats, setBoats] = useState([])
  // 'specific' boat ids OR the literal string 'all'. Defaults to the
  // membership-active boatId so existing flows continue to work unchanged.
  const [boatScope, setBoatScope] = useState(boatId)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/teams/${teamId}/boats`)
      .then((r) => (r.ok ? r.json() : { boats: [] }))
      .then((j) => { if (!cancelled) setBoats(j.boats || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [teamId])

  // If the active boatId isn't in the list (timing) keep showing the original.
  const scopeAll = boatScope === 'all'
  const activeBoatName = boats.find((b) => b.id === boatScope)?.name || null
  const multipleBoats = boats.length > 1

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
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {subTab('regattas', 'Regattas')}
          {subTab('day', 'Day')}
          <div style={{ flex: 1 }} />
          {/* Boat selector — visible whenever the user can see >1 boat on the
              team. The Plan is team-wide regardless of selection; Day and
              Backlog narrow to one boat OR show both. */}
          {multipleBoats ? (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#94A3B8' }}>
              <span>Boat</span>
              <select
                value={boatScope}
                onChange={(e) => setBoatScope(e.target.value)}
                style={{ ...inputStyle, fontSize: 12, padding: '4px 8px' }}
              >
                {boats.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                <option value="all">Both boats</option>
              </select>
            </label>
          ) : activeBoatName ? (
            <span style={{ fontSize: 12, color: '#94A3B8' }}>
              Boat: <span style={{ color: '#E2E8F0', fontWeight: 700 }}>{activeBoatName}</span>
            </span>
          ) : null}
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
          boats={boats}
          boatScope={boatScope}
          scopeAll={scopeAll}
          crossBoatEdit={crossBoatEdit}
          onOpenDay={onOpenDay}
        />
      )}
      {effSub === 'regattas' && (
        <RegattasView
          teamId={teamId}
          boatId={boatId}
          canEditPlan={canEditPlan}
          isMobile={isMobile}
          boats={boats}
          crossBoatEdit={crossBoatEdit}
          onOpenDay={onOpenDay}
        />
      )}
      {effSub === 'day' && (
        <DayView
          teamId={teamId}
          boatId={scopeAll ? boatId : boatScope}
          role={role}
          config={config}
          canEditPlan={canEditPlan}
          isMobile={isMobile}
          onOpenVideo={onOpenVideo}
          onOpenItem={onOpenItem}
          scopeAll={scopeAll}
          activeBoatName={activeBoatName}
          initialDate={pendingDayDate}
          onConsumeInitialDate={() => setPendingDayDate(null)}
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
// "Location" in the UI — the DB column is still called `venue` for stability.
// Where the work happens; office covers desk / planning / writeup days.
const VENUES = [['on-water', 'On the water'], ['dock', 'Dock'], ['shed', 'Shed'], ['office', 'Office']]
const VENUE_LABEL = { 'on-water': 'On the water', dock: 'Dock', shed: 'Shed', office: 'Office' }
const PRIO_COLOR = { 1: '#EF4444', 2: '#F97316', 3: '#F59E0B', 4: '#64748B', 5: '#475569' }
const ANSWER_META = {
  unanswered: { label: 'Not tested', c: '#64748B' },
  partial: { label: 'Partial', c: '#F59E0B' },
  answered: { label: 'Answered', c: '#1D9E75' },
}
const WRITE_ROLES = ['admin', 'team_manager', 'coach', 'tl3', 'tl1', 'tl2']
const TAG_ROLES = ['admin', 'team_manager', 'coach', 'tl3', 'tl2', 'consultant'] // TL2 and up
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

function DayView({ teamId, boatId, role, config, canEditPlan, isMobile, onOpenVideo, onOpenItem, scopeAll, activeBoatName, initialDate, onConsumeInitialDate }) {
  const [date, setDate] = useState(initialDate || todayStr())
  // A non-null `initialDate` from the parent means "jump to this date".
  // Consume it once so subsequent in-tab navigations aren't overridden.
  useEffect(() => {
    if (initialDate) {
      setDate(initialDate)
      onConsumeInitialDate && onConsumeInitialDate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDate])
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

  const allDates = allDays.map((d) => d.date)

  return (
    <div>
      {/* Date selector */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
        {allDates.length > 0 && (
          <select value={allDates.includes(date) ? date : ''} onChange={(e) => e.target.value && setDate(e.target.value)} style={inputStyle}>
            <option value="">Select day…</option>
            {allDates.map((d) => {
              const isToday = d === todayStr()
              // Days that have data are bold; today is marked with a dot.
              return (
                <option key={d} value={d} style={{ fontWeight: 700 }}>
                  {isToday ? `● ${fmtDay(d)} · today` : fmtDay(d)}
                </option>
              )
            })}
          </select>
        )}
        {date === todayStr() && <span style={{ fontSize: 11, color: '#1D9E75', fontWeight: 700 }}>● Today</span>}
        {activeBoatName && !scopeAll && (
          <span style={{ fontSize: 11, color: '#7DD3FC', background: '#0F2A45', borderRadius: 4, padding: '3px 8px', fontWeight: 700, marginLeft: 'auto' }}>
            {activeBoatName}
          </span>
        )}
      </div>

      {scopeAll && (
        <div style={{ fontSize: 12, color: '#7DD3FC', background: '#0F2A45', border: '1px solid #1E3A5A', borderRadius: 8, padding: '10px 12px', marginBottom: 14 }}>
          The Day view edits one boat at a time. Pick a specific boat above to see its plan, debrief notes and weather.
        </div>
      )}

      {err && <div style={{ color: '#EF4444', fontSize: 13, marginBottom: 10 }}>{err}</div>}

      {/* Weather forecast (PDF only) — TL1+ view, TL3+ edit. */}
      {canSeeForecast && (
        <WeatherCard base={base} date={date} canEdit={canEditForecast} />
      )}

      {/* Row 1 — Plan | Boat config (sail list for the day) */}
      <div style={{ display: 'flex', gap: 14, flexDirection: isMobile ? 'column' : 'row', alignItems: 'stretch' }}>
        <div style={{ flex: isMobile ? 'none' : '1 1 0', background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0', marginBottom: 10 }}>Goals &amp; planning for {fmtDay(date)}</div>
          {loading ? (
            <div style={{ color: '#64748B', fontSize: 13 }}>Loading…</div>
          ) : !session ? (
            <div style={{ color: '#64748B', fontSize: 12 }}>
              No plan for this day yet.{canEditPlan ? ' Add the day + blocks in the Plan tab.' : ''}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {session.objective && (
                <div style={{ fontSize: 12, color: '#94A3B8', borderLeft: '2px solid #06B6D4', paddingLeft: 8 }}>{session.objective}</div>
              )}
              {blocks.length === 0 ? (
                <div style={{ fontSize: 12, color: '#64748B' }}>No blocks{canSeeTesting ? '' : ' visible'} for this day.</div>
              ) : (
                blocks.map((b) => {
                  const meta = BLOCK_META[b.block_type] || BLOCK_META.other
                  const time = b.start_min != null ? `${minToHHMM(b.start_min)}${b.end_min != null ? '–' + minToHHMM(b.end_min) : ''}` : ''
                  return (
                    <div key={b.id} style={{ background: '#071624', borderLeft: `3px solid ${meta.c}`, borderRadius: 6, padding: '8px 10px' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: meta.c }}>{meta.label}</span>
                        {b.label && <span style={{ fontSize: 12, color: '#E2E8F0' }}>· {b.label}</span>}
                        {time && <span style={{ fontSize: 11, color: '#64748B', fontFamily: 'monospace' }}>{time}</span>}
                        {b.venue && <span style={{ fontSize: 10, color: '#94A3B8', border: '1px solid #334155', borderRadius: 4, padding: '0 5px' }}>{VENUE_LABEL[b.venue]}</span>}
                      </div>
                      {b.objective && <div style={{ fontSize: 11, color: '#8A97A9', marginTop: 3 }}>{b.objective}</div>}
                    </div>
                  )
                })
              )}
            </div>
          )}

          {/* PLAN + TIMINGS — TL3+ edit, all view (one fetch via PlanConditions) */}
          <PlanConditions base={base} date={date} canEdit={canEditPlan} isMobile={isMobile} teamId={teamId} boatId={boatId} />
        </div>

        <BoatConfigDayCard
          teamId={teamId}
          boatId={boatId}
          base={base}
          date={date}
          canEdit={canEditDebrief}
          isMobile={isMobile}
        />
      </div>

      {/* Row 2 — Speed team meeting notes | Debrief notes */}
      <div style={{ display: 'flex', gap: 14, flexDirection: isMobile ? 'column' : 'row', alignItems: 'stretch', marginTop: 14 }}>
        <NotesCard
          title="Speed team meeting notes"
          aiMode="speedteam"
          fields={[{ key: 'speed_learnings', label: 'Notes' }]}
          showDocuments
          documentsScope="speed"
          wrapperStyle={{ flex: isMobile ? 'none' : '1 1 0' }}
          base={base} date={date} teamId={teamId} boatId={boatId} role={role}
          canEdit={canEditDebrief} isMobile={isMobile} onOpenVideo={onOpenVideo} onOpenItem={onOpenItem}
        />
        <NotesCard
          title="Debrief notes"
          aiMode="debrief"
          fields={[{ key: 'learnings', label: 'Notes' }]}
          showDocuments
          documentsScope="debrief"
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
function EditableTextBlock({ label, value, canEdit, placeholder, onSave, accent = false }) {
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
        <>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} placeholder={placeholder}
            autoFocus
            style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.4 }} />
          <FormatHint />
        </>
      ) : hasContent ? (
        accent ? (
          <div style={{ borderLeft: '2px solid #06B6D4', paddingLeft: 8 }}>
            <RichText text={value} style={{ fontSize: 13, color: '#E2E8F0' }} />
          </div>
        ) : (
          <RichText text={value} style={{ fontSize: 13, color: '#E2E8F0' }} />
        )
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
function PlanConditions({ base, date, canEdit, isMobile, teamId, boatId }) {
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
      <AudioBrief
        mode="planning"
        teamId={teamId} boatId={boatId}
        fields={[{ key: 'timings', label: 'Timings' }, { key: 'plan', label: 'Plan' }]}
        canEdit={canEdit}
        isMobile={isMobile}
        onSaved={async (vals) => {
          if (vals.timings != null) await patch('timings', vals.timings)
          if (vals.plan != null) await patch('plan', vals.plan)
        }}
      />
      <EditableTextBlock
        label="Timings"
        value={timings}
        canEdit={canEdit}
        placeholder="Dock out, warning signal, first start…"
        onSave={(v) => patch('timings', v)}
      />
      <EditableTextBlock
        label="Plan"
        value={plan}
        canEdit={canEdit}
        placeholder="Today's plan, intent, focus areas…"
        onSave={(v) => patch('plan', v)}
      />
    </>
  )
}

// Boat config for the day — the sail list that was up. Entered manually at the
// start of the day (picked from the boat's sail inventory, or typed); once the
// day's actual boat config (event file) is uploaded it overwrites this with
// source='uploaded'. Stored in sessions.conditions.sail_list via /conditions.
function BoatConfigDayCard({ teamId, boatId, base, date, canEdit, isMobile }) {
  const [inventory, setInventory] = useState([])      // active sails [{id, name, category}]
  const [sails, setSails] = useState([])              // [{id?, name}] for the day
  const [source, setSource] = useState(null)          // 'manual' | 'uploaded' | null
  const [updatedAt, setUpdatedAt] = useState(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState([])              // working copy while editing
  const [custom, setCustom] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Inventory (once per boat).
  useEffect(() => {
    let live = true
    fetch(`/api/teams/${teamId}/sails?boat_id=${boatId}`)
      .then((r) => (r.ok ? r.json() : { sails: [] }))
      .then((j) => { if (live) setInventory((j.sails || []).filter((s) => !s.retired)) })
      .catch(() => {})
    return () => { live = false }
  }, [teamId, boatId])

  // The day's stored sail list.
  const load = useCallback(() => {
    setLoading(true); setEditing(false)
    fetch(`${base}/conditions?date=${date}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => {
        const sl = j.sailList || null
        setSails(Array.isArray(sl?.sails) ? sl.sails : [])
        setSource(sl?.source || null)
        setUpdatedAt(sl?.updated_at || null)
      })
      .catch(() => { setSails([]); setSource(null); setUpdatedAt(null) })
      .finally(() => setLoading(false))
  }, [base, date])
  useEffect(() => { load() }, [load])

  const label = (s) => (s.category ? `${s.category} · ${s.name}` : s.name)
  const inDraft = (s) => draft.some((d) => (d.id && d.id === s.id) || (!d.id && d.name === s.name))
  const toggleInv = (s) =>
    setDraft((d) => inDraft(s) ? d.filter((x) => !((x.id && x.id === s.id) || (!x.id && x.name === s.name)))
                              : [...d, { id: s.id, name: s.name }])
  const addCustom = () => {
    const n = custom.trim()
    if (!n || draft.some((d) => d.name.toLowerCase() === n.toLowerCase())) { setCustom(''); return }
    setDraft((d) => [...d, { name: n }]); setCustom('')
  }
  const removeDraft = (i) => setDraft((d) => d.filter((_, k) => k !== i))
  const startEdit = () => { setDraft(sails.map((s) => ({ ...s }))); setCustom(''); setEditing(true) }

  const save = async () => {
    setSaving(true)
    try {
      await fetch(`${base}/conditions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, sailList: { source: 'manual', sails: draft } }),
      })
      load()
    } finally { setSaving(false) }
  }

  const chip = (text, key, onRemove) => (
    <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#E2E8F0',
      background: '#071624', border: '1px solid #1E3A5A', borderRadius: 6, padding: '4px 8px' }}>
      {text}
      {onRemove && <button onClick={onRemove} style={{ background: 'none', border: 'none', color: '#8A97A9', cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>}
    </span>
  )

  return (
    <div style={{ flex: isMobile ? 'none' : '1 1 0', background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0' }}>Boat config — sails for {fmtDay(date)}</span>
        {source === 'uploaded' && (
          <span style={{ fontSize: 10, fontWeight: 700, color: '#1D9E75', background: '#0F2A45', borderRadius: 4, padding: '2px 6px' }}>uploaded</span>
        )}
        {source === 'manual' && (
          <span style={{ fontSize: 10, fontWeight: 700, color: '#7DD3FC', background: '#0F2A45', borderRadius: 4, padding: '2px 6px' }}>manual</span>
        )}
        {canEdit && !editing && (
          <button onClick={startEdit} style={{ marginLeft: 'auto', ...btnGhostSmall }}>
            {sails.length ? 'Edit' : '+ Add sails'}
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ color: '#64748B', fontSize: 13 }}>Loading…</div>
      ) : editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {inventory.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: '#8A97A9', marginBottom: 6 }}>From inventory — tap to add/remove</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {inventory.map((s) => {
                  const on = inDraft(s)
                  return (
                    <button key={s.id} onClick={() => toggleInv(s)} style={{
                      fontSize: 12, cursor: 'pointer', borderRadius: 6, padding: '4px 8px',
                      border: `1px solid ${on ? '#06B6D4' : '#1E3A5A'}`,
                      background: on ? '#06B6D4' : '#071624', color: on ? '#001018' : '#94A3B8', fontWeight: on ? 700 : 500,
                    }}>{on ? '✓ ' : ''}{label(s)}</button>
                  )
                })}
              </div>
            </div>
          )}
          <div>
            <div style={{ fontSize: 11, color: '#8A97A9', marginBottom: 6 }}>Selected for {fmtDay(date)}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minHeight: 24 }}>
              {draft.length === 0
                ? <span style={{ fontSize: 12, color: '#64748B' }}>None yet.</span>
                : draft.map((d, i) => chip(d.name, d.id || `c${i}`, () => removeDraft(i)))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={custom} onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom() } }}
              placeholder="Add sail not in inventory…" style={{ ...inputStyle, flex: '1 1 160px', minWidth: 140 }} />
            <button onClick={addCustom} disabled={!custom.trim()} style={{ ...btnGhostSmall, opacity: custom.trim() ? 1 : 0.5 }}>Add</button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save sail list'}</button>
            <button onClick={() => setEditing(false)} disabled={saving} style={btnGhostSmall}>Cancel</button>
          </div>
        </div>
      ) : sails.length === 0 ? (
        <div style={{ fontSize: 12, color: '#64748B' }}>
          No sail list for this day yet.{canEdit ? ' Add it manually, or it will fill in when the day’s boat config is uploaded.' : ''}
        </div>
      ) : (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {sails.map((s, i) => chip(s.name, s.id || `s${i}`))}
          </div>
          {updatedAt && (
            <div style={{ fontSize: 10, color: '#64748B', marginTop: 8 }}>
              {source === 'uploaded' ? 'From uploaded boat config' : 'Entered manually'} · {new Date(updatedAt).toLocaleString()}
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
  // Weather notes live in the session's conditions.details_today.comments — the same
  // record the forecast rows use, and the one the timeline's Weather phase reads.
  const [details, setDetails] = useState(null)

  const load = useCallback(async () => {
    setErr(null)
    const res = await fetch(`${base}/attachments?date=${date}&kind=weather`)
    if (!res.ok) { setErr('could not load forecast'); return }
    const j = await res.json()
    setDocs(j.attachments || [])
  }, [base, date])
  useEffect(() => { load() }, [load])

  const loadDetails = useCallback(async () => {
    const res = await fetch(`${base}/conditions?date=${date}`)
    if (!res.ok) return
    const j = await res.json()
    setDetails(j.details || null)
  }, [base, date])
  useEffect(() => { loadDetails() }, [loadDetails])

  // The PATCH replaces details_today wholesale, so carry the forecast `rows` through —
  // otherwise saving a note would silently wipe the day's forecast table.
  async function saveComments(text) {
    const next = { ...(details || {}), comments: text }
    const res = await fetch(`${base}/conditions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, details: next }),
    })
    if (!res.ok) { setErr('could not save the notes'); return }
    setDetails(next)
  }

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
        <div style={{ fontSize: 12, color: '#64748B' }}>
          No forecast for this day.{canEdit ? ' Upload the weather/strategy deck as a PDF.' : ''}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {docs.map((d) => (
            <ForecastThumb key={d.id} doc={d} canEdit={canEdit} onRemove={() => remove(d.id)} />
          ))}
        </div>
      )}

      {/* Weather notes — the human read on the day: expected shifts, sea breeze
          timing, what the forecast decks don't say. Saved to the same conditions
          record, so the timeline's Weather phase picks them up unchanged. */}
      <div style={{ marginTop: docs.length ? 12 : 10 }}>
        <EditableTextBlock
          label="Notes"
          value={details?.comments || ''}
          canEdit={canEdit}
          placeholder="Expected shifts, sea-breeze timing, cloud, tide…"
          onSave={saveComments}
          accent
        />
      </div>
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

// Read-only notes rendering (headings, bullets, bold, #tags, [[clip]]/[[item]] chips)
// now lives in one place — see components/RichText.tsx.

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
      <div style={{ fontSize: 10, color: '#64748B', marginTop: 4 }}>
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
// A document is a PICTURE if its content type says so, or its name ends in an image
// extension (older rows were registered before content_type was always sent).
function isPictureDoc(d) {
  const ct = String(d?.content_type || '')
  if (/^image\//.test(ct)) return true
  return /\.(png|jpe?g|gif|webp|heic|heif|avif)$/i.test(String(d?.name || ''))
}

function NotesCard({ title, aiMode, fields, showDocuments, documentsScope = 'debrief', wrapperStyle, base, date, teamId, boatId, role, canEdit, isMobile, onOpenVideo, onOpenItem }) {
  const [values, setValues] = useState({})
  const [docs, setDocs] = useState([])
  // Per-field view/edit state — editing one field at a time doesn't block
  // others, and Save only PATCHes the field that changed.
  const [editing, setEditing] = useState({}) // { [key]: bool }
  const [drafts, setDrafts] = useState({})   // { [key]: string }
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [lightbox, setLightbox] = useState(null)
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

  // @-link candidates: this day's clips + photos. (The backlog was pruned in
  // migration 0044 — its route is gone, so don't ask for it and 404 every load.)
  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch(`/api/teams/${teamId}/boats/${boatId}/videos?date=${date}`).then((r) => (r.ok ? r.json() : { videos: [] })).catch(() => ({ videos: [] })),
      fetch(`/api/teams/${teamId}/boats/${boatId}/photos`).then((r) => (r.ok ? r.json() : { photos: [] })).catch(() => ({ photos: [] })),
      fetch(`${base}/calendar`).then((r) => (r.ok ? r.json() : { sessions: [] })).catch(() => ({ sessions: [] })),
    ]).then(([v, p, cal]) => {
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
      setLinks([...clips, ...photos])
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
    // Filter docs by scope: speed-meeting docs only show on the speed card,
    // debrief docs only on the debrief card. Older rows without a scope are
    // treated as 'debrief' for back-compat.
    if (showDocuments) {
      const all = Array.isArray(d.documents) ? d.documents : []
      setDocs(all.filter((doc) => (doc.scope || 'debrief') === documentsScope))
    }
    setEditing({})
    setDrafts({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, date, documentsScope, showDocuments])

  useEffect(() => { load() }, [load])

  function startEdit(key) {
    setDrafts((d) => ({ ...d, [key]: values[key] || '' }))
    setEditing((e) => ({ ...e, [key]: true }))
  }
  function cancelEdit(key) {
    setEditing((e) => ({ ...e, [key]: false }))
  }
  async function saveField(key) {
    setSaving(true)
    setErr(null)
    try {
      const next = drafts[key] ?? ''
      const res = await fetch(`${base}/debrief`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, [key]: next }),
      })
      if (!res.ok) { setErr((await res.json().catch(() => ({}))).error || 'save failed'); return }
      setValues((v) => ({ ...v, [key]: next }))
      setEditing((e) => ({ ...e, [key]: false }))
    } finally {
      setSaving(false)
    }
  }

  // Pictures and documents share ONE store (debrief.documents) — they're told apart
  // by content type, not by a separate scope. That keeps the API and the delete path
  // unchanged; only the rendering differs (thumbnail grid vs. file row).
  async function uploadMany(files) {
    if (!files.length) return
    setUploading(true)
    setErr(null)
    const failed = []
    try {
      // Separate Bunny paths per scope so files don't collide and the listing
      // stays tidy. The server records `scope` on the document entry too so
      // the right card can re-render only its own files.
      const folder = documentsScope === 'speed' ? 'speed' : 'debriefs'
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        try {
          // Index in the key: a multi-file loop can share a millisecond on a fast disk.
          const key = `campaign/${folder}/${date}/${Date.now()}-${i}-${safeName(file.name)}`
          await uploadBlobToStorage({ key, blob: file, contentType: file.type })

          // For PICTURES, also upload a small pre-scaled JPEG. Without it the grid
          // renders the ORIGINAL in a ~94px box — a phone shot of a whiteboard is
          // several MB, so a handful of them made the section crawl. 480px/q0.78 is
          // the same thumbnail recipe the Photos tab uses.
          let thumb_key = null
          if (/^image\//.test(file.type || '')) {
            try {
              const tb = await generateThumbnail(file, 480, 0.78)
              thumb_key = `${key}.thumb.jpg`
              await uploadBlobToStorage({ key: thumb_key, blob: tb, contentType: 'image/jpeg' })
            } catch {
              thumb_key = null // non-fatal: fall back to the original in the grid
            }
          }

          const res = await fetch(`${base}/debrief/documents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, name: file.name, key, thumb_key, bytes: file.size, content_type: file.type, scope: documentsScope }),
          })
          if (!res.ok) failed.push(`${file.name}: ${(await res.json().catch(() => ({}))).error || res.status}`)
        } catch (e2) {
          failed.push(`${file.name}: ${e2?.message || 'upload failed'}`)
        }
      }
      if (failed.length) setErr(`Some files failed: ${failed.join('; ')}`)
      load()
    } finally {
      setUploading(false)
    }
  }

  async function onPickFile(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    await uploadMany(files)
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

  return (
    <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14, ...(wrapperStyle || {}) }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0', flex: 1 }}>{title}</div>
      </div>

      {aiMode && (
        <AudioBrief
          mode={aiMode}
          teamId={teamId} boatId={boatId}
          fields={fields}
          canEdit={canEdit}
          isMobile={isMobile}
          onSaved={async (vals) => {
            for (const k of Object.keys(vals)) {
              await fetch(`${base}/debrief`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date, [k]: vals[k] }),
              })
            }
            load()
          }}
        />
      )}

      {err && <div style={{ color: '#EF4444', fontSize: 12, marginBottom: 8 }}>{err}</div>}

      {fields.map((f) => {
        const isEditing = !!editing[f.key]
        const cur = values[f.key] || ''
        const hasContent = !!cur.trim()
        if (!canEdit && !hasContent) return null
        return (
          <div key={f.key} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, flex: 1 }}>{f.label}</div>
              {canEdit && !isEditing && hasContent && (
                <button onClick={() => startEdit(f.key)} style={btnGhost}>Edit</button>
              )}
              {canEdit && isEditing && (
                <>
                  <button onClick={() => saveField(f.key)} disabled={saving} style={btnSmall}>{saving ? 'Saving…' : 'Save'}</button>
                  <button onClick={() => cancelEdit(f.key)} style={btnGhost}>Cancel</button>
                </>
              )}
            </div>
            {isEditing ? (
              <>
                <TagTextArea
                  value={drafts[f.key] || ''}
                  onChange={(v) => setDrafts((d) => ({ ...d, [f.key]: v }))}
                  placeholder={`${f.label}…`}
                  availableTags={availableTags}
                  onAddTag={addVocabTag}
                  links={links}
                  allowLinks={allowLinks}
                  rows={4}
                />
                <FormatHint />
              </>
            ) : hasContent ? (
              <RichText text={cur} onOpenRef={onOpenRef} style={{ fontSize: 13, color: '#E2E8F0' }} />
            ) : (
              <button onClick={() => startEdit(f.key)} style={{ ...btnGhost, alignSelf: 'flex-start' }}>
                + Add {f.label.toLowerCase()}
              </button>
            )}
          </div>
        )
      })}

      {showDocuments && (() => {
        const pictures = docs.filter(isPictureDoc)
        const files = docs.filter((d) => !isPictureDoc(d))
        return (
          <div style={{ marginTop: 4 }}>
            {/* ── Pictures — whiteboard shots, screenshots, sketches from the meeting ── */}
            {pictures.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Pictures</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                  {pictures.map((d) => (
                    <div key={d.key} style={{ position: 'relative' }}>
                      <button
                        onClick={() => d.url && setLightbox(d)}
                        title={`Open ${d.name}`}
                        style={{ padding: 0, border: '1px solid #1E3A5A', borderRadius: 8, overflow: 'hidden', background: '#071624', cursor: d.url ? 'zoom-in' : 'default', width: 104, height: 78, display: 'block' }}
                      >
                        {/* thumb_url = small pre-scaled JPEG; older rows have none,
                            so fall back to the original rather than showing nothing. */}
                        {(d.thumb_url || d.url)
                          ? <img src={d.thumb_url || d.url} alt={d.name} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                          : <span style={{ fontSize: 22 }}>🖼</span>}
                      </button>
                      {canEdit && (
                        <button onClick={() => removeDoc(d.key)} title="Remove"
                          style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: 9, border: 'none', background: 'rgba(0,0,0,0.6)', color: '#EF4444', cursor: 'pointer', fontSize: 11, lineHeight: 1 }}>✕</button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            <div style={{ fontSize: 11, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Documents</div>
            {files.length === 0 && <div style={{ fontSize: 12, color: '#64748B', marginBottom: 6 }}>None yet.</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
              {files.map((d) => (
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
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <label style={{ ...btnGhost, display: 'inline-block', cursor: uploading ? 'default' : 'pointer' }}>
                  {uploading ? 'Uploading…' : '+ Upload document'}
                  <input type="file" multiple onChange={onPickFile} disabled={uploading} style={{ display: 'none' }} />
                </label>
                <label style={{ ...btnGhost, display: 'inline-block', cursor: uploading ? 'default' : 'pointer' }}>
                  {uploading ? 'Uploading…' : '+ Upload pictures'}
                  <input type="file" accept="image/*" multiple onChange={onPickFile} disabled={uploading} style={{ display: 'none' }} />
                </label>
              </div>
            )}

            {/* Lightbox — click the backdrop or ✕ to close. */}
            {lightbox && (
              <div onClick={() => setLightbox(null)}
                style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(3,15,26,0.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <button onClick={() => setLightbox(null)} aria-label="Close"
                  style={{ position: 'absolute', top: 14, right: 16, width: 36, height: 32, borderRadius: 8, border: '1px solid #1E3A5A', background: '#0A1929', color: '#E2E8F0', fontSize: 16, cursor: 'pointer' }}>✕</button>
                <img src={lightbox.url} alt={lightbox.name} onClick={(e) => e.stopPropagation()}
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8, boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }} />
                <div style={{ position: 'absolute', bottom: 14, left: 0, right: 0, textAlign: 'center', fontSize: 12, color: '#94A3B8' }}>{lightbox.name}</div>
              </div>
            )}
          </div>
        )
      })()}
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
        color: '#64748B',
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, color: '#8A97A9', marginBottom: 6 }}>
        {title}
      </div>
      <div style={{ fontSize: 12 }}>{note}</div>
    </div>
  )
}

function PlanView({ teamId, boatId, canEditPlan, canEditDates, canSeeTesting, isMobile, boats, boatScope, scopeAll, crossBoatEdit, onOpenDay }) {
  const [sessions, setSessions] = useState([])
  const [targetDate, setTargetDate] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  // Picked block types for the "+ Add block" creator. Empty means "create the
  // day(s) only, no blocks yet" — same as the legacy add-training-days flow.
  const [pickedBlockTypes, setPickedBlockTypes] = useState(new Set())
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const [addingDays, setAddingDays] = useState(false)

  // The Plan calendar is team-wide — we union every boat's sessions and tag
  // each one with its boat. New days created from this view land on the
  // membership-active boat (the URL boatId).
  const base = `/api/teams/${teamId}/boats/${boatId}/campaign`
  const showBoatChips = (boats || []).length > 1

  const load = useCallback(async () => {
    setErr(null)
    try {
      const res = await fetch(`${base}/calendar?scope=team`)
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

  // Apply the header boat filter: when a specific boat is selected, only
  // show that boat's sessions in the Plan list / counters / empty-state.
  // The fetch above stays team-wide (cheap server-side) so toggling the
  // picker is instant — no refetch on switch.
  const filteredSessions = scopeAll
    ? sessions
    : sessions.filter((s) => s.boat_id === boatScope)

  const today = todayStr()
  // A session is a "racing day" if it carries a `racing` block. Multi-day
  // regattas are just consecutive racing days sharing the same `event` name.
  // The next event = the soonest racing day with `event` set on/after today.
  // From this we derive both counters; if no event is set anywhere, fall
  // back to counting all future planned training days.
  const isRacingDay = (s) => (s.blocks || []).some((b) => b.block_type === 'racing')
  // A "training day" counts when at least one of its blocks is a
  // race-training, technical-testing or speed-testing block. These three
  // block types are inherently on-the-water (that's their definition),
  // so we don't also require venue='on-water' — the block-type filter is
  // enough. Shore / other / racing-only days and pure dock-or-shed days
  // are excluded.
  const ON_WATER_TRAINING_TYPES = new Set(['race-training', 'technical-testing', 'speed-testing'])
  const isOnWaterTrainingDay = (s) =>
    (s.blocks || []).some((b) => ON_WATER_TRAINING_TYPES.has(b.block_type))
  const futureEvents = filteredSessions
    .filter((s) => s.date >= today && isRacingDay(s) && s.event && s.event.trim())
    .sort((a, b) => a.date.localeCompare(b.date))
  const nextEvent = futureEvents[0] || null
  // Counter is now strictly derived from THIS boat's racing days. The
  // legacy team-wide targetDate fallback (teams.features.campaign_target_date)
  // was removed — that field is per-team, not per-boat, so falling back to
  // it produced wrong numbers when the selected boat had no events but
  // another boat on the team did.
  const daysToGo = nextEvent ? Math.max(0, daysBetween(today, nextEvent.date)) : null
  const trainingDaysToGo = nextEvent
    ? filteredSessions.filter(
        (s) => s.date >= today && s.date < nextEvent.date && isOnWaterTrainingDay(s)
      ).length
    : filteredSessions.filter((s) => s.date >= today && isOnWaterTrainingDay(s)).length

  // "Prep day" = a planned day with at least one block at the dock or in
  // the shed AND no on-the-water activity at all. The two counters are
  // mutually exclusive: a training day (block-type-implied on-water) or
  // a day with any block explicitly tagged venue='on-water' is excluded
  // here, so the same calendar day is never counted twice.
  const PREP_VENUES = new Set(['dock', 'shed'])
  const hasOnWaterActivity = (s) =>
    isOnWaterTrainingDay(s) ||
    (s.blocks || []).some((b) => b.venue === 'on-water')
  const isPrepDay = (s) =>
    !hasOnWaterActivity(s) &&
    (s.blocks || []).some((b) => PREP_VENUES.has(b.venue))
  const prepDaysToGo = nextEvent
    ? filteredSessions.filter(
        (s) => s.date >= today && s.date < nextEvent.date && isPrepDay(s)
      ).length
    : filteredSessions.filter((s) => s.date >= today && isPrepDay(s)).length

  async function addDays(e) {
    e.preventDefault()
    const dates = datesInRange(rangeStart, rangeEnd)
    if (dates.length === 0) return
    setAddingDays(true)
    setErr(null)
    try {
      // For each date in the range: upsert the session (returns its id),
      // then POST one block per picked type. Empty pick set just creates
      // the day with no blocks — handy for placeholder planning.
      const typesInOrder = BLOCK_ORDER.filter((t) => pickedBlockTypes.has(t))
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
        const { session } = await res.json().catch(() => ({}))
        const sessionId = session?.id
        if (!sessionId || typesInOrder.length === 0) continue
        // Append blocks at the end of the day's existing block list.
        let seq = 0
        for (const bt of typesInOrder) {
          const bres = await fetch(`${base}/blocks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, block_type: bt, seq }),
          })
          if (!bres.ok) {
            setErr((await bres.json().catch(() => ({}))).error || `could not add block to ${date}`)
            break
          }
          seq++
        }
      }
      setRangeStart('')
      setRangeEnd('')
      setPickedBlockTypes(new Set())
      load()
    } finally {
      setAddingDays(false)
    }
  }

  // saveTarget removed — target date is now derived from the next racing
  // day's event (see Counter logic above).

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
        <Counter
          big
          value={daysToGo == null ? '—' : daysToGo}
          label="Days to go"
          sub={nextEvent
            ? `Next Event: ${nextEvent.event} (${fmtDay(nextEvent.date)})`
            : 'no event set yet'}
        />
        <Counter
          big
          value={trainingDaysToGo}
          label="Training days to go"
          sub={nextEvent
            ? `before ${fmtDay(nextEvent.date)}`
            : `${filteredSessions.length} day${filteredSessions.length === 1 ? '' : 's'} planned`}
        />
        <Counter
          big
          value={prepDaysToGo}
          label="Prep days to go"
          sub={nextEvent
            ? `dock + shed before ${fmtDay(nextEvent.date)}`
            : 'dock + shed days planned'}
        />
      </div>

      {/* Campaign target date is now derived from the next racing day with
          an event set (see counters above). Add a racing block to a day and
          enter the regatta name there. */}

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14, fontSize: 11, color: '#8A97A9' }}>
        {BLOCK_ORDER.filter((t) => canSeeTesting || !BLOCK_META[t].testing).map((t) => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: BLOCK_META[t].c, display: 'inline-block' }} />
            {BLOCK_META[t].label}
          </span>
        ))}
      </div>

      {/* Add day(s) + optionally pre-populate with block types. Each picked
          type becomes one block on every date in the range, in the order
          shown (BLOCK_ORDER). Empty pick = create the day(s) only. */}
      {canEditPlan && (
        <form onSubmit={addDays} style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} style={inputStyle} title="From" />
          <span style={{ color: '#64748B', fontSize: 12 }}>to</span>
          <input type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} style={inputStyle} title="To (optional — leave blank for a single day)" />
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }} title="Pick one or more block types to add to each day">
            {BLOCK_ORDER.filter((t) => canSeeTesting || !BLOCK_META[t].testing).map((t) => {
              const on = pickedBlockTypes.has(t)
              const meta = BLOCK_META[t]
              return (
                <button
                  type="button"
                  key={t}
                  onClick={() => setPickedBlockTypes((prev) => {
                    const next = new Set(prev)
                    if (next.has(t)) next.delete(t); else next.add(t)
                    return next
                  })}
                  style={{
                    fontSize: 11, borderRadius: 999, padding: '4px 10px', cursor: 'pointer',
                    border: `1px solid ${on ? meta.c : '#1E3A5A'}`,
                    background: on ? meta.c : 'transparent',
                    color: on ? '#000' : '#94A3B8',
                    fontWeight: on ? 700 : 500,
                  }}
                >{meta.label}</button>
              )
            })}
          </div>
          <button type="submit" disabled={!rangeStart || addingDays} style={btnPrimary}>
            {addingDays ? 'Adding…' : '+ Add block'}
          </button>
        </form>
      )}

      {err && <div style={{ color: '#EF4444', fontSize: 13, marginBottom: 12 }}>{err}</div>}

      {loading ? (
        <div style={{ color: '#64748B', fontSize: 13 }}>Loading calendar…</div>
      ) : filteredSessions.filter((s) => s.date >= today).length === 0 ? (
        <div style={{ color: '#64748B', fontSize: 13, textAlign: 'center', padding: 30, border: '1px dashed #1E3A5A', borderRadius: 12 }}>
          No upcoming days planned.{canEditPlan ? ' Add the first one above.' : ''}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Plan only shows today and upcoming days — past sessions live in
              Day / Videos / Photos history, not in the forward planning view. */}
          {filteredSessions.filter((s) => s.date >= today).map((s) => {
            // For cross-boat editors (admin / team_manager) writes must
            // target the SESSION'S boat, not the URL-active boat — otherwise
            // saveObjective / saveEvent / + Add block would silently land on
            // the wrong boat's calendar. Build a per-session base URL when
            // the row belongs to a different boat than the membership.
            const isOwnBoat = s.boat_id === boatId
            const sessionBase = isOwnBoat
              ? base
              : `/api/teams/${teamId}/boats/${s.boat_id}/campaign`
            const sessionCanEdit = canEditPlan && (isOwnBoat || crossBoatEdit)
            return (
              <DayCard
                key={s.id}
                base={sessionBase}
                session={s}
                isPast={false}
                canEditPlan={sessionCanEdit}
                canSeeTesting={canSeeTesting}
                isMobile={isMobile}
                onChanged={load}
                showBoatChip={showBoatChips}
                onOpenDay={onOpenDay}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// Regattas — derives a list of regattas from sessions by grouping contiguous
// dates that share the same `event` name. TL3+ (canEditPlan) get a "+ Regatta"
// inline form and the ability to upload event documents (NOR/SI/course
// notice) keyed to the regatta's anchor day. Everyone else sees a read-only
// listing.
//
// Two-way binding with Plan: regattas write through to the same
// `sessions.event` / `sessions.location` columns the Plan calendar and Day
// view use, so adding a regatta here makes racing days appear in Plan and
// the event chip light up in Day; conversely typing an event in Plan's
// DayCard groups that day into a regatta here.
const REGATTA_DOC_KIND = 'regatta'
function RegattasView({ teamId, boatId, canEditPlan, isMobile, boats, crossBoatEdit, onOpenDay }) {
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [adding, setAdding] = useState(false)
  const [addingTraining, setAddingTraining] = useState(false)

  const base = `/api/teams/${teamId}/boats/${boatId}/campaign`
  const showBoatChips = (boats || []).length > 1

  const load = useCallback(async () => {
    setErr(null)
    try {
      // Team-scoped — regattas span the whole team, not just one boat.
      const res = await fetch(`${base}/calendar?scope=team`)
      if (!res.ok) {
        setErr((await res.json().catch(() => ({}))).error || `failed (${res.status})`)
        return
      }
      const j = await res.json()
      setSessions(j.sessions || [])
    } finally {
      setLoading(false)
    }
  }, [base])
  useEffect(() => { load() }, [load])

  // ── Group sessions into regattas ───────────────────────────────────────
  // A "regatta" = consecutive racing days on the same boat sharing an
  // event name. Sorted by date, the earliest day is the anchor (where
  // documents are filed; the location is read from there too if not
  // overridden elsewhere). Gaps of more than a day break a regatta.
  const today = todayStr()
  const regattas = (() => {
    const racing = sessions
      .filter((s) => s.event && s.event.trim() && (s.blocks || []).some((b) => b.block_type === 'racing'))
      .slice()
      .sort((a, b) => (a.boat_id || '').localeCompare(b.boat_id || '') || a.date.localeCompare(b.date))
    const groups = []
    for (const s of racing) {
      const prev = groups[groups.length - 1]
      const sameAsPrev = prev && prev.boat_id === s.boat_id && prev.event === s.event &&
        daysBetween(prev.dateTo, s.date) <= 1
      if (sameAsPrev) {
        prev.dateTo = s.date
        prev.sessions.push(s)
        if (s.location && !prev.location) prev.location = s.location
      } else {
        groups.push({
          key: `${s.boat_id}|${s.event}|${s.date}`,
          boat_id: s.boat_id,
          boat_name: s.boat_name,
          event: s.event,
          location: s.location || null,
          dateFrom: s.date,
          dateTo: s.date,
          sessions: [s],
        })
      }
    }
    // Upcoming first, soonest at the top. Past regattas rendered in their
    // own section below (see split below).
    return groups.sort((a, b) => a.dateFrom.localeCompare(b.dateFrom))
  })()
  const upcomingRegattas = regattas.filter((r) => r.dateTo >= today)
  const pastRegattas = regattas
    .filter((r) => r.dateTo < today)
    .slice()
    .sort((a, b) => b.dateFrom.localeCompare(a.dateFrom))

  // ── Group sessions into training blocks ─────────────────────────────────
  // A "training block" = consecutive days (gap ≤ 1) on the same boat that have
  // at least one non-racing block and no racing block. This mirrors the regatta
  // grouping so a 3-day training block shows as one entry — not one row per day,
  // and never a single bar spanning the whole season.
  const trainingBlocks = (() => {
    const trainingDays = sessions
      .filter((s) => {
        const bl = s.blocks || []
        return bl.some((b) => TRAINING_BLOCK_TYPES.includes(b.block_type)) &&
          !bl.some((b) => b.block_type === 'racing')
      })
      .slice()
      .sort((a, b) => (a.boat_id || '').localeCompare(b.boat_id || '') || a.date.localeCompare(b.date))
    const groups = []
    for (const s of trainingDays) {
      const prev = groups[groups.length - 1]
      const sameAsPrev = prev && prev.boat_id === s.boat_id && daysBetween(prev.dateTo, s.date) <= 1
      const types = (s.blocks || []).filter((b) => TRAINING_BLOCK_TYPES.includes(b.block_type)).map((b) => b.block_type)
      if (sameAsPrev) {
        prev.dateTo = s.date
        prev.sessions.push(s)
        types.forEach((t) => prev.types.add(t))
      } else {
        groups.push({
          key: `${s.boat_id}|train|${s.date}`,
          boat_id: s.boat_id,
          boat_name: s.boat_name,
          dateFrom: s.date,
          dateTo: s.date,
          sessions: [s],
          types: new Set(types),
        })
      }
    }
    return groups.sort((a, b) => b.dateFrom.localeCompare(a.dateFrom))
  })()

  async function createRegatta({ dateFrom, dateTo, name, location }) {
    const dates = datesInRange(dateFrom, dateTo)
    if (dates.length === 0) throw new Error('pick a valid date range')
    const trimName = name.trim().slice(0, 80)
    const trimLoc = (location || '').trim().slice(0, 80) || null
    for (const date of dates) {
      // Upsert session with event + location.
      const r = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, event: trimName, location: trimLoc }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `could not save ${date}`)
      const j = await r.json().catch(() => ({}))
      const sessionId = j?.session?.id
      // Ensure each day has a racing block (so PlanView's racing-day
      // detector picks it up and Day/Backlog filters work). Skip if the
      // day already has one — check the latest sessions copy.
      const existing = sessions.find((s) => s.date === date && s.boat_id === boatId)
      const hasRacing = (existing?.blocks || []).some((b) => b.block_type === 'racing')
      if (sessionId && !hasRacing) {
        await fetch(`${base}/blocks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, block_type: 'racing', seq: 0 }),
        }).catch(() => {})
      }
    }
  }

  // Create a training block: one session per day in the range, each seeded with
  // the picked non-racing block type. No event name (that's what makes it a
  // regatta) — training blocks are typed by their block, grouped by their dates.
  async function createTraining({ dateFrom, dateTo, blockType }) {
    const dates = datesInRange(dateFrom, dateTo)
    if (dates.length === 0) throw new Error('pick a valid date range')
    const bt = TRAINING_BLOCK_TYPES.includes(blockType) ? blockType : 'race-training'
    for (const date of dates) {
      const r = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `could not save ${date}`)
      const j = await r.json().catch(() => ({}))
      const sessionId = j?.session?.id
      // Skip if this day already carries the same training block.
      const existing = sessions.find((s) => s.date === date && s.boat_id === boatId)
      const hasType = (existing?.blocks || []).some((b) => b.block_type === bt)
      if (sessionId && !hasType) {
        await fetch(`${base}/blocks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, block_type: bt, seq: 0 }),
        }).catch(() => {})
      }
    }
  }

  // Remove a training block: delete its typed blocks day-by-day. The session
  // itself is kept (it may hold logs/videos/photos) — it just reverts to a
  // plain day with no planned block.
  async function deleteTraining(tb) {
    const tbBase = tb.boat_id === boatId ? base : `/api/teams/${teamId}/boats/${tb.boat_id}/campaign`
    for (const s of tb.sessions) {
      for (const b of (s.blocks || [])) {
        if (TRAINING_BLOCK_TYPES.includes(b.block_type)) {
          await fetch(`${tbBase}/blocks/${b.id}`, { method: 'DELETE' }).catch(() => {})
        }
      }
    }
    await load()
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: '#94A3B8' }}>
          {regattas.length === 0 && trainingBlocks.length === 0
            ? 'No regattas or training blocks yet.'
            : `${regattas.length} regatta${regattas.length === 1 ? '' : 's'} · ${trainingBlocks.length} training block${trainingBlocks.length === 1 ? '' : 's'}.`}
        </span>
        <div style={{ flex: 1 }} />
        {canEditPlan && (
          <>
            <button onClick={() => { setAddingTraining(true); setAdding(false) }} style={btnGhost} disabled={addingTraining}>+ Training</button>
            <button onClick={() => { setAdding(true); setAddingTraining(false) }} style={btnPrimary} disabled={adding}>+ Regatta</button>
          </>
        )}
      </div>

      {adding && (
        <RegattaForm
          onCancel={() => setAdding(false)}
          onSubmit={async (payload) => {
            try {
              await createRegatta(payload)
              setAdding(false)
              await load()
            } catch (e) { throw e }
          }}
        />
      )}

      {addingTraining && (
        <TrainingForm
          onCancel={() => setAddingTraining(false)}
          onSubmit={async (payload) => {
            try {
              await createTraining(payload)
              setAddingTraining(false)
              await load()
            } catch (e) { throw e }
          }}
        />
      )}

      {err && <div style={{ color: '#EF4444', fontSize: 13, marginBottom: 10 }}>{err}</div>}

      {loading ? (
        <div style={{ color: '#64748B', fontSize: 13 }}>Loading regattas…</div>
      ) : regattas.length === 0 ? (
        <div style={{ color: '#64748B', fontSize: 13, textAlign: 'center', padding: 30, border: '1px dashed #1E3A5A', borderRadius: 12 }}>
          {canEditPlan ? 'Add a regatta to populate the calendar with racing days.' : 'No regattas to show.'}
        </div>
      ) : (
        <>
          {/* Upcoming + currently-running regattas, soonest first. */}
          {upcomingRegattas.length === 0 ? (
            <div style={{ color: '#64748B', fontSize: 13, textAlign: 'center', padding: 16, border: '1px dashed #1E3A5A', borderRadius: 12, marginBottom: pastRegattas.length ? 18 : 0 }}>
              No upcoming regattas.{canEditPlan ? ' Add one above.' : ''}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {upcomingRegattas.map((r) => {
                // Admin / team_manager edit any boat from any workspace;
                // writes are routed via that boat's base URL so the right
                // sessions are updated. Coach / tl3 stay on their own boat.
                const isOwnBoat = r.boat_id === boatId
                const regattaBase = isOwnBoat
                  ? base
                  : `/api/teams/${teamId}/boats/${r.boat_id}/campaign`
                const regattaCanEdit = canEditPlan && (isOwnBoat || crossBoatEdit)
                return (
                  <RegattaCard
                    key={r.key}
                    regatta={r}
                    base={regattaBase}
                    canEdit={regattaCanEdit}
                    isMobile={isMobile}
                    showBoatChip={showBoatChips}
                    onChanged={load}
                    onOpenDay={onOpenDay}
                  />
                )
              })}
            </div>
          )}

          {/* Past regattas — rendered greyed-out in their own section. */}
          {pastRegattas.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, margin: '24px 0 10px' }}>
                Past regattas ({pastRegattas.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {pastRegattas.map((r) => {
                  const isOwnBoat = r.boat_id === boatId
                  const regattaBase = isOwnBoat
                    ? base
                    : `/api/teams/${teamId}/boats/${r.boat_id}/campaign`
                  const regattaCanEdit = canEditPlan && (isOwnBoat || crossBoatEdit)
                  return (
                    <RegattaCard
                      key={r.key}
                      regatta={r}
                      base={regattaBase}
                      canEdit={regattaCanEdit}
                      isMobile={isMobile}
                      showBoatChip={showBoatChips}
                      onChanged={load}
                      onOpenDay={onOpenDay}
                    />
                  )
                })}
              </div>
            </>
          )}
        </>
      )}

      {/* Training blocks — consecutive-day runs, most recent first. */}
      {trainingBlocks.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#1D9E75', textTransform: 'uppercase', letterSpacing: 1, margin: '24px 0 10px' }}>
            Training blocks ({trainingBlocks.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {trainingBlocks.map((tb) => {
              const isOwnBoat = tb.boat_id === boatId
              const canEditTb = canEditPlan && (isOwnBoat || crossBoatEdit)
              const nDays = tb.sessions.length
              return (
                <div key={tb.key} style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#E2E8F0' }}>
                      {tb.dateFrom === tb.dateTo ? fmtDay(tb.dateFrom) : `${fmtDay(tb.dateFrom)} – ${fmtDay(tb.dateTo)}`}
                    </div>
                    <div style={{ fontSize: 11, color: '#8A97A9', marginTop: 2 }}>
                      {nDays} day{nDays === 1 ? '' : 's'}{showBoatChips && tb.boat_name ? ` · ${tb.boat_name}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {BLOCK_ORDER.filter((t) => tb.types.has(t)).map((t) => (
                      <span key={t} style={{ fontSize: 11, borderRadius: 999, padding: '3px 9px', background: (BLOCK_META[t] || BLOCK_META.other).c, color: '#000', fontWeight: 700 }}>
                        {(BLOCK_META[t] || BLOCK_META.other).label}
                      </span>
                    ))}
                  </div>
                  <div style={{ flex: 1 }} />
                  {canEditTb && (
                    <button
                      onClick={() => { if (confirm('Remove this training block? The days stay (with any logs/media) — only the planned training block is cleared.')) deleteTraining(tb) }}
                      style={btnGhost}
                    >Remove</button>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// Add a training block over a date range: pick a block type + from/to dates.
// Mirror of RegattaForm but with a type picker instead of a name/location.
function TrainingForm({ onSubmit, onCancel }) {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [blockType, setBlockType] = useState('race-training')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  async function submit(e) {
    e.preventDefault()
    if (!dateFrom) return
    const re = rangeError(dateFrom, dateTo)
    if (re) { setErr(re); return }
    setBusy(true); setErr(null)
    try {
      await onSubmit({ dateFrom, dateTo: dateTo || dateFrom, blockType })
    } catch (e2) {
      setErr(e2?.message || 'could not save')
    } finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={inputStyle} title="From" required />
        <span style={{ color: '#64748B', fontSize: 12 }}>to</span>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={inputStyle} title="To (leave blank for a single day)" />
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: '#94A3B8' }}>Type</span>
        {TRAINING_BLOCK_TYPES.map((t) => {
          const on = blockType === t
          const meta = BLOCK_META[t] || BLOCK_META.other
          return (
            <button
              type="button"
              key={t}
              onClick={() => setBlockType(t)}
              style={{
                fontSize: 11, borderRadius: 999, padding: '4px 10px', cursor: 'pointer',
                border: `1px solid ${on ? meta.c : '#1E3A5A'}`,
                background: on ? meta.c : 'transparent',
                color: on ? '#000' : '#94A3B8',
                fontWeight: on ? 700 : 500,
              }}
            >{meta.label}</button>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={busy || !dateFrom} style={btnPrimary}>{busy ? 'Saving…' : 'Save training block'}</button>
        <button type="button" onClick={onCancel} style={btnGhost}>Cancel</button>
        {err && <span style={{ color: '#EF4444', fontSize: 12, alignSelf: 'center' }}>{err}</span>}
      </div>
    </form>
  )
}

function RegattaForm({ initial, onSubmit, onCancel }) {
  const [dateFrom, setDateFrom] = useState(initial?.dateFrom || '')
  const [dateTo, setDateTo] = useState(initial?.dateTo || '')
  const [name, setName] = useState(initial?.event || '')
  const [location, setLocation] = useState(initial?.location || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  async function submit(e) {
    e.preventDefault()
    if (!dateFrom || !name.trim()) return
    const re = rangeError(dateFrom, dateTo)
    if (re) { setErr(re); return }
    setBusy(true); setErr(null)
    try {
      await onSubmit({ dateFrom, dateTo: dateTo || dateFrom, name, location })
    } catch (e2) {
      setErr(e2?.message || 'could not save')
    } finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={inputStyle} title="From" required />
        <span style={{ color: '#64748B', fontSize: 12 }}>to</span>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={inputStyle} title="To (leave blank for a single day)" />
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Regatta name (e.g. Maxi Worlds)" maxLength={80} style={{ ...inputStyle, fontSize: 14 }} required />
      <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (e.g. Porto Cervo)" maxLength={80} style={inputStyle} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={busy || !dateFrom || !name.trim()} style={btnPrimary}>{busy ? 'Saving…' : 'Save regatta'}</button>
        <button type="button" onClick={onCancel} style={btnGhost}>Cancel</button>
        {err && <span style={{ color: '#EF4444', fontSize: 12, alignSelf: 'center' }}>{err}</span>}
      </div>
    </form>
  )
}

function RegattaCard({ regatta, base, canEdit, isMobile, showBoatChip, onChanged, onOpenDay }) {
  const [editing, setEditing] = useState(false)
  const [docs, setDocs] = useState([])
  const [docsLoaded, setDocsLoaded] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState(null)

  // Documents are anchored to the regatta's first day. Loaded lazily on
  // first render so the list doesn't fire N queries for N regattas all at
  // once when the tab opens.
  const loadDocs = useCallback(async () => {
    try {
      const res = await fetch(`${base}/attachments?date=${regatta.dateFrom}&kind=${REGATTA_DOC_KIND}`)
      if (!res.ok) { setErr('could not load docs'); return }
      const j = await res.json()
      setDocs(j.attachments || [])
    } finally { setDocsLoaded(true) }
  }, [base, regatta.dateFrom])
  useEffect(() => { loadDocs() }, [loadDocs])

  // Multi-file upload: accept whatever the file picker hands us, upload each
  // file sequentially so we don't saturate the browser's connection limit,
  // and refresh the listing once at the end. A partial failure surfaces in
  // the error strip but doesn't block the files that already landed.
  async function onPickFile(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length === 0) return
    setUploading(true); setErr(null)
    const failed = []
    try {
      for (const file of files) {
        try {
          // Unique key per file: timestamp + safeName already collision-safe
          // for normal use, but loop iteration could share a millisecond on
          // a fast disk — append the index for belt-and-braces.
          const key = `campaign/regattas/${regatta.dateFrom}/${Date.now()}-${failed.length}-${safeName(file.name)}`
          await uploadBlobToStorage({ key, blob: file, contentType: file.type })
          const res = await fetch(`${base}/attachments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: regatta.dateFrom, kind: REGATTA_DOC_KIND, name: file.name, key, bytes: file.size, content_type: file.type }),
          })
          if (!res.ok) {
            const j = await res.json().catch(() => ({}))
            failed.push(`${file.name}: ${j.error || res.status}`)
          }
        } catch (e2) {
          failed.push(`${file.name}: ${e2?.message || 'upload failed'}`)
        }
      }
      if (failed.length) setErr(`Some files failed: ${failed.join('; ')}`)
      loadDocs()
    } finally { setUploading(false) }
  }

  async function removeDoc(id) {
    if (!confirm('Remove this document?')) return
    await fetch(`${base}/attachments`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    loadDocs()
  }

  async function deleteRegatta() {
    if (!confirm(`Remove regatta "${regatta.event}"? Each day's event + location will be cleared but the session itself stays.`)) return
    for (const s of regatta.sessions) {
      await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: s.date, event: null, location: null }),
      }).catch(() => {})
    }
    onChanged()
  }

  if (editing) {
    return (
      <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14 }}>
        <RegattaForm
          initial={regatta}
          onCancel={() => setEditing(false)}
          onSubmit={async (payload) => {
            // Apply the new name/location to every day in the range. If
            // dates changed, days that fell out keep the OLD event name
            // unless we explicitly clear them — easier to handle by
            // clearing the previous range first.
            for (const s of regatta.sessions) {
              await fetch(`${base}/sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: s.date, event: null, location: null }),
              }).catch(() => {})
            }
            const dates = datesInRange(payload.dateFrom, payload.dateTo)
            for (const date of dates) {
              await fetch(`${base}/sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  date,
                  event: payload.name.trim().slice(0, 80),
                  location: (payload.location || '').trim().slice(0, 80) || null,
                }),
              }).catch(() => {})
            }
            setEditing(false)
            onChanged()
          }}
        />
      </div>
    )
  }

  const days = regatta.sessions.length
  const past = regatta.dateTo < todayStr()
  // Past regattas dim the whole card and swap the red chip for a muted
  // grey so the eye is drawn to upcoming events.
  const chipBg = past ? '#334155' : BLOCK_META.racing.c
  const chipFg = past ? '#94A3B8' : '#000'
  return (
    <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14, opacity: past ? 0.65 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 16, fontWeight: 800, color: chipFg, background: chipBg, borderRadius: 5, padding: '2px 9px' }}>
          🏁 {regatta.event}
        </span>
        {regatta.location && <span style={{ fontSize: 13, color: '#E2E8F0' }}>· {regatta.location}</span>}
        {showBoatChip && regatta.boat_name && (
          <span style={{ fontSize: 10, fontWeight: 700, color: '#7DD3FC', background: '#0F2A45', borderRadius: 4, padding: '1px 6px', letterSpacing: 0.4 }}>
            {regatta.boat_name}
          </span>
        )}
        {past && <span style={{ fontSize: 10, color: '#64748B' }}>past</span>}
        <div style={{ flex: 1 }} />
        {canEdit && (
          <>
            <button onClick={() => setEditing(true)} style={btnGhost}>Edit</button>
            <button onClick={deleteRegatta} style={{ ...btnGhost, color: '#EF4444' }}>Remove</button>
          </>
        )}
      </div>
      <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 10 }}>
        {regatta.dateFrom === regatta.dateTo
          ? fmtDay(regatta.dateFrom)
          : `${fmtDay(regatta.dateFrom)} → ${fmtDay(regatta.dateTo)} (${days} day${days === 1 ? '' : 's'})`}
      </div>

      {/* Per-day chips — quick Day-details access. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>
        {regatta.sessions.map((s, i) => (
          <button
            key={s.id}
            onClick={() => onOpenDay && onOpenDay(s.date)}
            title={`Open Day ${i + 1} (${fmtDay(s.date)})`}
            style={{ fontSize: 10, borderRadius: 4, padding: '2px 6px', background: '#0F2A45', border: '1px solid #1E3A5A', color: '#7DD3FC', cursor: 'pointer' }}
          >Day {i + 1}</button>
        ))}
      </div>

      {/* Documents */}
      <div style={{ borderTop: '1px solid #1E3A5A', paddingTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#7DD3FC', textTransform: 'uppercase', letterSpacing: 1, flex: 1 }}>Event documents</span>
          {canEdit && (
            <label style={{ ...btnGhost, display: 'inline-block', cursor: uploading ? 'default' : 'pointer' }}>
              {uploading ? 'Uploading…' : '+ Upload PDFs'}
              <input type="file" accept="application/pdf,image/*" multiple onChange={onPickFile} disabled={uploading} style={{ display: 'none' }} />
            </label>
          )}
        </div>
        {err && <div style={{ color: '#EF4444', fontSize: 12, marginBottom: 6 }}>{err}</div>}
        {!docsLoaded ? (
          <div style={{ fontSize: 11, color: '#64748B' }}>Loading…</div>
        ) : docs.length === 0 ? (
          <div style={{ fontSize: 12, color: '#64748B' }}>No documents yet.{canEdit ? ' Upload the NOR / SI / course notice as PDFs.' : ''}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {docs.map((d) => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#071624', borderRadius: 6, padding: '6px 9px' }}>
                <span style={{ fontSize: 13 }}>📄</span>
                {d.url ? (
                  <a href={d.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#06B6D4', textDecoration: 'none', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</a>
                ) : (
                  <span style={{ fontSize: 12, color: '#94A3B8', flex: 1 }}>{d.name}</span>
                )}
                {canEdit && (
                  <button onClick={() => removeDoc(d.id)} style={{ background: 'none', border: 'none', color: '#EF4444', cursor: 'pointer', fontSize: 12 }}>✕</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
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
      <div style={{ fontSize: 10, color: '#64748B', marginTop: 2 }}>{sub}</div>
    </div>
  )
}

function DayCard({ base, session, isPast, canEditPlan, canSeeTesting, isMobile, onChanged, showBoatChip, onOpenDay }) {
  const [objective, setObjective] = useState(session.objective || '')
  const [objDirty, setObjDirty] = useState(false)
  const [adding, setAdding] = useState(false)
  // Event (regatta name) for racing days. Persisted via /sessions POST.
  const [event, setEvent] = useState(session.event || '')
  const [eventDirty, setEventDirty] = useState(false)
  useEffect(() => { setEvent(session.event || ''); setEventDirty(false) }, [session.event])

  const visibleBlocks = (session.blocks || []).filter(
    (b) => canSeeTesting || !BLOCK_META[b.block_type]?.testing
  )
  const isRacingDay = (session.blocks || []).some((b) => b.block_type === 'racing')

  async function saveObjective() {
    await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: session.date, objective }),
    })
    setObjDirty(false)
    onChanged()
  }

  async function saveEvent() {
    await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: session.date, event: event.trim() ? event.trim() : null }),
    })
    setEventDirty(false)
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
        {showBoatChip && session.boat_name && (
          <span style={{ fontSize: 10, fontWeight: 700, color: '#7DD3FC', background: '#0F2A45', borderRadius: 4, padding: '1px 6px', letterSpacing: 0.4 }}>
            {session.boat_name}
          </span>
        )}
        {/* Event chip in view mode — only meaningful for racing days. */}
        {isRacingDay && session.event && (
          <span style={{ fontSize: 10, fontWeight: 700, color: '#000', background: BLOCK_META.racing.c, borderRadius: 4, padding: '1px 6px', letterSpacing: 0.4 }}>
            🏁 {session.event}
          </span>
        )}
        {isPast && <span style={{ fontSize: 10, color: '#64748B' }}>past</span>}
        <div style={{ flex: 1 }} />
        {onOpenDay && (
          <button
            onClick={() => onOpenDay(session.date)}
            style={{ ...btnGhost, fontSize: 11, padding: '4px 10px' }}
            title="Open this day in the Day tab"
          >Day details →</button>
        )}
      </div>

      {/* Event editor — only racing days have an Event field (the regatta
          name). Multi-day regattas are entered as the same event name on
          each consecutive racing day; the Plan derives "Next Event" from
          the earliest future racing day with this set. */}
      {canEditPlan && isRacingDay && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <input
            value={event}
            onChange={(e) => { setEvent(e.target.value); setEventDirty(true) }}
            placeholder="Event / regatta name (e.g. Cowes Week)…"
            maxLength={80}
            style={{ ...inputStyle, flex: 1, borderColor: BLOCK_META.racing.c + '88' }}
          />
          {eventDirty && <button onClick={saveEvent} style={btnSmall}>Save</button>}
        </div>
      )}

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
          <div style={{ fontSize: 11, color: '#64748B' }}>No blocks{canSeeTesting ? '' : ' visible'}.</div>
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
      {time && <span style={{ fontSize: 11, color: '#64748B', fontFamily: 'monospace' }}>{time}</span>}
      {block.venue && <span style={{ fontSize: 10, color: '#94A3B8', border: '1px solid #334155', borderRadius: 4, padding: '0 5px' }}>{VENUE_LABEL[block.venue]}</span>}
      {block.objective && <span style={{ fontSize: 11, color: '#8A97A9' }}>— {block.objective}</span>}
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
      <select value={venue} onChange={(e) => setVenue(e.target.value)} style={inputStyle} title="Location">
        <option value="">Location…</option>
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
const btnGhostSmall = {
  background: '#1E3A5A',
  border: 'none',
  borderRadius: 6,
  color: '#94A3B8',
  fontSize: 11,
  fontWeight: 700,
  padding: '4px 10px',
  cursor: 'pointer',
}

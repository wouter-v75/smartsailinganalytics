'use client'
// src/components/analytics/PerfChartsSection.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Analytics → "Performance charts": the KND SailingPerf X-Y grids, built from the
// session's own log + event file. One dot per 30 s event-file phase (phaseStats),
// Upwind / Downwind grids of "<channel> vs TWS" in the KND report's order, filtered
// by race, sail combination and tack. BSPpol% / VMG% come from the boat's ACTIVE
// polar (Boat → Targets); without one the log's own PolBsp% column stands in.
// Clicking a dot calls onJump(utc) — the tab opens the covering clip or zooms the
// time series onto that phase.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import PhaseXYPlot from './PhaseXYPlot'
import ReportTable from './ReportTable'
import ManoeuvreTable from './ManoeuvreTable'
import LidarTables from './LidarTables'
import StartSection from './StartSection'
import { LIDAR_SAILS, hasLidar } from '../../lib/lidarTables'
import { REPORTS, buildTable } from '../../lib/reportTables'
import { analyseManoeuvres, isJudged } from '../../lib/manoeuvres'
import { STATS_VERSION, expandPhases, medianInterval, preferStored } from '../../lib/seasonCurves'
import { uploadSessionStats } from '../../lib/phaseStatsUpload'
import { CHANNEL_BY_KEY, computePhaseStats } from '../../lib/phaseStats'
import { polarTargetLine, twsBands, polarCurve } from '../../lib/phasePlot'
import { polarFromData } from '../../lib/polarFile'
import { inSections, phaseInSections, sectionsSpan } from '../../lib/trackSections'
import { mergeStoredLidar } from '../../lib/lidarMerge'
import { SECTION_ORDER, SECTION_TITLES } from '../../lib/headlineFacts'
import { getActiveMembership } from '../../lib/active-membership'
import PhasePanel from './PhasePanel'
import { buildPhases } from '../../lib/buildPhases'
import { withSettings, resolutionNote } from '../../lib/phaseSettings'
import { phasesForSource, upsertRun, removeRun } from '../../lib/ssaPhases'
import { loadSsaPhases, saveSsaPhases, getTagList } from '../../lib/localStore'
import { canBuildPhases, canUploadPhases, phaseRoleNote } from '../../lib/phaseRoles'
import { fetchBoatPhaseSettings, saveBoatPhaseSettings, writeLocalSettings } from '../../lib/phaseSettingsClient'
import { fetchPhaseSets, planUpload, uploadPhaseSet } from '../../lib/phaseUpload'
import { getUidFast } from '../../lib/supabase/browser'

// Grid order per point of sail (KND report order); x is TWS unless given.
const CHARTS = {
  up: ['bsp', 'sog', 'twa', 'awa', 'heel', 'trim', 'fsty', 'rudder', 'jibTack', 'vang', 'cunningham', 'mainsheet',
    'bspPol', { y: 'bspPol', x: 'twa' }, 'vmgPct'],
  down: ['bsp', 'sog', 'twa', 'awa', 'heel', 'trim', 'fsty', 'rudder', 'jibTack', 'vang', 'cunningham', 'mainsheet',
    'upDflct', 'lwDflct', 'bspPol', { y: 'bspPol', x: 'twa' }, 'vmgPct'],
}
// Stbd dot colour per channel (port is always the light-blue ▲, so none of these is #7DD3FC).
const COLORS = {
  bsp: '#10B981', sog: '#FBBF24', twa: '#A78BFA', awa: '#8B5CF6', heel: '#F97316', trim: '#F472B6',
  fsty: '#F59E0B', rudder: '#FBBF24', jibTack: '#FB923C', vang: '#EAB308', cunningham: '#84CC16',
  mainsheet: '#EF4444', upDflct: '#14B8A6', lwDflct: '#0EA5E9', bspPol: '#22C55E', vmgPct: '#22C55E', logPolPct: '#22C55E',
}
const PCT = new Set(['bspPol', 'vmgPct', 'logPolPct', 'logTrgPct'])
const MIN_POINTS = 3

// Dashed season reference curves, newest season first.
const SEASON_COLORS = ['#F8FAFC', '#FBBF24', '#F472B6', '#A3E635']

// The signed-in member's active team + boat (null until known / signed out).
function useActiveBoat() {
  const [boat, setBoat] = React.useState(null)
  React.useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const uid = await getUidFast()
        const m = uid ? getActiveMembership(uid) : null
        if (alive && m?.team_id && m?.boat_id) setBoat({ teamId: m.team_id, boatId: m.boat_id, role: m.role || null })
      } catch { /* not signed in */ }
    })()
    return () => { alive = false }
  }, [])
  return boat
}

// What a built phase carries beyond its times: whether it is a tack, how calm it was,
// and which run it belongs to. Averaging the log loses these, so they are put back.
const pick = p => ({ src: p.src, kind: p.kind, quality: p.quality, ...(p.runId ? { runId: p.runId } : {}) })

// The phases SSA built for this day, and the runs they came from. Their own store, not
// part of the event file: re-importing an event file must ask before replacing work
// somebody selected by hand.
function useSsaPhases(activeDate, boat) {
  const [doc, setDoc] = React.useState(null)
  // The set the TEAM is working from, if a coach has uploaded one.
  const [teamSet, setTeamSet] = React.useState(null)

  React.useEffect(() => {
    let alive = true
    if (!activeDate) { setDoc(null); return }
    loadSsaPhases(activeDate).then(d => { if (alive) setDoc(d || null) }).catch(() => {})
    return () => { alive = false }
  }, [activeDate])

  // Read the uploaded set back. uploadPhaseSet() had no counterpart: a coach put
  // phases "in front of the team" and nothing ever asked the server for them, so
  // they reached the database and stopped there. Every other device saw nothing.
  React.useEffect(() => {
    let alive = true
    setTeamSet(null)
    if (!activeDate || !boat?.teamId || !boat?.boatId) return
    fetchPhaseSets(boat.teamId, boat.boatId, activeDate)
      .then(r => { if (alive) setTeamSet(r.active) })
      .catch(() => {})
    return () => { alive = false }
  }, [activeDate, boat?.teamId, boat?.boatId])

  return [doc, setDoc, teamSet]
}

// The thresholds belong to the BOAT: the team should be judging every day by the same
// numbers. This device's copy is the fallback — offline, or a boat nobody has set yet.
// Changing them here is local until a coach saves them for the boat.
function usePhaseSettings(boat) {
  const [state, setState] = React.useState({ settings: withSettings(), source: 'default', updatedAt: null })
  React.useEffect(() => {
    let alive = true
    if (!boat?.teamId || !boat?.boatId) return
    fetchBoatPhaseSettings(boat.teamId, boat.boatId).then(r => {
      if (alive) setState({ settings: r.settings, source: r.source, updatedAt: r.updatedAt })
    })
    return () => { alive = false }
  }, [boat?.teamId, boat?.boatId])

  const update = React.useCallback(next => {
    const clean = withSettings(next)
    setState(st => ({ ...st, settings: clean, source: 'device' }))
    writeLocalSettings(boat?.boatId, clean)
  }, [boat?.boatId])

  // Coach and up: make these the boat's numbers for everybody.
  const saveForBoat = React.useCallback(async () => {
    if (!boat?.teamId || !boat?.boatId) return 'no active boat'
    const err = await saveBoatPhaseSettings(boat.teamId, boat.boatId, state.settings)
    if (!err) setState(st => ({ ...st, source: 'boat', updatedAt: new Date().toISOString() }))
    return err
  }, [boat?.teamId, boat?.boatId, state.settings])

  return [state.settings, update, { source: state.source, updatedAt: state.updatedAt, saveForBoat }]
}

// The boat's ACTIVE polar. `override` (tests, previews) skips the fetch: { polar, name } or null.
function useActivePolar(boat, override) {
  const [state, setState] = React.useState({ polar: null, name: null, id: null, loaded: false })
  React.useEffect(() => {
    if (override !== undefined || !boat) return
    let alive = true
    fetch(`/api/teams/${boat.teamId}/polars?boat_id=${boat.boatId}&active=1`)
      .then(r => (r.ok ? r.json() : { polars: [] }))
      .then(j => {
        const row = (j.polars || [])[0]
        const polar = polarFromData(row?.data)
        if (alive) setState(polar ? { polar, name: row.name, id: row.id, loaded: true } : { polar: null, name: null, id: null, loaded: true })
      })
      .catch(() => { if (alive) setState(s => ({ ...s, loaded: true })) })   // no polar → the log's own PolBsp%
    return () => { alive = false }
  }, [boat, override])
  return override !== undefined
    ? { polar: override?.polar ?? null, name: override?.name ?? null, id: override?.id ?? null, loaded: true }
    : state
}

// The day's stored stats (session_phase_stats). A device holding the FULL log (rows ≤ 2 s
// apart) uploads what it computes when the stored copy is missing or coarser; a device
// with only the cloud copy (~6 s) uses the stored stats when they are finer and from the
// same polar. `override` (tests) skips the network: a stored row, or null for none.
function useStoredStats(boat, activeDate, polarState, rows, xmlData, override) {
  const [stored, setStored] = React.useState(null)
  const [tick, setTick] = React.useState(0)
  const localRes = React.useMemo(() => medianInterval(rows), [rows])
  const base = boat && activeDate ? `/api/teams/${boat.teamId}/boats/${boat.boatId}/phase-stats/${activeDate}` : null

  React.useEffect(() => {
    if (override !== undefined || !base) return
    let alive = true
    fetch(`${base}?full=1`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (alive) setStored(j?.stats ?? null) })
      .catch(() => {})
    return () => { alive = false }
  }, [base, override, tick])

  React.useEffect(() => {
    if (override !== undefined || !boat || !activeDate || !polarState.loaded) return
    if (localRes == null || localRes > 2 || !xmlData?.phases?.length) return
    const coarser = !stored || stored.resolution_s == null || stored.resolution_s > localRes * 1.5 ||
      (stored.polar_id ?? null) !== (polarState.id ?? null) || stored.stats_version !== STATS_VERSION
    if (!coarser) return
    let alive = true
    uploadSessionStats({ teamId: boat.teamId, boatId: boat.boatId, date: activeDate, rows, xml: xmlData, polar: polarState.polar, polarId: polarState.id })
      .then(r => { if (alive && r.stored) setTick(t => t + 1) })
      .catch(() => {})
    return () => { alive = false }
  }, [boat, activeDate, localRes, stored, polarState.loaded, polarState.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const current = override !== undefined ? override : stored
  return {
    stored: current,
    localRes,
    useStored: preferStored(current, localRes, polarState.id ?? null),
    refresh: () => setTick(t => t + 1),
  }
}

// Season reference curves for the boat, leaving out the session on screen. Opening a
// session first makes sure its own phase averages are stored (computed server-side;
// a no-op when already current). `override` (tests) skips the network.
const NO_CURVES = { curves: {}, sessions: {}, phases: {}, needsMigration: false, loaded: false }
function useSeasonCurves(boat, activeDate, override, serverCompute = true) {
  const [state, setState] = React.useState(NO_CURVES)
  const [rebuild, setRebuild] = React.useState(null) // null | { done, total }
  const [tick, setTick] = React.useState(0)
  const base = boat ? `/api/teams/${boat.teamId}/boats/${boat.boatId}/phase-stats` : null

  React.useEffect(() => {
    if (override !== undefined || !base) return
    let alive = true
    ;(async () => {
      try {
        // A device with the full log stores its own (finer) stats instead — see useStoredStats.
        let storeNeedsMigration = false
        if (activeDate && serverCompute) {
          const s = await fetch(`${base}/${activeDate}?ifStale=1`, { method: 'POST' }).catch(() => null)
          storeNeedsMigration = s?.status === 503 && !!(await s.json().catch(() => ({})))?.needsMigration
        }
        const r = await fetch(`${base}${activeDate ? `?exclude=${activeDate}` : ''}`)
        const j = await r.json().catch(() => ({}))
        if (!alive) return
        if (j.needsMigration || storeNeedsMigration) setState({ ...NO_CURVES, needsMigration: true, loaded: true })
        else if (r.ok) setState({ curves: j.curves || {}, sessions: j.sessions || {}, phases: j.phases || {}, needsMigration: false, loaded: true })
      } catch { /* offline — no curves */ }
    })()
    return () => { alive = false }
  }, [base, activeDate, override, tick, serverCompute])

  // Store every session's phase averages (skipping ones already current), then reload.
  const runRebuild = async () => {
    if (!base || rebuild) return
    const list = await fetch(`/api/teams/${boat.teamId}/boats/${boat.boatId}/sessions`).then(r => r.json()).catch(() => ({}))
    const dates = (list.sessions || []).map(s => s.date).filter(Boolean)
    setRebuild({ done: 0, total: dates.length })
    for (let i = 0; i < dates.length; i++) {
      await fetch(`${base}/${dates[i]}?ifStale=1`, { method: 'POST' }).catch(() => null)
      setRebuild({ done: i + 1, total: dates.length })
    }
    setRebuild(null)
    setTick(t => t + 1)
  }

  if (override !== undefined) return { ...NO_CURVES, loaded: true, ...(override || {}), rebuild: null, runRebuild: () => {} }
  return { ...state, rebuild, runRebuild }
}

const note = { padding: '14px 12px', background: '#071624', borderRadius: 8, color: '#64748B', fontSize: 11 }
const rowSpacing = s => (s == null ? '' : `a row every ${s < 1.5 ? 1 : Math.round(s)} s`)
const smallBtn = { fontSize: 10, borderRadius: 4, padding: '3px 9px', cursor: 'pointer', color: '#CBD5E1', background: '#0F2A45', border: '1px solid #1E3A5A' }

// Written headlines for the day — Mistral on Scaleway (EU), from the stored numbers only
// (…/phase-stats/:date/headlines). Shown to everyone once written; writing needs canUseAI.
function HeadlinesCard({ boat, activeDate, stored, canUseAI, onDone, override }) {
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState('')
  const [fresh, setFresh] = React.useState(null)
  React.useEffect(() => { setFresh(null); setErr('') }, [activeDate])

  const data = override ?? fresh ?? (stored?.headlines
    ? { headlines: stored.headlines, model: stored.headlines_model, at: stored.headlines_at }
    : null)
  if (!canUseAI && !data) return null

  const write = async () => {
    if (!boat || !activeDate) return
    setBusy(true); setErr('')
    try {
      const r = await fetch(`/api/teams/${boat.teamId}/boats/${boat.boatId}/phase-stats/${activeDate}/headlines`, { method: 'POST' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) setErr(j.error || `HTTP ${r.status}`)
      else { setFresh({ headlines: j.headlines, model: j.model, at: j.at }); onDone?.() }
    } catch (e) { setErr(String(e?.message || e)) }
    finally { setBusy(false) }
  }

  const list = items => (
    <ul style={{ margin: '0 0 6px', paddingLeft: 16, color: '#E2E8F0', fontSize: 12, lineHeight: 1.5 }}>
      {items.map((h, i) => <li key={i}>{h}</li>)}
    </ul>
  )
  const dropped = data?.headlines?.dropped?.length || 0
  // Sectioned (Upwind / Downwind / Reaching / Sail shape) — or the single list of older days.
  const sections = data?.headlines?.sections ? SECTION_ORDER.filter(k => data.headlines.sections[k]).map(k => [k, data.headlines.sections[k]]) : null
  const bottomTitle = { fontSize: 9, fontWeight: 700, color: '#94A3B8', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 2 }
  return (
    <div data-headlines style={{ background: '#071624', border: '1px solid #1E3A5A', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: data ? 6 : 0 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#CBD5E1', letterSpacing: 1, textTransform: 'uppercase' }}>Headlines</span>
        {data?.at && (
          <span style={{ fontSize: 9, color: '#475569' }}>
            Mistral on Scaleway (EU) · {new Date(data.at).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        {canUseAI && boat && activeDate && (
          <button onClick={write} disabled={busy} style={{ ...smallBtn, marginLeft: 'auto', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Writing…' : data ? '↻ Rewrite' : '✦ Write headlines'}
          </button>
        )}
      </div>
      {data ? (
        <>
          {sections ? sections.map(([key, s]) => (
            <div key={key} data-headline-section={key} style={{ marginBottom: 8, paddingTop: 6, borderTop: '1px solid #0F2A45' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#7DD3FC', marginBottom: 3 }}>{SECTION_TITLES[key]}</div>
              {list(s.headlines || [])}
              {s.bottomLine?.length > 0 && (
                <>
                  <div style={bottomTitle}>Bottom line</div>
                  {list(s.bottomLine)}
                </>
              )}
            </div>
          )) : (
            <>
              {list(data.headlines.headlines || [])}
              {data.headlines.bottomLine?.length > 0 && (
                <>
                  <div style={bottomTitle}>Bottom line</div>
                  {list(data.headlines.bottomLine)}
                </>
              )}
            </>
          )}
          <div style={{ fontSize: 9, color: '#475569' }}>
            Every number is checked against the tables below
            {dropped ? ` — ${dropped} sentence${dropped === 1 ? '' : 's'} with a number not in them ${dropped === 1 ? 'was' : 'were'} left out` : ''}.
          </div>
        </>
      ) : !busy && (
        <div style={{ fontSize: 10, color: '#64748B', marginTop: 4 }}>
          A short written summary of the tables below, drafted by Mistral on Scaleway (EU). The model copies numbers from the tables and never calculates its own.
        </div>
      )}
      {err && <div style={{ color: '#F59E0B', fontSize: 10, marginTop: 6 }}>{err}</div>}
    </div>
  )
}
const select = { background: '#071624', border: '1px solid #1E3A5A', borderRadius: 6, color: '#CBD5E1', fontSize: 11, padding: '4px 6px', cursor: 'pointer' }
const caption = { fontSize: 11, color: '#94A3B8', marginBottom: 5, letterSpacing: 1, textTransform: 'uppercase' }
const modeBtn = on => ({
  fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '5px 10px', cursor: 'pointer',
  border: `1px solid ${on ? '#06B6D4' : '#1E3A5A'}`, background: on ? '#06B6D420' : '#071624', color: on ? '#06B6D4' : '#94A3B8',
})

export default function PerfChartsSection({
  rows, xmlData, tzOffsetMin = 0, playUtc = null, onJump = null, activeDate = null, canUseAI = false,
  sections = [],  // stretches picked on the GPS track; empty = the whole day
  trackRaceNum = null,  // the race chosen on the track, so both screens agree
  polarOverride, curvesOverride, storedOverride, headlinesOverride,
}) {
  const boat = useActiveBoat()
  const polarState = useActivePolar(boat, polarOverride)
  const { polar, name: polarName } = polarState
  const storedStats = useStoredStats(boat, activeDate, polarState, rows, xmlData, storedOverride)
  const fullLogHere = storedStats.localRes != null && storedStats.localRes <= 2
  const season = useSeasonCurves(boat, activeDate, curvesOverride, !fullLogHere)
  const [hiddenSeasons, setHiddenSeasons] = React.useState([])
  const [mode, setMode] = React.useState('up')
  // Races are switched on and off like sections, rather than picked one at a time: the
  // question is usually "these two races, not that one", which a single choice cannot ask.
  const [hiddenRaces, setHiddenRaces] = React.useState([])
  // Picking a race on the track narrows the phases to it: one choice, two screens, and
  // no wondering why the map and the charts disagree. "All" puts everything back.
  const raceOfGun = React.useCallback((n) => {
    const guns = (xmlData?.raceGuns || []).filter(g => Number.isFinite(g?.utc)).sort((a, b) => a.utc - b.utc)
    return guns[n - 1]?.raceNum ?? n
  }, [xmlData])
  const [sails, setSails] = React.useState('')
  const [tack, setTack] = React.useState('')   // '' | 'port' | 'stbd'
  // Every section's phases are shown; a section can be switched off to take it out of
  // the comparison without losing the stretch itself.
  const [hiddenSections, setHiddenSections] = React.useState([])
  const liveSections = React.useMemo(
    () => sections.filter(sec => !hiddenSections.includes(sec.id)), [sections, hiddenSections])
  const [phaseSource, setPhaseSource] = React.useState('event')  // 'event' | 'ssa' | 'both'
  const [mergeMode, setMergeMode] = React.useState('add')        // where the two overlap
  const [ssaDoc, setSsaDoc, teamSet] = useSsaPhases(activeDate, boat)
  const [settings, setSettings, settingsMeta] = usePhaseSettings(boat)
  const [build, setBuild] = React.useState(null)                 // last build's reasons
  const [test, setTest] = React.useState(null)                   // a timed test in progress
  const [upload, setUpload] = React.useState(null)   // { state, message } after an upload
  // Set aside when an event file was re-imported and its phases were chosen. Kept, not
  // deleted: the charts ignore them until somebody asks for them back.
  const setAside = !!ssaDoc?.setAside && (ssaDoc?.phases?.length || 0) > 0
  // Memoised: a fresh array every render would make every memo below it recompute, and
  // the effect that follows the track's race would then set state for ever.
  //
  // Where BOTH exist, the phases built on this device win: they are work in
  // progress, and silently replacing them with the team's set would lose it. The
  // team's set is offered instead (the banner below), so the choice is visible
  // rather than made for you.
  const localPhases = React.useMemo(() => (setAside ? [] : (ssaDoc?.phases || [])), [setAside, ssaDoc])
  const usingTeamSet = !localPhases.length && (teamSet?.phases?.length || 0) > 0
  const ssaPhases = React.useMemo(
    () => (usingTeamSet ? teamSet.phases : localPhases),
    [usingTeamSet, teamSet, localPhases])
  // Adopting the team's set is pointless while the source is 'event', which
  // ignores SSA phases outright. Same move makeRun() makes after a local build:
  // show what just arrived without hiding the event file's own phases.
  React.useEffect(() => {
    if (usingTeamSet) setPhaseSource(cur => (cur === 'event' ? 'both' : cur))
  }, [usingTeamSet])

  const mayBuild = canBuildPhases(boat?.role)
  const mayUpload = canUploadPhases(boat?.role)
  // Charts read whichever source is chosen; the event file's own phases are untouched.
  const xmlForStats = React.useMemo(() => {
    if (phaseSource === 'event' || !ssaPhases.length) return xmlData
    return { ...xmlData, phases: phasesForSource(phaseSource, xmlData?.phases || [], ssaPhases, mergeMode) }
  }, [phaseSource, mergeMode, ssaPhases, xmlData])
  // Stats stored from a finer log win over computing from the coarser log on this device.
  // Stats stored in the cloud were averaged over the EVENT FILE's phases, so they cannot
  // answer for phases SSA cut itself.
  const useStored = storedStats.useStored && phaseSource === 'event'
  const dayStats = React.useMemo(
    // Computed here from a log without lidar → still show the lidar stored for the day.
    () => {
      if (useStored) return expandPhases(storedStats.stored.phases)
      const computed = mergeStoredLidar(computePhaseStats(rows, xmlForStats, { polar }), storedStats.stored?.phases)
      if (phaseSource === 'event' || !ssaPhases.length) return computed
      // Carry each built phase's kind and quality onto its averages, so a tack stays a
      // tack once averaged and the calmest phases can still be picked out.
      const by = new Map(ssaPhases.map(p => [p.utc, p]))
      return computed.map(st => (by.has(st.utc) ? { ...st, ...pick(by.get(st.utc)) } : st))
    },
    [useStored, storedStats.stored, rows, xmlForStats, polar, phaseSource, ssaPhases])
  const dayManoeuvres = React.useMemo(
    () => (useStored && storedStats.stored.manoeuvres?.length ? storedStats.stored.manoeuvres : analyseManoeuvres(rows, xmlData)),
    [useStored, storedStats.stored, rows, xmlData])
  // The track sections narrow everything below (charts, tables, lidar, tacks & gybes) to
  // their phases. Several sections are a comparison, so a phase in ANY of them counts.
  const range = React.useMemo(() => sectionsSpan(liveSections), [liveSections])
  const [r0, r1] = range || []
  const stats = React.useMemo(
    () => (liveSections.length ? dayStats.filter(p => phaseInSections(p, liveSections)) : dayStats), [dayStats, liveSections])
  const manoeuvres = React.useMemo(
    () => (liveSections.length ? dayManoeuvres.filter(m => inSections(m.utc, liveSections)) : dayManoeuvres), [dayManoeuvres, liveSections])
  const [showAllManoeuvres, setShowAllManoeuvres] = React.useState(false)

  // ── Building phases from a stretch of the day ────────────────────────────
  const saveDoc = React.useCallback(next => {
    setSsaDoc(next)
    if (activeDate) {
      saveSsaPhases(activeDate, next, boat ? { team_id: boat.teamId, boat_id: boat.boatId } : null).catch(() => {})
    }
  }, [activeDate, boat, setSsaDoc])

  const makeRun = React.useCallback((from, to, name, kind, plannedS) => {
    if (!(to > from) || !rows.length || !activeDate) return
    const id = `run-${from}-${Math.random().toString(36).slice(2, 7)}`
    const res = buildPhases(rows, xmlData, settings, {
      from, to, runId: id, resolutionS: storedStats.localRes ?? undefined,
    })
    const run = {
      id, name: (name || '').trim(), tags: [], from, to,
      createdAt: Date.now(), kind, ...(plannedS ? { plannedS } : {}), settings,
    }
    saveDoc(upsertRun(ssaDoc, run, res.phases, activeDate))
    setBuild(res)
    // Show what was just built, without hiding the event file's own phases.
    setPhaseSource(cur => (cur === 'event' ? 'both' : cur))
  }, [rows, xmlData, settings, ssaDoc, activeDate, saveDoc, storedStats.localRes])

  // Coach and up: put this day's built phases in front of the team. Both sources are
  // kept; what is recorded is which wins where they overlap.
  const doUpload = React.useCallback(async mode => {
    if (!boat?.teamId || !boat?.boatId || !activeDate) return
    const plan = planUpload(xmlData?.phases || [], ssaPhases, mode)
    setUpload({ state: 'busy', message: 'Uploading…' })
    const res = await uploadPhaseSet(boat.teamId, boat.boatId, activeDate, {
      plan, eventPhases: xmlData?.phases || [], builtPhases: ssaPhases,
      runs: ssaDoc?.runs || [], settings, userId: null,
    })
    setUpload(res.ok
      ? { state: 'ok', message: `${res.set.phase_count} phases are with the team · ${new Date(res.set.created_at).toLocaleTimeString()}` }
      : { state: 'error', message: res.needsMigration ? `${res.error} — the phases are still on this device` : res.error })
  }, [boat, activeDate, xmlData, ssaPhases, ssaDoc, settings])

  const startTest = (seconds, name) => {
    if (playUtc == null) return
    setTest({ startUtc: playUtc, plannedS: seconds, name: name || '' })
  }
  // Stop takes the timeline's position when it is inside the stretch, so generating can
  // be cut short; otherwise it runs for the length it was started for.
  const stopTest = name => {
    if (!test) return
    const planned = test.startUtc + test.plannedS * 1000
    const end = playUtc != null && playUtc > test.startUtc && playUtc < planned ? playUtc : planned
    makeRun(test.startUtc, end, name || test.name, 'test', test.plannedS)
    setTest(null)
  }

  // The races this day holds, and following the track's own choice of one.
  const raceNums = React.useMemo(
    () => Array.from(new Set(dayStats.map(p => p.race).filter(r => r != null))).sort((a, b) => a - b), [dayStats])
  React.useEffect(() => {
    const next = trackRaceNum == null
      ? []
      : (() => {
          const pick = raceNums.find(n => raceOfGun(n) === trackRaceNum)
          return pick == null ? [] : raceNums.filter(n => n !== pick)
        })()
    // Only when it actually changes: setting state to an equal-but-new array on every
    // render is how a render loop starts.
    setHiddenRaces(cur => (cur.length === next.length && cur.every((v, i) => v === next[i]) ? cur : next))
  }, [trackRaceNum, raceNums, raceOfGun])

  if (!xmlData?.phases?.length && !ssaPhases.length) {
    return <div style={note}>No phases in this session’s event file — re-import the event (.ev.xml) file, or select a stretch of the track and let SSA build them.</div>
  }
  if (liveSections.length && dayStats.length && !stats.length) {
    return <div style={note}>No 30 s phase has its midpoint inside the selected {sections.length === 1 ? 'section' : 'sections'} — select a longer stretch.</div>
  }
  if (!stats.length) return <div style={note}>No log rows fall inside the event file’s phases.</div>

  const guns = (xmlData.raceGuns || []).filter(g => Number.isFinite(g?.utc)).sort((a, b) => a.utc - b.utc)
  const raceLabel = i => (guns[i - 1]?.raceNum ? `Race ${guns[i - 1].raceNum}` : `Race ${i}`)
  // From the whole day, not from what is on screen: a race switched off must still have
  // a button to switch it back on.
  const races = raceNums
  // "Speed vs TWA" (mode 'polar'), the report tables and the manoeuvres cover the whole day.
  const modeStats = ['polar', 'tables', 'manoeuvres', 'lidar', 'start'].includes(mode) ? stats : stats.filter(s => s.mode === mode)
  const lidarSails = LIDAR_SAILS.filter(s => hasLidar(stats, s.sail))
  const combos = Array.from(new Set(modeStats.map(s => s.sailCombo))).sort()
  const sailsSel = combos.includes(sails) ? sails : ''
  // A phase before the first gun belongs to no race: dock-out, the sail-up, the tuning
  // run. It is part of the day, so it counts in All — but the moment somebody asks for a
  // race or a section, they are asking about racing, and pre-race phases are noise in
  // that answer.
  const filtering = hiddenRaces.length > 0 || liveSections.length > 0
  const shown = modeStats.filter(s =>
    (s.race == null ? !filtering : !hiddenRaces.includes(s.race))
    && (!sailsSel || s.sailCombo === sailsSel) && (!tack || s.tack === tack))
  const count = m => stats.filter(s => s.mode === m).length

  const specs = (CHARTS[mode] || [])
    .map(c => (typeof c === 'string' ? { y: c, x: 'tws' } : c))
    .map(s => (!polar && s.y === 'bspPol' ? { ...s, y: 'logPolPct' } : s))
    .filter(s => polar || s.y !== 'vmgPct')
    .filter(s => shown.filter(p => p.mean[s.x] != null && p.mean[s.y] != null).length >= MIN_POINTS)
  const tws = shown.map(p => p.mean.tws).filter(Number.isFinite)
  const bands = mode === 'polar' ? twsBands(shown) : []
  const seasons = Object.keys(season.curves).sort().reverse()
  const seasonColor = s => SEASON_COLORS[seasons.indexOf(s) % SEASON_COLORS.length]
  const refCurvesFor = yKey => (mode === 'up' || mode === 'down')
    ? seasons.filter(s => !hiddenSeasons.includes(s))
      .map(s => ({ label: s, color: seasonColor(s), points: season.curves[s]?.[mode]?.[yKey] || [] }))
      .filter(c => c.points.length >= 2)
    : []

  return (
    <div>
      <HeadlinesCard boat={boat} activeDate={activeDate} stored={storedStats.stored} canUseAI={canUseAI}
        onDone={storedStats.refresh} override={headlinesOverride} />
      {teamSet && (
        <div style={{
          margin: '0 0 8px', padding: '7px 10px', borderRadius: 8, fontSize: 10, lineHeight: 1.6,
          background: usingTeamSet ? '#0B2136' : '#071624',
          border: `1px solid ${usingTeamSet ? '#1D9E75' : '#1E3A5A'}`,
          color: usingTeamSet ? '#7DD3FC' : '#64748B',
        }}>
          {usingTeamSet
            ? `Showing the team's phase set — ${teamSet.phase_count} phases, uploaded ${new Date(teamSet.created_at).toLocaleString()}.`
            : `The team has a phase set for this day (${teamSet.phase_count} phases, uploaded ${new Date(teamSet.created_at).toLocaleString()}), but the phases built on this device are being shown instead.`}
          {teamSet.note ? ` · ${teamSet.note}` : ''}
        </div>
      )}
      <PhasePanel
        source={phaseSource} onSource={setPhaseSource}
        mergeMode={mergeMode} onMergeMode={setMergeMode}
        settings={settings} onSettings={setSettings}
        counts={{
          event: xmlData?.phases?.length || 0,
          ssa: ssaPhases.filter(p => p.kind === 'steady').length,
          manoeuvres: ssaPhases.filter(p => p.kind !== 'steady').length,
        }}
        build={build}
        runs={ssaDoc?.runs || []}
        onDeleteRun={r => saveDoc(removeRun(ssaDoc, r.id))}
        onJumpRun={r => onJump?.(r.from)}
        selection={range}
        races={races.map(n => ({ n, label: raceLabel(n) }))} hiddenRaces={hiddenRaces}
        allOn={!hiddenRaces.length && !hiddenSections.length}
        onAll={() => { setHiddenRaces([]); setHiddenSections([]) }}
        onToggleRace={n => setHiddenRaces(h => h.includes(n) ? h.filter(x => x !== n) : [...h, n])}
        sections={sections} hiddenSections={hiddenSections}
        onToggleSection={id => setHiddenSections(h => h.includes(id) ? h.filter(x => x !== id) : [...h, id])}
        onBuildSelection={name => makeRun(r0, r1, name, 'selection')}
        test={test} onTestStart={startTest} onTestStop={stopTest}
        playUtc={playUtc} tzOffsetMin={tzOffsetMin}
        canBuild={mayBuild} canUpload={mayUpload} roleNote={phaseRoleNote(boat?.role)}
        asideCount={setAside ? ssaDoc.phases.length : 0}
        onRestoreAside={setAside && mayBuild ? () => saveDoc({ ...ssaDoc, setAside: false }) : null}
        settingsMeta={settingsMeta}
        uploadPlan={ssaPhases.length ? mode => planUpload(xmlData?.phases || [], ssaPhases, mode) : null}
        onUpload={doUpload} upload={upload}
        resolutionNote={resolutionNote(storedStats.localRes, settings.phaseLenS)}
        tagOptions={activeDate ? getTagList(activeDate) : []}
      />
      {lidarSails.length > 0 && mode !== 'lidar' && (
        <div data-lidar-available style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '0 0 10px',
          padding: '8px 12px', borderRadius: 8, background: '#A78BFA14', border: '1px solid #A78BFA55' }}>
          <span style={{ fontSize: 11, color: '#C4B5FD' }}>
            ◐ Lidar sail shape for this day · {lidarSails.map(s => s.label).join(', ')} · {stats.filter(p => lidarSails.some(s => hasLidar([p], s.sail))).length} phases
          </span>
          <button onClick={() => setMode('lidar')}
            style={{ fontSize: 11, fontWeight: 600, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', color: '#030F1A', background: '#C4B5FD', border: 'none' }}>
            Show lidar tables
          </button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <button onClick={() => setMode('up')} aria-pressed={mode === 'up'} style={modeBtn(mode === 'up')}>▲ Upwind · {count('up')}</button>
        <button onClick={() => setMode('down')} aria-pressed={mode === 'down'} style={modeBtn(mode === 'down')}>▽ Downwind · {count('down')}</button>
        <button onClick={() => setMode('polar')} aria-pressed={mode === 'polar'} style={modeBtn(mode === 'polar')}>◎ Speed vs TWA</button>
        <button onClick={() => setMode('tables')} aria-pressed={mode === 'tables'} style={modeBtn(mode === 'tables')}>▦ Tables</button>
        <button onClick={() => setMode('manoeuvres')} aria-pressed={mode === 'manoeuvres'} style={modeBtn(mode === 'manoeuvres')}>⟲ Tacks &amp; gybes</button>
        <button onClick={() => setMode('lidar')} aria-pressed={mode === 'lidar'} style={modeBtn(mode === 'lidar')}>◐ Lidar</button>
        {guns.length > 0 && (
          <button onClick={() => setMode('start')} aria-pressed={mode === 'start'} style={modeBtn(mode === 'start')}>⚑ Start · {guns.length}</button>
        )}
        {combos.length > 1 && (
          <select aria-label="Sails" value={sailsSel} onChange={e => setSails(e.target.value)} style={select}>
            <option value="">All sails</option>
            {combos.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <select aria-label="Tack" value={tack} onChange={e => setTack(e.target.value)} style={select}>
          <option value="">Both tacks</option>
          <option value="port">Port</option>
          <option value="stbd">Stbd</option>
        </select>
        <span style={{ fontSize: 9, borderRadius: 3, padding: '2px 7px', marginLeft: 'auto',
          color: polar ? '#22C55E' : '#F59E0B', background: polar ? '#22C55E10' : '#F59E0B10', border: `1px solid ${polar ? '#22C55E30' : '#F59E0B30'}` }}>
          {polar ? `Polar · ${polarName}` : '⚠ No polar for this boat — BSPpol% from the log'}
        </span>
        {(useStored || storedStats.localRes != null) && (
          <span data-resolution style={{ fontSize: 9, color: '#64748B' }}
            title={useStored || fullLogHere ? 'Computed from every row of the imported log'
              : 'The cloud copy of the log keeps a row every few seconds; open the day on the device that imported the log to store full-resolution stats'}>
            {useStored
              ? `Full log · ${rowSpacing(storedStats.stored.resolution_s)}`
              : `${fullLogHere ? 'Full log' : 'Cloud log'} · ${rowSpacing(storedStats.localRes)}`}
          </span>
        )}
      </div>
      <div style={{ fontSize: 9, color: '#475569', marginBottom: 10 }}>
        {shown.length} phases of 30 s{liveSections.length ? (liveSections.length > 1 ? ` in ${liveSections.length} sections` : ' in the track selection') : ''}{combos.length === 1 ? ` · ${combos[0]}` : ''} · each dot is one phase average
        {onJump ? ' · click a dot to jump to it' : ''}
      </div>
      {(mode === 'up' || mode === 'down') && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '-4px 0 10px' }}>
          <span style={{ fontSize: 9, color: '#475569' }}>Season curves · median per 1 kn, this day left out:</span>
          {season.needsMigration ? (
            <span style={{ fontSize: 9, color: '#F59E0B', background: '#F59E0B10', border: '1px solid #F59E0B30', borderRadius: 3, padding: '2px 7px' }}>
              Needs database migrations 0060 + 0061
            </span>
          ) : seasons.length ? seasons.map(s => {
            const on = !hiddenSeasons.includes(s)
            const c = seasonColor(s)
            return (
              <button key={s} aria-pressed={on} onClick={() => setHiddenSeasons(h => (on ? [...h, s] : h.filter(x => x !== s)))}
                style={{ fontSize: 9, borderRadius: 3, padding: '2px 7px', cursor: 'pointer', color: on ? c : '#475569',
                  background: on ? `${c}18` : 'transparent', border: `1px ${on ? 'solid' : 'dashed'} ${c}${on ? '80' : '40'}` }}>
                ┄ {s} · {season.sessions[s]} session{season.sessions[s] === 1 ? '' : 's'}
              </button>
            )
          }) : season.loaded ? <span style={{ fontSize: 9, color: '#475569' }}>none stored yet</span> : null}
          {!season.needsMigration && boat && (
            <button onClick={season.runRebuild} disabled={!!season.rebuild}
              style={{ fontSize: 9, borderRadius: 3, padding: '2px 7px', cursor: season.rebuild ? 'default' : 'pointer',
                color: '#94A3B8', background: '#071624', border: '1px solid #1E3A5A' }}>
              {season.rebuild ? `Storing sessions ${season.rebuild.done}/${season.rebuild.total}…` : '↻ Rebuild from all sessions'}
            </button>
          )}
        </div>
      )}

      {mode === 'start' ? (
        <StartSection rows={rows} xmlData={xmlData} polar={polar} tzOffsetMin={tzOffsetMin} onJump={onJump} range={range} />
      ) : mode === 'lidar' && lidarSails.length ? (
        <LidarTables stats={shown} sails={lidarSails} xmlData={xmlData} tzOffsetMin={tzOffsetMin} onJump={onJump} />
      ) : mode === 'lidar' ? (
        <div data-lidar-empty style={{ ...note, lineHeight: 1.6 }}>
          No lidar sail shape for this day. Lidar (the MN_ / JIB_ / SPI_ camber, draft and twist columns and their T_
          targets) is read when the Expedition log is imported — logs imported before 14 Sep 2026 were read without it,
          and the cloud copy of a log never carries it. To see it: in Upload, import this day’s log again on a device
          where the event file is loaded (or import both together). The lidar phase averages are then stored with the
          day’s performance stats, so every device shows the tables.
        </div>
      ) : mode === 'manoeuvres' ? (
        (() => {
          const listed = manoeuvres.filter(m =>
            (showAllManoeuvres || isJudged(m))
            && (m.race == null ? !filtering : !hiddenRaces.includes(m.race))
            && (!sailsSel || m.sails === sailsSel))
          return (
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#94A3B8', margin: '-2px 0 10px' }}>
                <input type="checkbox" checked={showAllManoeuvres} onChange={e => setShowAllManoeuvres(e.target.checked)} />
                Also show pre-start, after racing and mark roundings (greyed, not in the averages)
              </label>
              <ManoeuvreTable id="tacks" title="Tacks" list={listed.filter(m => m.kind === 'tack')} tzOffsetMin={tzOffsetMin} onJump={onJump} raceLabel={raceLabel} />
              <ManoeuvreTable id="gybes" title="Gybes" list={listed.filter(m => m.kind === 'gybe')} tzOffsetMin={tzOffsetMin} onJump={onJump} raceLabel={raceLabel} />
              <div style={{ fontSize: 9, color: '#475569', lineHeight: 1.5 }}>
                From the event file’s tack/gybe list (or TWA flips in the log when it has none). BSP before −40…−10 s ·
                95 % = first sample after the speed low back at 95 % of BSP before · turn = heading −20…−5 s → +15…+30 s ·
                distance lost = VMG vs the 30 s before, −20…+60 s, n/a after a short hitch, into a mark or across a log gap —
                indicative, like KND’s. The cloud log has a row every ~6 s, so max rotation reads low.
              </div>
            </div>
          )
        })()
      ) : mode === 'tables' ? (
        <div>
          {[['up', 'Upwind report'], ['down', 'Downwind report'], ['reach', 'Reaching report'], ['loads', 'Loads']].map(([k, title]) => {
            const tables = REPORTS[k].map(spec => buildTable(shown, spec, { hasPolar: !!polar })).filter(t => t.rows.length)
            if (!tables.length) return null
            return (
              <div key={k} data-report-group={k} style={{ marginBottom: 18 }}>
                <div style={{ ...caption, fontSize: 10, color: '#94A3B8', marginBottom: 8 }}>{title}</div>
                {tables.map(t => <ReportTable key={t.id} table={t} />)}
              </div>
            )
          })}
          <div style={{ fontSize: 9, color: '#475569' }}>
            Means of the 30 s phase averages; “max” is the highest logged sample in the group — the cloud log keeps a
            row every ~6 s, so short peaks can read lower than a 1 Hz report.
          </div>
        </div>
      ) : mode === 'polar' ? (
        bands.length ? (
          <div className="perf-chart-grid">
            {bands.map(b => {
              const curve = polarCurve(polar, b.centre)
              return (
                <div key={b.centre} data-chart={`bsp-twa-tws${b.centre}`}>
                  <div style={caption}>
                    BSP vs |TWA| · TWS {b.centre} kn
                    <span style={{ textTransform: 'none', letterSpacing: 0 }}> ({b.lo}–{b.hi} kn){polar && !curve ? ' · beyond the polar' : ''}</span>
                  </div>
                  <PhaseXYPlot sections={liveSections} phases={b.phases} xKey="twa" yKey="bsp" color={COLORS.bsp} height={320} showTrend={false}
                    targetLine={curve} targetLabel={`polar ${b.centre} kn`} tzOffsetMin={tzOffsetMin}
                    onSelectUtc={onJump} activeUtc={playUtc} />
                </div>
              )
            })}
          </div>
        ) : (
          <div style={note}>No 2 kn wind band has 3 or more phases with these filters.</div>
        )
      ) : specs.length ? (
        <div className="perf-chart-grid">
          {specs.map(s => {
            const yCh = CHANNEL_BY_KEY[s.y], xCh = CHANNEL_BY_KEY[s.x]
            const target = s.x === 'tws' ? polarTargetLine(polar, mode, s.y, Math.min(...tws), Math.max(...tws)) : null
            return (
              <div key={`${s.y}-${s.x}`} data-chart={`${s.y}-${s.x}`}>
                <div style={caption}>{yCh.label} vs {xCh.label}</div>
                <PhaseXYPlot sections={liveSections} phases={shown} xKey={s.x} yKey={s.y} color={COLORS[s.y] || '#06B6D4'} height={300}
                  yLines={PCT.has(s.y) ? [100] : []} targetLine={target} tzOffsetMin={tzOffsetMin}
                  refCurves={s.x === 'tws' ? refCurvesFor(s.y) : []}
                  onSelectUtc={onJump} activeUtc={playUtc} />
              </div>
            )
          })}
        </div>
      ) : (
        <div style={note}>No phases match these filters.</div>
      )}
    </div>
  )
}

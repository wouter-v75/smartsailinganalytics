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
import { LIDAR_SAILS, hasLidar } from '../../lib/lidarTables'
import { REPORTS, buildTable } from '../../lib/reportTables'
import { analyseManoeuvres, isJudged } from '../../lib/manoeuvres'
import { STATS_VERSION, expandPhases, medianInterval, preferStored } from '../../lib/seasonCurves'
import { uploadSessionStats } from '../../lib/phaseStatsUpload'
import { CHANNEL_BY_KEY, computePhaseStats } from '../../lib/phaseStats'
import { polarTargetLine, twsBands, polarCurve } from '../../lib/phasePlot'
import { polarFromData } from '../../lib/polarFile'
import { inRange, phaseInRange } from '../../lib/trackSelection'
import { getActiveMembership } from '../../lib/active-membership'
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
        if (alive && m?.team_id && m?.boat_id) setBoat({ teamId: m.team_id, boatId: m.boat_id })
      } catch { /* not signed in */ }
    })()
    return () => { alive = false }
  }, [])
  return boat
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
          {list(data.headlines.headlines || [])}
          {data.headlines.bottomLine?.length > 0 && (
            <>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#94A3B8', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 2 }}>Bottom line</div>
              {list(data.headlines.bottomLine)}
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
const caption = { fontSize: 9, color: '#475569', marginBottom: 4, letterSpacing: 1, textTransform: 'uppercase' }
const modeBtn = on => ({
  fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '5px 10px', cursor: 'pointer',
  border: `1px solid ${on ? '#06B6D4' : '#1E3A5A'}`, background: on ? '#06B6D420' : '#071624', color: on ? '#06B6D4' : '#94A3B8',
})

export default function PerfChartsSection({
  rows, xmlData, tzOffsetMin = 0, playUtc = null, onJump = null, activeDate = null, canUseAI = false,
  range = null,   // [utc0, utc1] — a stretch picked on the GPS track; null = the whole day
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
  const [race, setRace] = React.useState('')   // '' = all day
  const [sails, setSails] = React.useState('')
  const [tack, setTack] = React.useState('')   // '' | 'port' | 'stbd'
  // Stats stored from a finer log win over computing from the coarser log on this device.
  const useStored = storedStats.useStored
  const dayStats = React.useMemo(
    () => (useStored ? expandPhases(storedStats.stored.phases) : computePhaseStats(rows, xmlData, { polar })),
    [useStored, storedStats.stored, rows, xmlData, polar])
  const dayManoeuvres = React.useMemo(
    () => (useStored && storedStats.stored.manoeuvres?.length ? storedStats.stored.manoeuvres : analyseManoeuvres(rows, xmlData)),
    [useStored, storedStats.stored, rows, xmlData])
  // A track selection narrows everything below (charts, tables, lidar, tacks & gybes) to its phases.
  const [r0, r1] = range || []
  const stats = React.useMemo(() => (range ? dayStats.filter(p => phaseInRange(p, [r0, r1])) : dayStats), [dayStats, r0, r1])
  const manoeuvres = React.useMemo(() => (range ? dayManoeuvres.filter(m => inRange(m.utc, [r0, r1])) : dayManoeuvres), [dayManoeuvres, r0, r1])
  const [showAllManoeuvres, setShowAllManoeuvres] = React.useState(false)

  if (!xmlData?.phases?.length) {
    return <div style={note}>No phases in this session’s event file — re-import the event (.ev.xml) file to see performance charts.</div>
  }
  if (range && dayStats.length && !stats.length) {
    return <div style={note}>No 30 s phase has its midpoint inside the track selection — select a longer stretch.</div>
  }
  if (!stats.length) return <div style={note}>No log rows fall inside the event file’s phases.</div>

  const guns = (xmlData.raceGuns || []).filter(g => Number.isFinite(g?.utc)).sort((a, b) => a.utc - b.utc)
  const raceLabel = i => (guns[i - 1]?.raceNum ? `Race ${guns[i - 1].raceNum}` : `Race ${i}`)
  const races = Array.from(new Set(stats.map(s => s.race).filter(r => r != null))).sort((a, b) => a - b)
  // "Speed vs TWA" (mode 'polar'), the report tables and the manoeuvres cover the whole day.
  const modeStats = ['polar', 'tables', 'manoeuvres', 'lidar'].includes(mode) ? stats : stats.filter(s => s.mode === mode)
  const lidarSails = LIDAR_SAILS.filter(s => hasLidar(stats, s.sail))
  const combos = Array.from(new Set(modeStats.map(s => s.sailCombo))).sort()
  const sailsSel = combos.includes(sails) ? sails : ''
  const shown = modeStats.filter(s =>
    (!race || String(s.race) === race) && (!sailsSel || s.sailCombo === sailsSel) && (!tack || s.tack === tack))
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
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <button onClick={() => setMode('up')} aria-pressed={mode === 'up'} style={modeBtn(mode === 'up')}>▲ Upwind · {count('up')}</button>
        <button onClick={() => setMode('down')} aria-pressed={mode === 'down'} style={modeBtn(mode === 'down')}>▽ Downwind · {count('down')}</button>
        <button onClick={() => setMode('polar')} aria-pressed={mode === 'polar'} style={modeBtn(mode === 'polar')}>◎ Speed vs TWA</button>
        <button onClick={() => setMode('tables')} aria-pressed={mode === 'tables'} style={modeBtn(mode === 'tables')}>▦ Tables</button>
        <button onClick={() => setMode('manoeuvres')} aria-pressed={mode === 'manoeuvres'} style={modeBtn(mode === 'manoeuvres')}>⟲ Tacks &amp; gybes</button>
        <button onClick={() => setMode('lidar')} aria-pressed={mode === 'lidar'} style={modeBtn(mode === 'lidar')}>◐ Lidar</button>
        <select aria-label="Race" value={race} onChange={e => setRace(e.target.value)} style={select}>
          <option value="">All day</option>
          {races.map(r => <option key={r} value={String(r)}>{raceLabel(r)}</option>)}
        </select>
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
        {shown.length} phases of 30 s{range ? ' in the track selection' : ''}{combos.length === 1 ? ` · ${combos[0]}` : ''} · each dot is one phase average
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

      {mode === 'lidar' && lidarSails.length ? (
        <LidarTables stats={shown} sails={lidarSails} />
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
            (showAllManoeuvres || isJudged(m)) && (!race || String(m.race) === race) && (!sailsSel || m.sails === sailsSel))
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
          {[['up', 'Upwind report'], ['down', 'Downwind report'], ['loads', 'Loads']].map(([k, title]) => {
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 12 }}>
            {bands.map(b => {
              const curve = polarCurve(polar, b.centre)
              return (
                <div key={b.centre} data-chart={`bsp-twa-tws${b.centre}`}>
                  <div style={caption}>
                    BSP vs |TWA| · TWS {b.centre} kn
                    <span style={{ textTransform: 'none', letterSpacing: 0 }}> ({b.lo}–{b.hi} kn){polar && !curve ? ' · beyond the polar' : ''}</span>
                  </div>
                  <PhaseXYPlot phases={b.phases} xKey="twa" yKey="bsp" color={COLORS.bsp} height={190} showTrend={false}
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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 12 }}>
          {specs.map(s => {
            const yCh = CHANNEL_BY_KEY[s.y], xCh = CHANNEL_BY_KEY[s.x]
            const target = s.x === 'tws' ? polarTargetLine(polar, mode, s.y, Math.min(...tws), Math.max(...tws)) : null
            return (
              <div key={`${s.y}-${s.x}`} data-chart={`${s.y}-${s.x}`}>
                <div style={caption}>{yCh.label} vs {xCh.label}</div>
                <PhaseXYPlot phases={shown} xKey={s.x} yKey={s.y} color={COLORS[s.y] || '#06B6D4'} height={170}
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

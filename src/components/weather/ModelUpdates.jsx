// Model updates — admin freshness table at the top of the Weather ▸ Admin view.
//
// One row per model we download, plus Icon-Race (self-hosted). Columns:
//   Model | Init (00/06/12/18) | Started at | Status | Next run + ETA
//
// Open-Meteo rows come from each model's /static/meta.json (run init time,
// when it became available, the run cadence). The Icon-Race row reads the live
// status.json the box publishes once a minute (per-domain pipeline state).
// The whole table refreshes every 60 s.

import React, { useEffect, useState, useCallback } from 'react'
import { MODELS, fetchModelMeta, fetchIconRaceStatus } from './openMeteo'

// Order: the self-hosted model first (the headline), then the global/regional
// models we pull from Open-Meteo.
const ROWS = ['ICONRACE', 'AROME', 'ARPEGE', 'ICON', 'ECMWF', 'ITALIA', 'DMI']

const REFRESH_MS = 60_000

// ── time helpers (model cycles are clearest in UTC) ─────────────────────────
const nowSec = () => Date.now() / 1000
const pad = (n) => String(n).padStart(2, '0')

function relFromSec(sec) {
  if (sec == null) return ''
  const d = sec - nowSec()
  const a = Math.abs(d)
  const h = Math.floor(a / 3600)
  const m = Math.floor((a % 3600) / 60)
  const s = h > 0 ? `${h}h${m ? ' ' + m + 'm' : ''}` : `${m}m`
  return d >= 0 ? `in ${s}` : `${s} ago`
}
function hourZ(sec) {
  if (sec == null) return '–'
  return `${pad(new Date(sec * 1000).getUTCHours())}z`
}
function clockZ(sec) {
  if (sec == null) return '–'
  const d = new Date(sec * 1000)
  return `${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
}
const isoToSec = (iso) => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t / 1000
}
function cycleInitHour(cycle) {
  // "2026061400" -> "00z"
  if (!cycle || cycle.length < 10) return '–'
  return `${cycle.slice(8, 10)}z`
}
// "la_spezia_1km" -> "la spezia 1 km", "porto_cervo_2km" -> "porto cervo 2 km"
// (keep the resolution visible now that a venue can run at 2 km AND 1 km).
const prettyDomain = (d) => (d || '').replace(/_(\d+)km$/, ' $1 km').replace(/_/g, ' ')

// ── state pill colours ──────────────────────────────────────────────────────
const STATE_COLOR = {
  DONE: '#34D399', RUNNING: '#22D3EE', BUILDING: '#FBBF24', STARTING: '#FBBF24',
  READY: '#FBBF24', EXPORTED: '#FBBF24', FINISHING: '#FBBF24',
  WAITING: '#64748B', FAILED: '#F87171', STALLED: '#F87171',
}
const stateColor = (s) => STATE_COLOR[s] || '#94A3B8'

function Pill({ text, color }) {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 7px', borderRadius: 999, fontSize: 10.5,
      fontWeight: 700, color, background: `${color}1A`, border: `1px solid ${color}55`,
      whiteSpace: 'nowrap',
    }}>{text}</span>
  )
}

export default function ModelUpdates() {
  const [meta, setMeta] = useState({})      // modelKey -> meta | null
  const [icon, setIcon] = useState(undefined) // status.json | null | undefined(=loading)
  const [updatedAt, setUpdatedAt] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const omKeys = ROWS.filter((k) => k !== 'ICONRACE')
    const [metas, status] = await Promise.all([
      Promise.all(omKeys.map((k) => fetchModelMeta(MODELS[k]?.metaModel))),
      fetchIconRaceStatus(),
    ])
    const m = {}
    omKeys.forEach((k, i) => { m[k] = metas[i] })
    setMeta(m)
    setIcon(status)
    setUpdatedAt(new Date())
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0' }}>🛰 Model updates</span>
        <span style={{ fontSize: 11, color: '#64748B' }}>
          Latest run per model — refreshes every minute
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: '#475569' }}>
          {loading ? 'loading…' : updatedAt ? `updated ${pad(updatedAt.getHours())}:${pad(updatedAt.getMinutes())}` : ''}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={thL}>Model</th>
              <th style={thL}>Init</th>
              <th style={thL}>Started at</th>
              <th style={thL}>Status</th>
              <th style={thL}>Next run + ETA</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((k) => k === 'ICONRACE'
              ? <IconRaceRow key={k} status={icon} />
              : <OpenMeteoRow key={k} modelKey={k} meta={meta[k]} loading={loading} />)}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 10, color: '#475569', marginTop: 8, lineHeight: 1.5 }}>
        Times in UTC. Open-Meteo rows from each model’s <code style={codeStyle}>meta.json</code>;
        Icon-Race from the box’s live <code style={codeStyle}>status.json</code>.
      </div>
    </div>
  )
}

function ModelCell({ label, subtitle, color }) {
  return (
    <td style={tdL}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: color || '#475569', flexShrink: 0 }} />
        <span>
          <span style={{ fontWeight: 700, color: '#E2E8F0' }}>{label}</span>
          {subtitle && <span style={{ color: '#64748B', fontSize: 10, marginLeft: 6 }}>{subtitle}</span>}
        </span>
      </div>
    </td>
  )
}

function OpenMeteoRow({ modelKey, meta, loading }) {
  const cfg = MODELS[modelKey] || {}
  if (loading && meta === undefined) {
    return (
      <tr>
        <ModelCell label={cfg.label || modelKey} subtitle={cfg.subtitle} color={cfg.color} />
        <td style={tdMuted} colSpan={4}>loading…</td>
      </tr>
    )
  }
  if (!meta) {
    return (
      <tr>
        <ModelCell label={cfg.label || modelKey} subtitle={cfg.subtitle} color={cfg.color} />
        <td style={tdMuted} colSpan={4}>metadata unavailable</td>
      </tr>
    )
  }
  // "update due" if a newer run should already exist (cadence elapsed + 2 h grace).
  const overdue = meta.nextSec != null && nowSec() > meta.nextSec + 7200
  const statusColor = overdue ? '#FBBF24' : '#34D399'
  return (
    <tr>
      <ModelCell label={cfg.label || modelKey} subtitle={cfg.subtitle} color={cfg.color} />
      <td style={td}>{hourZ(meta.initSec)}</td>
      <td style={td}>
        {clockZ(meta.availableSec ?? meta.initSec)}
        <span style={muted}> · {relFromSec(meta.availableSec ?? meta.initSec)}</span>
      </td>
      <td style={td}><Pill text={overdue ? 'update due' : 'current'} color={statusColor} /></td>
      <td style={td}>
        {meta.nextSec != null
          ? <>{hourZ(meta.nextSec)}<span style={muted}> · {relFromSec(meta.nextSec)}</span></>
          : '–'}
      </td>
    </tr>
  )
}

function IconRaceRow({ status }) {
  const cfg = MODELS.ICONRACE
  if (status === undefined) {
    return (
      <tr style={{ background: '#0B1E33' }}>
        <ModelCell label="Icon-Race" subtitle={cfg.subtitle} color={cfg.color} />
        <td style={tdMuted} colSpan={4}>loading…</td>
      </tr>
    )
  }
  if (!status) {
    return (
      <tr style={{ background: '#0B1E33' }}>
        <ModelCell label="Icon-Race" subtitle={cfg.subtitle} color={cfg.color} />
        <td style={tdMuted} colSpan={4}>no status published yet</td>
      </tr>
    )
  }
  const startedSec = isoToSec(status.run_started)
  const nextEtaSec = isoToSec(status.next_eta)
  const overall = status.overall || '–'
  const domains = Array.isArray(status.domains) ? status.domains : []
  return (
    <tr style={{ background: '#0B1E33' }}>
      <ModelCell label="Icon-Race" subtitle={cfg.subtitle} color={cfg.color} />
      <td style={td}>{cycleInitHour(status.cycle)}</td>
      <td style={td}>
        {startedSec != null
          ? <>{clockZ(startedSec)}<span style={muted}> · {relFromSec(startedSec)}</span></>
          : '–'}
      </td>
      <td style={td}>
        <Pill text={overall} color={stateColor(overall)} />
        {domains.length > 0 && (
          <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {domains.map((d) => (
              <div key={d.domain} style={{ fontSize: 10, color: '#94A3B8', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 6, height: 6, borderRadius: 999, background: stateColor(d.state), flexShrink: 0 }} />
                <span style={{ minWidth: 78, color: '#CBD5E1' }}>{prettyDomain(d.domain)}</span>
                <span style={{ color: stateColor(d.state), fontWeight: 700 }}>
                  {d.state}{d.pct != null ? ` ${d.pct}%` : ''}
                </span>
                {d.detail && <span style={{ color: '#64748B' }}>{d.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </td>
      <td style={td}>
        {cycleInitHour(status.next_cycle)}
        {nextEtaSec != null && <span style={muted}> · ready {relFromSec(nextEtaSec)}</span>}
      </td>
    </tr>
  )
}

// ── styles ──────────────────────────────────────────────────────────────────
const card = { background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 12, padding: 14 }
const th = { padding: '6px 8px', textAlign: 'right', color: '#94A3B8', fontWeight: 600, fontSize: 11, borderBottom: '1px solid #1E3A5A' }
const thL = { ...th, textAlign: 'left' }
const td = { padding: '7px 8px', textAlign: 'left', color: '#E2E8F0', verticalAlign: 'top', borderBottom: '1px solid #0F2030', whiteSpace: 'nowrap' }
const tdL = { ...td }
const tdMuted = { ...td, color: '#64748B' }
const muted = { color: '#64748B', fontSize: 10.5 }
const codeStyle = { background: '#071624', border: '1px solid #1E3A5A', borderRadius: 3, padding: '0 4px', fontSize: 10 }

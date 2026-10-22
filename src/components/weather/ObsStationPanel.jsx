'use client'

import { useEffect, useState, useMemo } from 'react'
import { OBS_SOURCES, obs10mKn } from '../../lib/windObs'
import { kn1, barbSvg } from '../../lib/windBarb'
import { trueToMagnetic } from '../../lib/magVar'
import { niceKnMax, traceMaxKn, wrapSegments, xOf, yOf, polyline, hourTicks } from '../../lib/obsTrace'

// What one station has been doing. Opened by clicking its barb on the field map.
//
// WHY A TRACE AND NOT JUST A NUMBER. "12 kn" means one thing on a flat line and
// another on one that has climbed 6 kn in forty minutes, and the gust trace
// against the mean is how you see whether it is building or just gusty. The
// direction chart is the one that decides which end of the line to start at.
//
// The maths is all in lib/ (windBarb, obsTrace, magVar) because .jsx is not
// typechecked in this repo — see CLAUDE.md.

const BOX = { w: 340, h: 96, left: 30, right: 8, top: 8, bottom: 16 }
const AXIS = '#1E3A5A'
const INK = '#94A3B8'

function hhmm(ms) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function Axes({ t0, t1, ticks, max, unit, lines }) {
  return (
    <>
      <rect x={BOX.left} y={BOX.top} width={BOX.w - BOX.left - BOX.right} height={BOX.h - BOX.top - BOX.bottom}
            fill="none" stroke={AXIS} strokeWidth="1" />
      {lines.map((v) => (
        <g key={v}>
          <line x1={BOX.left} x2={BOX.w - BOX.right} y1={yOf(v, max, BOX)} y2={yOf(v, max, BOX)}
                stroke={AXIS} strokeWidth="1" strokeDasharray="2 3" />
          <text x={BOX.left - 4} y={yOf(v, max, BOX) + 3} textAnchor="end"
                style={{ font: '9px system-ui, sans-serif', fill: INK }}>{v}{unit}</text>
        </g>
      ))}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={xOf(t, t0, t1, BOX)} x2={xOf(t, t0, t1, BOX)} y1={BOX.h - BOX.bottom} y2={BOX.h - BOX.bottom + 3}
                stroke={AXIS} strokeWidth="1" />
          <text x={xOf(t, t0, t1, BOX)} y={BOX.h - 4} textAnchor="middle"
                style={{ font: '9px system-ui, sans-serif', fill: INK }}>{hhmm(t)}</text>
        </g>
      ))}
    </>
  )
}

export default function ObsStationPanel({ obs, hours = 6, onClose }) {
  const [points, setPoints] = useState(null)   // null = loading
  const [state, setState] = useState('loading')

  useEffect(() => {
    if (!obs?.id) return undefined
    let alive = true
    setState('loading'); setPoints(null)
    ;(async () => {
      try {
        const r = await fetch(`/api/obs/history?id=${encodeURIComponent(obs.id)}&hours=${hours}`)
        const j = await r.json()
        if (!alive) return
        if (j?.supported === false) { setState('unsupported'); setPoints([]) }
        else if (j?.failed) { setState('failed'); setPoints([]) }
        else { setPoints(Array.isArray(j?.points) ? j.points : []); setState('ok') }
      } catch {
        if (alive) { setState('failed'); setPoints([]) }
      }
    })()
    return () => { alive = false }
  }, [obs?.id, hours])

  const src = obs ? OBS_SOURCES[obs.source] : null
  const colour = src?.colour || '#94A3B8'
  const mag = obs?.twdDeg == null ? null : trueToMagnetic(obs.twdDeg, obs.lat, obs.lon)
  const v10 = obs ? obs10mKn(obs) : null

  const geom = useMemo(() => {
    const pts = points || []
    const t1 = Date.now()
    const t0 = t1 - hours * 3600_000
    const max = niceKnMax(traceMaxKn(pts))
    const xy = (p, v) => ({ x: xOf(Date.parse(p.t), t0, t1, BOX), y: yOf(v, max, BOX) })
    return {
      t0, t1, max,
      ticks: hourTicks(t0, t1),
      mean: polyline(pts.filter((p) => Number.isFinite(p.twsKn)).map((p) => xy(p, p.twsKn))),
      gust: polyline(pts.filter((p) => p.gustKn != null).map((p) => xy(p, p.gustKn))),
      dirs: wrapSegments(pts).map((seg) =>
        polyline(seg.map((s) => ({ x: xOf(s.t, t0, t1, BOX), y: yOf(s.deg, 360, BOX) })))),
    }
  }, [points, hours])

  if (!obs) return null

  return (
    <div style={{
      position: 'absolute', right: 10, top: 56, zIndex: 1000, width: 360,
      background: 'rgba(3,16,24,.96)', border: `1px solid ${colour}`, borderRadius: 8,
      padding: '10px 10px 8px', boxShadow: '0 8px 28px rgba(0,0,0,.55)',
      font: '12px system-ui, sans-serif', color: '#CBD5E1',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ width: 44, height: 44, flex: '0 0 44px' }}
             dangerouslySetInnerHTML={{ __html: barbSvg(obs.twsKn, obs.twdDeg, colour, 1) }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: '#E2E8F0', lineHeight: 1.25 }}>{obs.name}</div>
          <div style={{ color: colour, fontSize: 11 }}>{src?.label || obs.source}</div>
        </div>
        <button onClick={onClose} aria-label="Close"
                style={{ background: 'none', border: 'none', color: INK, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
      </div>

      {/* The numbers, to one decimal. Magnetic beside true, because magnetic is
          what the compass on the boat reads — and it is OMITTED, not defaulted,
          when the variation is unknown. */}
      <div style={{ display: 'flex', gap: 14, margin: '8px 0 2px', alignItems: 'baseline' }}>
        <div><span style={{ font: '700 20px system-ui', color: '#E2E8F0' }}>{kn1(obs.twsKn)}</span>
          <span style={{ fontSize: 11, color: INK }}> kn</span></div>
        <div><span style={{ fontSize: 11, color: INK }}>gust </span>
          <span style={{ font: '700 14px system-ui', color: '#E2E8F0' }}>{kn1(obs.gustKn)}</span>
          <span style={{ fontSize: 11, color: INK }}> kn</span></div>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <span style={{ font: '700 14px system-ui', color: '#E2E8F0' }}>
            {obs.twdDeg == null ? 'variable' : `${Math.round(obs.twdDeg)}°T`}
          </span>
          {mag != null && (
            <span style={{ font: '700 14px system-ui', color: colour }}>{` / ${Math.round(mag)}°M`}</span>
          )}
        </div>
      </div>

      <div style={{ fontSize: 10.5, color: INK, marginBottom: 6 }}>
        {obs.heightM == null
          ? 'anemometer height not published — shown as measured, not corrected to 10 m'
          : (v10 != null && Math.abs(obs.heightM - 10) >= 0.5
            ? `measured at ${obs.heightM} m · ${kn1(v10)} kn at 10 m`
            : 'measured at 10 m — directly comparable')}
      </div>

      {state === 'loading' && <div style={{ color: INK, padding: '14px 0' }}>loading last {hours} h…</div>}
      {state === 'unsupported' && <div style={{ color: INK, padding: '10px 0' }}>
        No history feed for this network yet — the reading above is current.
      </div>}
      {state === 'failed' && <div style={{ color: '#F59E0B', padding: '10px 0' }}>
        History unavailable just now. The reading above is current.
      </div>}
      {state === 'ok' && points.length === 0 && <div style={{ color: INK, padding: '10px 0' }}>
        Nothing reported in the last {hours} h.
      </div>}

      {state === 'ok' && points.length > 0 && (
        <>
          <div style={{ fontSize: 10.5, color: INK, marginTop: 2 }}>
            wind &amp; gust, last {hours} h
          </div>
          <svg width={BOX.w} height={BOX.h} role="img" aria-label="wind speed and gust">
            <Axes t0={geom.t0} t1={geom.t1} ticks={geom.ticks} max={geom.max} unit=""
                  lines={[0, geom.max / 2, geom.max].map((v) => Math.round(v))} />
            {geom.gust && <polyline points={geom.gust} fill="none" stroke={colour} strokeWidth="1"
                                    strokeDasharray="3 2" opacity="0.75" />}
            {geom.mean && <polyline points={geom.mean} fill="none" stroke={colour} strokeWidth="1.8" />}
          </svg>

          <div style={{ fontSize: 10.5, color: INK, marginTop: 4 }}>direction (true)</div>
          <svg width={BOX.w} height={BOX.h} role="img" aria-label="wind direction">
            <Axes t0={geom.t0} t1={geom.t1} ticks={geom.ticks} max={360} unit="°"
                  lines={[0, 90, 180, 270, 360]} />
            {/* One polyline per run: the series is cut where it crosses the
                0/360 wrap, so a veer through north does not draw a line down
                the whole chart. */}
            {geom.dirs.map((d, i) => (
              <polyline key={i} points={d} fill="none" stroke={colour} strokeWidth="1.8" />
            ))}
          </svg>
        </>
      )}
    </div>
  )
}

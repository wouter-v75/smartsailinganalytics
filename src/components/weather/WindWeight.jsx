// WindWeight.jsx — hourly "wind weight" for the racing window, from the box's
// per-venue windweight.json (rig-integrated ½ρV² vs a standard day). Shows the
// WW% strip (Light/Standard/Heavy), effective TWS, and — on hover — the four
// sub-factors and the modelled V(z) rig profile. See src/lib/windweight.ts /
// scripts/common/windweight.py.

import React, { useEffect, useMemo, useState } from 'react'
import { fetchWindweight } from './openMeteo'

const CLS_COLOR = { Light: '#7DD3FC', Standard: '#1D9E75', Heavy: '#F97316' }
const clsColor = (c) => CLS_COLOR[c] || '#94A3B8'
const pad = (n) => String(n).padStart(2, '0')

// hh:mm (local) from an ISO "...Z" time, shifted by the venue tz offset (min).
function hm(t, tzOffMin = 0) {
  const d = new Date(t)
  if (isNaN(d)) return '--'
  const ms = d.getTime() + tzOffMin * 60000
  const x = new Date(ms)
  return `${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`
}

export default function WindWeight({ domain, venue, tzOffsetMin = 0, windowHours }) {
  const [data, setData] = useState(undefined) // undefined=loading, null=none
  const [sel, setSel] = useState(null)

  useEffect(() => {
    let cancelled = false
    setData(undefined)
    fetchWindweight(domain, venue).then((d) => { if (!cancelled) setData(d) })
    return () => { cancelled = true }
  }, [domain, venue])

  const hours = useMemo(() => {
    const hs = (data && Array.isArray(data.hours)) ? data.hours : []
    if (!windowHours) return hs
    // optional filter to a [startHourLocal, endHourLocal] racing window
    const [lo, hi] = windowHours
    return hs.filter((h) => {
      const x = new Date(new Date(h.t).getTime() + tzOffsetMin * 60000)
      const hr = x.getUTCHours() + x.getUTCMinutes() / 60
      return hr >= lo && hr <= hi
    })
  }, [data, windowHours, tzOffsetMin])

  if (data === undefined) return <Shell><span style={{ fontSize: 11, color: '#8A97A9' }}>loading…</span></Shell>
  if (!data || hours.length === 0) return null

  const cur = sel != null ? hours[sel] : null
  const maxWW = Math.max(120, ...hours.map((h) => h.WW || 0))

  return (
    <Shell>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: '#E2E8F0' }}>🪶 Wind weight</span>
        <span style={{ fontSize: 10, color: '#8A97A9' }}>rig load vs a standard day · 100 = standard</span>
      </div>

      {/* hourly bars */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 84, marginBottom: 4 }}>
        {hours.map((h, i) => {
          const pct = Math.max(4, Math.min(100, (h.WW / maxWW) * 100))
          const active = sel === i
          return (
            <div key={h.t} onMouseEnter={() => setSel(i)} onFocus={() => setSel(i)}
              onMouseLeave={() => setSel((s) => (s === i ? null : s))}
              title={`${hm(h.t, tzOffsetMin)} · WW ${h.WW}% ${h.cls} · V_eff ${h.V_eff}kt`}
              style={{ flex: 1, minWidth: 6, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
                alignItems: 'center', cursor: 'pointer', height: '100%' }}>
              <span style={{ fontSize: 8, color: active ? '#E2E8F0' : '#475569', marginBottom: 2 }}>{Math.round(h.WW)}</span>
              <div style={{ width: '80%', height: `${pct}%`, borderRadius: 3, background: clsColor(h.cls),
                opacity: active ? 1 : 0.8, outline: active ? '1px solid #E2E8F0' : 'none' }} />
            </div>
          )
        })}
      </div>
      {/* 100% reference line marker + hour labels */}
      <div style={{ display: 'flex', gap: 3, marginBottom: 6 }}>
        {hours.map((h) => (
          <span key={h.t} style={{ flex: 1, minWidth: 6, textAlign: 'center', fontSize: 7, color: '#4E5D71', fontFamily: 'monospace' }}>
            {hm(h.t, tzOffsetMin).slice(0, 2)}
          </span>
        ))}
      </div>

      {/* selected-hour breakdown */}
      {cur && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', borderTop: '1px solid #0F2030', paddingTop: 8 }}>
          <div style={{ minWidth: 120 }}>
            <div style={{ fontSize: 11, color: '#94A3B8' }}>{hm(cur.t, tzOffsetMin)} local</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: clsColor(cur.cls) }}>{cur.WW}% <span style={{ fontSize: 12 }}>{cur.cls}</span></div>
            <div style={{ fontSize: 11, color: '#CBD5E1' }}>V_H {cur.V_H} kt → weighs like <b>{cur.V_eff} kt</b></div>
          </div>
          <div style={{ fontSize: 10, color: '#8A97A9', display: 'grid', gridTemplateColumns: 'auto auto', gap: '2px 10px', alignContent: 'start' }}>
            {cur.factors && Object.entries(cur.factors).map(([k, v]) => (
              <React.Fragment key={k}>
                <span style={{ color: '#64748B' }}>{k}</span>
                <span style={{ color: v > 1.02 ? '#F97316' : v < 0.98 ? '#7DD3FC' : '#CBD5E1', fontFamily: 'monospace' }}>{Number(v).toFixed(2)}</span>
              </React.Fragment>
            ))}
          </div>
          {/* mini V(z) rig profile */}
          {Array.isArray(cur.profile) && cur.profile.length > 1 && (
            <ProfileMini profile={cur.profile} />
          )}
        </div>
      )}
    </Shell>
  )
}

function ProfileMini({ profile }) {
  const W = 70, H = 70
  const zMax = 34, vMax = Math.max(...profile.map((p) => p.V)) * 1.05 || 1
  const pts = profile.map((p) => `${(p.V / vMax) * (W - 8) + 4},${H - (p.z / zMax) * (H - 6) - 3}`).join(' ')
  return (
    <svg width={W} height={H} style={{ border: '1px solid #1E3A5A', borderRadius: 4, background: '#071624' }}>
      <polyline points={pts} fill="none" stroke="#06B6D4" strokeWidth="1.5" />
      {profile.map((p) => (
        <circle key={p.z} cx={(p.V / vMax) * (W - 8) + 4} cy={H - (p.z / zMax) * (H - 6) - 3} r="1.6" fill="#7DD3FC" />
      ))}
      <text x="3" y="9" fill="#334155" fontSize="7">34m</text>
      <text x="3" y={H - 2} fill="#334155" fontSize="7">deck · V(z)</text>
    </svg>
  )
}

function Shell({ children }) {
  return (
    <div style={{ background: '#0A1929', border: '1px solid #1E3A5A', borderRadius: 10, padding: 12 }}>
      {children}
    </div>
  )
}

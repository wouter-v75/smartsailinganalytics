'use client'
// src/components/boat/LidarPhaseCard.tsx
// ─────────────────────────────────────────────────────────────────────────────
// What the lidar measured of ONE sail, on one day, in one wind band.
//
// Opened from the Lidar column of the sail-media grid, where a button stands for
// every 30 s phase behind it. A phase on its own is not worth looking at — half
// a minute of a sail — so what is shown is the set: camber, draft and twist at
// 25 / 50 / 75 % of the leech, averaged across the phases, beside the TARGETS
// logged next to them.
//
// It reads the day's phases back from the API and filters them here rather than
// carrying numbers through the grid, because the grid's job is to say WHERE the
// measurements are and this one's is to say what they were. The averaging and
// the filtering are KND's own, out of lidarTables — the same code the Lidar
// report tab uses, so a number here and a number there cannot disagree.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react'
import { expandPhases, type StoredPhase } from '@/lib/seasonCurves'
import type { PhaseStat } from '@/lib/phaseStats'
import { LIDAR_VARS, LIDAR_HEIGHTS, measKey, targKey, type LidarSail } from '@/lib/lidarTables'
import { twsBand } from '@/lib/sailMedia'

const C = { bg: '#071726', border: '#12324f', head: '#E2E8F0', dim: '#7c8ca0', lidar: '#C084FC' }

/** Mean of the numbers that are there, or null when none are. */
export function meanOf(values: (number | null | undefined)[]): number | null {
  const ns = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return ns.length ? ns.reduce((s, v) => s + v, 0) / ns.length : null
}

/** The phases this button stands for: same day, same band, carrying this sail. */
export function phasesFor(all: PhaseStat[], sail: LidarSail, bandKey: string): PhaseStat[] {
  return all.filter((p) => {
    if (twsBand(p.mean.tws ?? null).key !== bandKey) return false
    return LIDAR_VARS.some((v) => LIDAR_HEIGHTS.some((h) => {
      const x = p.mean[measKey(sail, v.v, h)]
      return typeof x === 'number' && Number.isFinite(x)
    }))
  })
}

export default function LidarPhaseCard({
  teamId, boatId, date, sail, bandKey, event, expected, onClose,
}: {
  teamId: string
  boatId: string
  date: string
  sail: LidarSail
  bandKey: string
  event?: string | null
  /** How many phases the grid counted, so a disagreement is visible rather than
   *  quietly resolved in favour of whichever number was fetched last. */
  expected?: number
  onClose: () => void
}) {
  const [phases, setPhases] = React.useState<PhaseStat[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let dead = false
    setPhases(null); setError(null)
    void (async () => {
      try {
        const r = await fetch(`/api/teams/${teamId}/boats/${boatId}/phase-stats/${date}?full=1`)
        if (!r.ok) throw new Error(`the day's phases could not be read (${r.status})`)
        const j = (await r.json()) as { stats?: { phases?: StoredPhase[] } | null }
        if (!dead) setPhases(phasesFor(expandPhases(j.stats?.phases ?? []), sail, bandKey))
      } catch (e) {
        if (!dead) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { dead = true }
  }, [teamId, boatId, date, sail, bandKey])

  const band = twsBand(null).key === bandKey ? 'TWS unknown' : bandKey

  return (
    <div
      role="dialog" aria-label="Lidar phases" data-testid="lidar-phase-card"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(2,8,16,0.72)', display: 'grid', placeItems: 'center', zIndex: 60, padding: 16 }}
    >
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, maxWidth: 560, width: '100%', maxHeight: '86vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, color: C.lidar, textTransform: 'uppercase' }}>Lidar</div>
          <div style={{ fontSize: 12, color: C.head }}>{event || date}</div>
          <div style={{ fontSize: 11, color: C.dim }}>{date} · {band}</div>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, color: C.head, padding: '3px 9px', cursor: 'pointer', fontSize: 12 }}>Close</button>
        </div>

        {error && <div style={{ fontSize: 12, color: '#FCA5A5', lineHeight: 1.5 }}>{error}</div>}
        {!error && !phases && <div style={{ fontSize: 12, color: C.dim }}>Reading the day&rsquo;s phases…</div>}

        {phases && (
          <>
            <div style={{ fontSize: 11, color: C.dim, marginBottom: 8, lineHeight: 1.5 }}>
              Averaged across <b style={{ color: C.head }}>{phases.length}</b> phase{phases.length === 1 ? '' : 's'}
              {' '}of 30 s, with the target logged beside each.
              {expected != null && expected !== phases.length && (
                <span style={{ color: '#FCD34D' }}>
                  {' '}The grid counted {expected} — it also requires the sail to have been UP, which this
                  card does not check, so the difference is phases the instrument measured while it was down.
                </span>
              )}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thS}>Height</th>
                  {LIDAR_VARS.map((v) => <th key={v.v} style={thS}>{v.label}</th>)}
                  {LIDAR_VARS.map((v) => <th key={`t${v.v}`} style={{ ...thS, color: C.dim }}>{v.short} target</th>)}
                </tr>
              </thead>
              <tbody>
                {LIDAR_HEIGHTS.map((h) => (
                  <tr key={h} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={{ ...tdS, color: C.dim }}>{h} %</td>
                    {LIDAR_VARS.map((v) => (
                      <td key={v.v} style={{ ...tdS, color: C.lidar }}>{fmt(meanOf(phases.map((p) => p.mean[measKey(sail, v.v, h)])), v.v)}</td>
                    ))}
                    {LIDAR_VARS.map((v) => (
                      <td key={`t${v.v}`} style={{ ...tdS, color: C.dim }}>{fmt(meanOf(phases.map((p) => p.mean[targKey(sail, v.v, h)])), v.v)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!phases.length && (
              <div style={{ fontSize: 11.5, color: '#FCD34D', marginTop: 8, lineHeight: 1.5 }}>
                Nothing in this band on that day. The day&rsquo;s phases may have been rebuilt since the
                grid was drawn — reopen the sail to refresh it.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const thS: React.CSSProperties = { textAlign: 'right', padding: '0 0 4px 9px', fontSize: 10, color: C.head, fontWeight: 700, whiteSpace: 'nowrap' }
const tdS: React.CSSProperties = { textAlign: 'right', padding: '3px 0 3px 9px', fontSize: 12, fontFamily: 'monospace', fontWeight: 700 }

/** Twist is an angle; camber and draft are percentages. */
const fmt = (v: number | null, kind: string) =>
  v == null ? '—' : kind === 'Tw' ? `${v.toFixed(1)}°` : `${v.toFixed(1)} %`

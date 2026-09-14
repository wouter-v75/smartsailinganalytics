// src/lib/lidarMerge.ts
// ─────────────────────────────────────────────────────────────────────────────
// Lidar phase means live inside the day's stored phase stats (session_phase_stats
// .phases[].v), but they often come from a different log than the rest: a 4 Hz
// start-window lidar log (scripts/lidar-import.ts) covers minutes to an hour of a
// day whose stats come from the full-day log. So lidar is merged into the phases it
// overlaps, matched on the phase start (both come from the same event file), and
// carried over whenever the rest of the stats are recomputed from a log without it.
// ─────────────────────────────────────────────────────────────────────────────

import { isLidarKey } from './flatLogParse'
import type { PhaseStat } from './phaseStats'
import type { StoredPhase } from './seasonCurves'

type Values = Record<string, number | null | undefined>

const lidarOf = (rec: Values | null | undefined): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(rec || {})) if (isLidarKey(k) && typeof v === 'number' && Number.isFinite(v)) out[k] = v
  return out
}
const hasAny = (rec: Values | null | undefined) => Object.keys(lidarOf(rec)).length > 0

// Stored → stored: phases being stored keep the lidar of the phases they replace, unless
// they bring their own.
export function carryLidar(into: StoredPhase[], from: StoredPhase[] | null | undefined): StoredPhase[] {
  if (!from?.length) return into
  const old = new Map(from.filter(p => hasAny(p.v)).map(p => [p.u, p]))
  if (!old.size) return into
  return into.map(p => {
    const o = old.get(p.u)
    if (!o || hasAny(p.v)) return p
    return { ...p, v: { ...p.v, ...lidarOf(o.v) }, x: { ...(p.x || {}), ...lidarOf(o.x) } }
  })
}

// Stored → computed: charts computed on a device from a log without lidar still show the
// lidar stored for the day.
export function mergeStoredLidar(stats: PhaseStat[], stored: StoredPhase[] | null | undefined): PhaseStat[] {
  if (!stored?.length || stats.some(s => hasAny(s.mean))) return stats
  const byStart = new Map(stored.filter(p => hasAny(p.v)).map(p => [p.u, p]))
  if (!byStart.size) return stats
  return stats.map(s => {
    const p = byStart.get(s.utc)
    return p ? { ...s, mean: { ...s.mean, ...lidarOf(p.v) }, max: { ...s.max, ...lidarOf(p.x) } } : s
  })
}

// Lidar log → stored: the lidar means of freshly computed phases (compactPhases rounding)
// replace those of the stored phases with the same start. Returns how many phases took lidar.
export function addLidar(into: StoredPhase[], lidar: StoredPhase[]): { phases: StoredPhase[]; merged: number } {
  const byStart = new Map(lidar.filter(p => hasAny(p.v)).map(p => [p.u, p]))
  let merged = 0
  const phases = into.map(p => {
    const l = byStart.get(p.u)
    if (!l) return p
    merged++
    const strip = (rec: Values | undefined) => Object.fromEntries(Object.entries(rec || {}).filter(([k]) => !isLidarKey(k)))
    return { ...p, v: { ...strip(p.v), ...lidarOf(l.v) }, x: { ...strip(p.x), ...lidarOf(l.x) } } as StoredPhase
  })
  return { phases, merged }
}

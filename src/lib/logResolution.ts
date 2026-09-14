// src/lib/logResolution.ts
// ─────────────────────────────────────────────────────────────────────────────
// Sample rate of an imported log, and the 1 Hz copy kept of a faster one.
//
// The 2026-09 lidar export logs at 4 Hz with ~130 channels a row: a 4 h day is
// ~190 MB of CSV and ~350 MB of rows in memory. Everything downstream (charts,
// video/photo enrichment, the Bunny archive, desktop boot, which loads every day's
// log) was built around 1 Hz logs. So the import computes phase stats, lidar
// means and tack/gybe metrics from EVERY row and stores them (phaseStatsUpload),
// then keeps a 1 Hz copy of the log. Analytics prefers the stored 0.25 s stats
// over anything recomputed from that copy (seasonCurves.preferStored).
// ─────────────────────────────────────────────────────────────────────────────

import { medianInterval } from './seasonCurves'
import { isLidarKey } from './flatLogParse'
import { LIDAR_SAILS } from './lidarTables'

// Rows per second, to 1 dp (4 for the lidar export, 1 for the regular one).
export function logRateHz(rows: { utc: number }[] | null | undefined): number | null {
  const s = medianInterval(rows)
  return s ? Math.round(10 / s) / 10 : null
}

// Faster than 1 Hz by enough to be worth thinning (not a 1 Hz log with jitter).
export const isSubSecondLog = (rows: { utc: number }[] | null | undefined) => (logRateHz(rows) ?? 0) >= 1.5

// The first row of every UTC second: a real sample, not an average, so the copy
// reads like a 1 Hz export. Rows are chronological.
export function thinToOneHz<T extends { utc: number }>(rows: T[]): T[] {
  const out: T[] = []
  let sec = -Infinity
  for (const r of rows) {
    const s = Math.floor(r.utc / 1000)
    if (s !== sec) { out.push(r); sec = s }
  }
  return out
}

// Sails the log carries measured lidar shape for, in report order.
export function lidarSailsIn(rows: Record<string, unknown>[] | null | undefined) {
  if (!rows?.length) return []
  const found = new Set<string>()
  const step = Math.max(1, Math.floor(rows.length / 500))
  for (let i = 0; i < rows.length; i += step) {
    for (const k in rows[i]) {
      if (k[0] !== 't' && isLidarKey(k) && rows[i][k] != null) found.add(k.replace(/(Ca|Tw|Dr|Tr)\d+$/, ''))
    }
  }
  return LIDAR_SAILS.filter(s => found.has(s.sail))
}

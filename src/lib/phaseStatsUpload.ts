// src/lib/phaseStatsUpload.ts
// ─────────────────────────────────────────────────────────────────────────────
// Browser side of full-resolution stats: a device that holds the FULL log (the
// importing device — the cloud copy keeps a row every ~6 s) computes the phase
// stats and tack/gybe metrics from every row and stores them, so every other
// device reads those instead of recomputing from the coarse copy. The server
// (POST …/phase-stats/:date) only accepts them when they are finer than, or newer
// than, what is stored.
// ─────────────────────────────────────────────────────────────────────────────

import { computePhaseStats, type LogRow } from './phaseStats'
import { analyseManoeuvres } from './manoeuvres'
import { polarFromData } from './polarFile'
import { compactPhases, compactManoeuvres, medianInterval } from './seasonCurves'

export interface UploadResult {
  stored: boolean
  reason?: string
  phases: number
  manoeuvres: number
  resolution: number | null
}

export async function uploadSessionStats(input: {
  teamId: string
  boatId: string
  date: string
  rows: LogRow[]
  xml: any
  polar?: any            // prepared polar; fetched when not given
  polarId?: string | null
}): Promise<UploadResult> {
  let { polar, polarId } = input
  if (polar === undefined) {
    const r = await fetch(`/api/teams/${input.teamId}/polars?boat_id=${input.boatId}&active=1`)
    const row = r.ok ? ((await r.json()).polars || [])[0] : null
    polar = polarFromData(row?.data)
    polarId = polar ? row.id : null
  }

  const stats = computePhaseStats(input.rows, input.xml, { polar })
  const manoeuvres = analyseManoeuvres(input.rows, input.xml)
  const resolution = medianInterval(input.rows)
  const summary = { phases: stats.length, manoeuvres: manoeuvres.length, resolution }
  if (!stats.length || resolution == null) return { stored: false, reason: 'no phases in the log', ...summary }

  const res = await fetch(`/api/teams/${input.teamId}/boats/${input.boatId}/phase-stats/${input.date}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phases: compactPhases(stats),
      manoeuvres: compactManoeuvres(manoeuvres),
      resolution_s: resolution,
      log_rows: input.rows.length,
      polar_id: polarId ?? null,
    }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) return { stored: false, reason: j.error || `HTTP ${res.status}`, ...summary }
  return { stored: !!j.computed, reason: j.computed ? undefined : j.reason, ...summary }
}

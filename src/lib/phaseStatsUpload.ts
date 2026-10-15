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
import { compactPhases, compactManoeuvres, medianInterval, phasesNotOfDay } from './seasonCurves'

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

  // THE DATE AND THE LOG ARE TWO SEPARATE ARGUMENTS and nothing here ever tied them
  // together. Both callers can hold the two apart for a moment: loadDate() sets the
  // new activeDate and only then awaits the new day's log out of IndexedDB, and
  // handleImported() sets the imported day's log and only then awaits a getUser()
  // before switching the date. An effect firing inside either window gets this day's
  // date with the LAST day's log — and that is how three rows came to hold a
  // neighbouring day's phases, each a full-resolution copy filed one or two days out.
  //
  // The phases carry their own epochs, so the contradiction is right here in the
  // arguments. Refuse it, and say which day the log is, rather than storing a day's
  // sailing under another day's name where nothing downstream can tell.
  const compact = compactPhases(stats)
  const offDay = phasesNotOfDay(input.date, compact)
  if (offDay) return { stored: false, reason: `the log on this device is not ${input.date}'s — ${offDay}`, ...summary }

  const res = await fetch(`/api/teams/${input.teamId}/boats/${input.boatId}/phase-stats/${input.date}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phases: compact,
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

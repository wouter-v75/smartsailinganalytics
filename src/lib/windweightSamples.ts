// windweightSamples.ts — the MOS producer. When a session's log (with on-board
// air-temp / sea-temp / RH) is available, build one hourly sample per hour that
// joins the FORECAST windweight (box product at the boat's venue) with the
// OBSERVED windweight (from the on-board sensors) and the upwind heel residual
// (Δheel = heel − targHeel), then upsert into windweight_samples for later
// calculated-vs-observed analysis. Idempotent per (boat, hour). Best-effort:
// never throws into the caller.

import { getBrowserSupabase } from './supabase/browser'
import { windweightObserved } from './windweight'
import { fetchWindweightNearest } from '../components/weather/openMeteo'

interface LogRow {
  utc?: number | null; lat?: number | null; lon?: number | null
  tws?: number | null; airTemp?: number | null; seaTemp?: number | null
  rh?: number | null; baro?: number | null
  twa?: number | null; heel?: number | null; targHeel?: number | null
}

const localHour = (ms: number, offMin: number) => new Date(ms + offMin * 60000).getUTCHours()
const localDate = (ms: number, offMin: number) => new Date(ms + offMin * 60000).toISOString().slice(0, 10)

export interface StoreArgs {
  logData: { rows?: LogRow[] } | null
  sessionDate: string          // YYYY-MM-DD (venue-local)
  teamId: string
  boatId: string
  sessionId?: string | null
  tzOffsetMin?: number         // venue-local minus UTC, minutes
  mastHeight?: number
}

export async function storeWindweightSamples(a: StoreArgs): Promise<{ n: number; error?: string }> {
  const rows = a.logData?.rows
  if (!rows?.length || !a.teamId || !a.boatId || !a.sessionDate) return { n: 0 }
  // Only bother if the log actually carries the on-board sensors we need.
  const hasObs = rows.some((r) => r.airTemp != null && r.seaTemp != null)
  if (!hasObs) return { n: 0 }

  const tz = a.tzOffsetMin ?? 0
  const H = a.mastHeight ?? 34

  // mean boat position → nearest SSA-Race venue (for the forecast product)
  let latS = 0, lonS = 0, np = 0
  for (const r of rows) { if (r.lat != null && r.lon != null) { latS += r.lat; lonS += r.lon; np++ } }
  const near = np ? await fetchWindweightNearest(latS / np, lonS / np).catch(() => null) : null
  const ven = near ? { domain: near.domain, venue: near.venue } : null
  const fc = near?.data ?? null
  const fcByHour: Record<number, { WW: number; V_eff: number; cls: string; factors: unknown; inputs: unknown }> = {}
  if (fc && Array.isArray((fc as { hours?: unknown[] }).hours)) {
    for (const h of (fc as { hours: Array<{ t: string; WW: number; V_eff: number; cls: string; factors: unknown; inputs: unknown }> }).hours) {
      const ms = Date.parse(h.t)
      if (!isNaN(ms) && localDate(ms, tz) === a.sessionDate) fcByHour[localHour(ms, tz)] = h
    }
  }

  // bucket the log by local hour (06..21 to be safe)
  type Acc = { tws: [number, number]; at: [number, number]; st: [number, number]; rh: [number, number]; bp: [number, number]; dheel: [number, number]; twa: [number, number]; heel: [number, number]; th: [number, number]; n: number }
  const bins: Record<number, Acc> = {}
  for (const r of rows) {
    if (r.utc == null || localDate(r.utc, tz) !== a.sessionDate) continue
    const hr = localHour(r.utc, tz)
    if (hr < 6 || hr > 21) continue
    const b = (bins[hr] ||= { tws: [0, 0], at: [0, 0], st: [0, 0], rh: [0, 0], bp: [0, 0], dheel: [0, 0], twa: [0, 0], heel: [0, 0], th: [0, 0], n: 0 })
    const push = (k: keyof Acc, v: number | null | undefined) => { if (v != null && v === v) { (b[k] as [number, number])[0] += v; (b[k] as [number, number])[1]++ } }
    push('tws', r.tws); push('at', r.airTemp); push('st', r.seaTemp); push('rh', r.rh); push('bp', r.baro); push('twa', r.twa); push('heel', r.heel); push('th', r.targHeel)
    if (r.twa != null && Math.abs(r.twa) < 55 && r.heel != null && r.targHeel != null) { b.dheel[0] += r.heel - r.targHeel; b.dheel[1]++ }
    b.n++
  }
  const avg = (x: [number, number]) => (x[1] ? x[0] / x[1] : null)

  const localMidnightUtc = Date.parse(a.sessionDate + 'T00:00:00Z') - tz * 60000
  const samples: Record<string, unknown>[] = []
  for (const hrStr of Object.keys(bins)) {
    const hr = Number(hrStr); const b = bins[hr]
    const tws = avg(b.tws), at = avg(b.at), st = avg(b.st)
    let rh = avg(b.rh); if (rh != null && rh > 1.5) rh /= 100
    const bp = avg(b.bp)
    const f = fcByHour[hr]
    const obs = (tws != null && at != null && st != null)
      ? windweightObserved({ vHKt: tws, airTC: at, sstC: st, rhFrac: rh ?? 0.6, pHpa: bp ?? 1015, H })
      : null
    if (!obs && !f) continue
    samples.push({
      team_id: a.teamId, boat_id: a.boatId, session_id: a.sessionId ?? null,
      ts: new Date(localMidnightUtc + hr * 3600000).toISOString(), session_date: a.sessionDate,
      obs_tws_kt: tws, obs_air_t: at, obs_sea_t: st, obs_rh: rh, obs_baro: bp,
      obs_ww: obs?.ww ?? null, obs_veff: obs?.vEff ?? null, obs_factors: obs?.factors ?? null, obs_inputs: obs?.inputs ?? null,
      fc_ww: f?.WW ?? null, fc_veff: f?.V_eff ?? null, fc_cls: f?.cls ?? null, fc_factors: f?.factors ?? null, fc_inputs: f?.inputs ?? null,
      fc_cycle: (fc as { cycle?: string } | null)?.cycle ?? null, fc_venue: ven?.venue ?? null,
      twa: avg(b.twa), heel: avg(b.heel), targ_heel: avg(b.th), d_heel: avg(b.dheel), upwind: b.dheel[1] > 0, n_samples: b.n,
    })
  }
  if (!samples.length) return { n: 0 }

  try {
    const { error } = await getBrowserSupabase()
      .from('windweight_samples')
      .upsert(samples, { onConflict: 'boat_id,ts' })
    if (error) return { n: 0, error: error.message }
  } catch (e) {
    return { n: 0, error: String((e as Error)?.message || e) }
  }
  return { n: samples.length }
}

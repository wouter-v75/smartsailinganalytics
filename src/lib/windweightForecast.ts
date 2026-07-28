// windweightForecast.ts — archive the 1 km SSA-Race wind-weight FORECAST on its
// own (independent of any boat/session). Whenever the app fetches a venue's
// published windweight.json, upsert its hourly series into windweight_forecast
// so we accumulate a venue-by-venue, day-by-day record of the modelled rig-load
// index for later analysis. Idempotent per (domain, venue, valid-hour); the
// latest cycle wins. Best-effort: never throws into the caller.

import { getBrowserSupabase } from './supabase/browser'

interface WWHour {
  t?: string
  WW?: number | null
  V_eff?: number | null
  V_H?: number | null
  cls?: string | null
  factors?: unknown
  inputs?: unknown
}
interface WWProduct { cycle?: string | null; hours?: WWHour[] | null }

export async function storeWindweightForecast(a: {
  domain?: string | null
  venue?: string | null
  fc: WWProduct | null
}): Promise<{ n: number; error?: string }> {
  const { domain, venue, fc } = a
  if (!domain || !venue || !fc || !Array.isArray(fc.hours) || !fc.hours.length) return { n: 0 }
  const cycle = fc.cycle ?? null

  const rows: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const h of fc.hours) {
    if (!h || !h.t) continue
    const ms = Date.parse(h.t)
    if (isNaN(ms)) continue
    const ts = new Date(ms).toISOString()
    if (seen.has(ts)) continue          // one row per valid hour
    seen.add(ts)
    rows.push({
      domain, venue, ts, cycle,
      ww: h.WW ?? null,
      v_eff: h.V_eff ?? null,
      v_h: h.V_H ?? null,
      cls: h.cls ?? null,
      factors: h.factors ?? null,
      inputs: h.inputs ?? null,
    })
  }
  if (!rows.length) return { n: 0 }

  try {
    const { error } = await getBrowserSupabase()
      .from('windweight_forecast')
      .upsert(rows, { onConflict: 'domain,venue,ts' })
    if (error) return { n: 0, error: error.message }
  } catch (e) {
    return { n: 0, error: String((e as Error)?.message || e) }
  }
  return { n: rows.length }
}

// src/lib/scanEnrich.ts
// ─────────────────────────────────────────────────────────────────────────────
// Derive the display tags + window averages for a SailScan from the day's log
// and event file: point-of-sail (from TWA), the sail(s) hoisted at the capture
// (from the event-file SailsUp timeline), the location, and the 2-min average
// TWS/TWA. Pure — callers supply the day's log rows + parsed event XML.
// ─────────────────────────────────────────────────────────────────────────────

import { computeScanWindow } from './scanConditions'

export type PointOfSail = 'upwind' | 'reaching' | 'downwind' | null

// |TWA| < 70 upwind · 70–140 reaching · > 140 downwind.
export function pointOfSail(twa: number | null | undefined): PointOfSail {
  if (twa == null || Number.isNaN(twa)) return null
  const a = Math.abs(twa)
  if (a < 70) return 'upwind'
  if (a > 140) return 'downwind'
  return 'reaching'
}

// The sails hoisted at `utc` from the event file's SailsUp timeline (the last
// SailsUp event at or before the capture). Names like "MAIN_2026", "J1.5_2026".
export function activeSailsAt(xml: any, utc: number): string[] {
  const evs: any[] = xml?.sailsUpEvents || []
  let best: any = null
  for (const e of evs) {
    if (e?.utc != null && e.utc <= utc && (!best || e.utc > best.utc)) best = e
  }
  return Array.isArray(best?.sails) ? best.sails : []
}

export function eventLocation(xml: any): string | null {
  return xml?.meta?.location || null
}

export interface ScanTags {
  avgTws: number | null
  avgTwa: number | null
  pointOfSail: PointOfSail
  activeSails: string[]
  location: string | null
}

export function enrichScan(scan: any, dayLogRows: any[] | null, dayXml: any): ScanTags {
  const ms = scan?.captured_at ? new Date(scan.captured_at).getTime() : NaN
  const win = Array.isArray(dayLogRows) && dayLogRows.length && Number.isFinite(ms)
    ? computeScanWindow(dayLogRows, ms, 120)
    : null
  const avgTws = win?.averages?.tws ?? (scan?.tws_kn ?? null)
  const avgTwa = win?.averages?.twa ?? null
  return {
    avgTws,
    avgTwa,
    pointOfSail: pointOfSail(avgTwa),
    activeSails: Number.isFinite(ms) ? activeSailsAt(dayXml, ms) : [],
    location: eventLocation(dayXml),
  }
}

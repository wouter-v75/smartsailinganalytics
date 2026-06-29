// src/lib/tzFromCoords.ts
// ─────────────────────────────────────────────────────────────────────────────
// Derive the LOCAL / venue timezone offset from a GPS position, DST-aware.
//
// Logs are stored in true UTC and rendered in local time (sessionTzOffset). The
// log file itself carries no timezone, but every row has Lat/Lon — so we can
// resolve the venue's IANA zone from the position (tz-lookup, offline coastline
// data) and then compute the offset FOR THE LOG'S DATE via Intl, which handles
// DST automatically (La Spezia = CEST/+120 in summer, +60 in winter; Solent =
// BST/+60 in summer). This removes the manual-timezone trap entirely.
// ─────────────────────────────────────────────────────────────────────────────

// @ts-ignore — tz-lookup ships no type declarations; CJS default export is a fn.
import tzlookup from 'tz-lookup'

// Offset (minutes east of UTC) of an IANA zone at a given instant. DST-aware
// because it asks Intl for that zone's wall-clock at that exact date.
export function zoneOffsetMinutes(timeZone: string, atMs: number): number | null {
  try {
    const d = new Date(atMs)
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d)
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value)
    const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'))
    return Number.isFinite(asUTC) ? Math.round((asUTC - d.getTime()) / 60000) : null
  } catch {
    return null
  }
}

// Resolve { offsetMin, zone } from a GPS fix + the instant it was taken.
// Returns null on invalid coords or if the lookup fails.
export function offsetFromCoords(
  lat: number | null | undefined,
  lon: number | null | undefined,
  atMs: number
): { offsetMin: number; zone: string } | null {
  if (!Number.isFinite(lat as number) || !Number.isFinite(lon as number)) return null
  if (!Number.isFinite(atMs)) return null
  let zone: string | null = null
  try { zone = tzlookup(lat as number, lon as number) } catch { return null }
  if (!zone) return null
  const offsetMin = zoneOffsetMinutes(zone, atMs)
  return offsetMin == null ? null : { offsetMin, zone }
}

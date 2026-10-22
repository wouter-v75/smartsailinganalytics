import { NextRequest, NextResponse } from 'next/server'
import { requireActiveUser } from '@/lib/supabase/admin-guard'
import { getServerSupabase } from '@/lib/supabase/server'
import {
  parseMetar, parseMfCsv, parseMfMarine, parseNdbcHistory,
  toObsPoints, withinHours, type ObsPoint,
} from '@/lib/windObs'

// GET /api/obs/history?id=ndbc:46088&hours=6
//
// What ONE station did over the last few hours. Each network keeps its history
// somewhere different, and two of them keep it somewhere surprising:
//
//   ndbc      a per-station file at a DIFFERENT column layout from the bulk one
//   metar     the same endpoint with &hours=, which is the easy case
//   mf-buoy   already in the bulk feed — /liste-bouees returns the whole
//   mf-ship   retention window, and the map view throws all but the newest away
//
// The id is the one the map already holds (`ndbc:46088`, `metar:LFMD`), so the
// client never has to know any of that.

const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'
const CACHE_S = 300
const MAX_HOURS = 24          // every upstream retains at least this
const MF_BASE = 'https://public-api.meteofrance.fr/public/DPObs/v2'

async function ndbcHistory(stn: string): Promise<ObsPoint[]> {
  // realtime2 is per station, and the id is upper-case in the feed.
  const url = `https://www.ndbc.noaa.gov/data/realtime2/${encodeURIComponent(stn.toUpperCase())}.txt`
  const res = await fetch(url, { headers: { 'User-Agent': UA }, next: { revalidate: CACHE_S } })
  if (!res.ok) throw new Error(`ndbc history ${res.status}`)
  return parseNdbcHistory(await res.text())
}

async function metarHistory(icao: string, hours: number): Promise<ObsPoint[]> {
  const url = 'https://aviationweather.gov/api/data/metar'
    + `?ids=${encodeURIComponent(icao)}&hours=${hours}&format=json`
  const res = await fetch(url, { headers: { 'User-Agent': UA }, next: { revalidate: CACHE_S } })
  if (!res.ok) throw new Error(`metar history ${res.status}`)
  return toObsPoints(parseMetar(await res.json()))
}

// The bulk feed already IS the history — /liste-bouees returns every buoy's
// whole retention window, and the map view keeps only the newest row per
// station. Here we want the rows it discards.
async function mfHistory(kind: 'buoy' | 'ship', stationId: string): Promise<ObsPoint[]> {
  const key = process.env.METEOFRANCE_API_KEY
  if (!key) return []
  const path = kind === 'buoy' ? '/liste-bouees' : '/bateaux'
  const res = await fetch(`${MF_BASE}${path}?format=csv`, {
    headers: { apikey: key, 'User-Agent': UA }, next: { revalidate: CACHE_S },
  })
  if (!res.ok) throw new Error(`mf history ${res.status}`)
  const all = parseMfMarine(parseMfCsv(await res.text()), kind)
  return toObsPoints(all.filter((o) => o.id === `mf-${kind}:${stationId}`))
}

/**
 * OUR OWN record first — scripts/obs-poll.ts keeps it, every 15 minutes.
 *
 * This is the only history some stations have. A Davis club station and a
 * Pioupiou beacon serve "now" and nothing else, so before this table they had
 * no trace at all, ever. It also makes 24/12/6/1 h mean the same thing across
 * every network rather than "whatever that one retains", and keeps a station's
 * past when it goes offline instead of losing it with the station.
 *
 * Returns [] rather than throwing when there is nothing yet — the upstream
 * fallback below then answers, which is what happens for the first few hours
 * after the poller is switched on.
 */
async function storedHistory(id: string, hours: number): Promise<ObsPoint[]> {
  const sb = getServerSupabase()
  const from = new Date(Date.now() - hours * 3600_000).toISOString()
  const { data, error } = await sb
    .from('wind_observations')
    .select('t, tws_kn, gust_kn, twd_deg')
    .eq('station_id', id)
    .gte('t', from)
    .order('t', { ascending: true })
    .limit(2000)
  if (error || !Array.isArray(data)) return []
  return data
    .filter((r) => typeof r.tws_kn === 'number')
    .map((r) => ({
      t: new Date(r.t as string).toISOString(),
      twsKn: r.tws_kn as number,
      gustKn: (r.gust_kn as number | null) ?? null,
      twdDeg: (r.twd_deg as number | null) ?? null,
    }))
}

export async function GET(req: NextRequest) {
  const gate = await requireActiveUser()
  if (!gate.ok) return gate.response

  const id = (req.nextUrl.searchParams.get('id') || '').trim()
  if (!id || !id.includes(':')) {
    return NextResponse.json({ error: 'id required, e.g. ndbc:46088' }, { status: 400 })
  }
  const hours = Math.min(MAX_HOURS, Math.max(1, parseFloat(req.nextUrl.searchParams.get('hours') || '6') || 6))

  const sep = id.indexOf(':')
  const net = id.slice(0, sep)
  const stn = id.slice(sep + 1)

  let points: ObsPoint[] = []
  let supported = true

  // Our own store first. Two or more points is a trace; one is just the current
  // reading again, and the upstream probably has more of a past than we do yet.
  try {
    const stored = await storedHistory(id, hours)
    if (stored.length > 1) {
      return NextResponse.json(
        { id, hours, supported: true, points: stored, stored: true, failed: false },
        { headers: { 'Cache-Control': `private, max-age=${CACHE_S}` } },
      )
    }
  } catch { /* fall through to the networks */ }

  try {
    if (net === 'ndbc') points = await ndbcHistory(stn)
    else if (net === 'metar') points = await metarHistory(stn, Math.ceil(hours))
    else if (net === 'mf-buoy') points = await mfHistory('buoy', stn)
    else if (net === 'mf-ship') points = await mfHistory('ship', stn)
    else supported = false
  } catch {
    // A trace that cannot be fetched is not worth a 500 — the panel still has
    // the current reading and simply says the history is unavailable.
    return NextResponse.json({ id, hours, supported: true, points: [], stored: false, failed: true },
      { headers: { 'Cache-Control': 'private, max-age=60' } })
  }

  // `supported: false` is a different answer from an empty trace, and the panel
  // says so: FFVL and our own boat have no history endpoint wired yet, which is
  // not the same as a station that has been quiet for six hours.
  return NextResponse.json(
    { id, hours, supported, points: withinHours(points, hours), stored: false, failed: false },
    { headers: { 'Cache-Control': `private, max-age=${CACHE_S}` } },
  )
}

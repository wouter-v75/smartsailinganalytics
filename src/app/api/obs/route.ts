import { NextRequest, NextResponse } from 'next/server'
import { requireActiveUser } from '@/lib/supabase/admin-guard'
import {
  parseMetar, parseFfvl, parseMfCsv, parseMfMarine, parseMfStationList,
  latestPerStation, withinNm, type WindObs,
} from '@/lib/windObs'

// GET /api/obs?lat=43.275&lon=6.678&nm=40
// Live wind observations around a point, one shape per network (lib/windObs).
//
// Server side on purpose, for three reasons: some networks need credentials that
// must not reach a client bundle; one fetch serves the whole team rather than
// every phone spending its own rate limit against the same box; and the NOAA
// endpoint asks for a custom User-Agent and no more than ~1 request/min/thread,
// which is a promise only one caller can keep.
//
// Sources are independent — one failing network returns the others rather than
// a 500. An empty list is a legitimate answer for a venue with nothing nearby.

const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'
const CACHE_S = 300          // METAR is hourly/half-hourly; 5 min is plenty and keeps us polite
const MAX_NM = 120

// Rounded so that two crew a mile apart share one upstream fetch instead of
// minting a cache key each.
function bbox(lat: number, lon: number, nm: number) {
  const dLat = nm / 60
  const dLon = nm / (60 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))
  const r = (v: number) => Math.round(v * 10) / 10
  return [r(lat - dLat), r(lon - dLon), r(lat + dLat), r(lon + dLon)]
}

async function metarAround(lat: number, lon: number, nm: number): Promise<WindObs[]> {
  const [la0, lo0, la1, lo1] = bbox(lat, lon, nm)
  const url = `https://aviationweather.gov/api/data/metar?bbox=${la0},${lo0},${la1},${lo1}&format=json`
  const res = await fetch(url, { headers: { 'User-Agent': UA }, next: { revalidate: CACHE_S } })
  if (!res.ok) throw new Error(`metar ${res.status}`)
  return parseMetar(await res.json())
}

// FFVL is open data but NOT keyless — an unkeyed call answers "invalid FFVL key
// length" and a key comes by email from informatique@ffvl.fr. Until FFVL_API_KEY
// is set this source is simply absent, which is why it is a separate try block
// rather than a hard requirement.
async function ffvlAround(): Promise<WindObs[]> {
  const key = process.env.FFVL_API_KEY
  if (!key) return []
  const base = 'https://data.ffvl.fr/api/'
  const q = (r: string) => `${base}?base=balises&r=${r}&mode=json&key=${encodeURIComponent(key)}`
  const [rel, bal] = await Promise.all([
    fetch(q('releves'), { headers: { 'User-Agent': UA }, next: { revalidate: CACHE_S } }),
    fetch(q('list'), { headers: { 'User-Agent': UA }, next: { revalidate: 86400 } }),   // metadata moves yearly
  ])
  if (!rel.ok) throw new Error(`ffvl ${rel.status}`)
  return parseFfvl(await rel.json(), bal.ok ? await bal.json() : [])
}

// Météo-France DPObs v2 — buoys and partner ships. The only sources here that
// sit ON THE WATER, which is why they carry the highest trust in OBS_SOURCES.
//
// Measured against the live API (scripts/mf-obs-probe.ts, 22 Oct 2026):
//   **v1 is SUSPENDED** and answers 500 on every path. v2 only.
//   **`/liste-bouees` is not a list** — it returns the full observations for
//   every buoy over the retention window, so buoys cost ONE bulk call and zero
//   per-station requests. That is why there is no station filter here: the
//   caller's withinNm does the geography once, at the end, for every source.
//   `/liste-bateaux` IS just a list (id;wigos;name), so ships need their own
//   data call.
const MF_BASE = 'https://public-api.meteofrance.fr/public/DPObs/v2'

async function mfFetch(path: string, key: string, revalidate: number): Promise<Response> {
  return fetch(`${MF_BASE}${path}`, {
    headers: { apikey: key, 'User-Agent': UA },
    next: { revalidate },
  })
}

// `format` is REQUIRED — omitting it answers 400 "Vérifiez le paramètre format",
// wrapped in WSO2 XML that reads like a bad key until you unpick it.
async function mfCsv(path: string, key: string, revalidate: number): Promise<string> {
  const res = await mfFetch(`${path}?format=csv`, key, revalidate)
  if (!res.ok) throw new Error(`mf ${path} ${res.status}`)
  return res.text()
}

/** Buoys: one call, everything in it, newest row per station. */
async function mfBuoys(key: string): Promise<WindObs[]> {
  const rows = parseMfCsv(await mfCsv('/liste-bouees', key, CACHE_S))
  return latestPerStation(parseMfMarine(rows, 'buoy'))
}

/**
 * Ships: the list carries only id and name, so positions have to come from the
 * data endpoint. Asked for in bulk — a moving ship cannot be pre-filtered by
 * position anyway, since the only position it has is the one in the reading.
 */
async function mfShips(key: string): Promise<WindObs[]> {
  const meta = parseMfStationList(await mfCsv('/liste-bateaux', key, 86400))
  const rows = parseMfCsv(await mfCsv('/bateaux', key, CACHE_S))
  return latestPerStation(parseMfMarine(rows, 'ship', meta))
}

// Absent entirely until METEOFRANCE_API_KEY is set — same contract as FFVL.
// Not France-only despite the name: the buoy feed includes the overseas
// territories (BOUEE_ANTILLES came back in the live sample).
async function mfMarineAround(): Promise<WindObs[]> {
  const key = process.env.METEOFRANCE_API_KEY
  if (!key) return []
  const [buoys, ships] = await Promise.allSettled([mfBuoys(key), mfShips(key)])
  const out: WindObs[] = []
  if (buoys.status === 'fulfilled') out.push(...buoys.value)
  if (ships.status === 'fulfilled') out.push(...ships.value)
  // Both failing is a real failure; one failing is not worth losing the other.
  if (buoys.status === 'rejected' && ships.status === 'rejected') throw buoys.reason
  return out
}

export async function GET(req: NextRequest) {
  const gate = await requireActiveUser()
  if (!gate.ok) return gate.response

  const lat = parseFloat(req.nextUrl.searchParams.get('lat') || '')
  const lon = parseFloat(req.nextUrl.searchParams.get('lon') || '')
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return NextResponse.json({ error: 'lat & lon required' }, { status: 400 })
  }
  const nm = Math.min(MAX_NM, Math.max(5, parseFloat(req.nextUrl.searchParams.get('nm') || '40') || 40))

  const sources: Array<[string, Promise<WindObs[]>]> = [
    ['metar', metarAround(lat, lon, nm)],
    ['ffvl', ffvlAround()],
    ['mf-marine', mfMarineAround()],
  ]
  const settled = await Promise.allSettled(sources.map(([, p]) => p))

  const obs: WindObs[] = []
  const failed: string[] = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') obs.push(...r.value)
    else failed.push(sources[i][0])
  })

  // Say which networks did not answer rather than passing a short list off as the
  // whole picture — "no stations near this venue" and "NOAA timed out" look
  // identical on a map otherwise.
  return NextResponse.json(
    { obs: withinNm(obs, lat, lon, nm), failed, at: new Date().toISOString() },
    { headers: { 'Cache-Control': `private, max-age=${CACHE_S}` } },
  )
}

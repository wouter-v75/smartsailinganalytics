import { NextRequest, NextResponse } from 'next/server'
import { requireActiveUser } from '@/lib/supabase/admin-guard'
import {
  parseMetar, parseFfvl, parseMfMarine, parseMfStationList, withinNm, type WindObs,
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

// Météo-France DPObs — buoys and partner ships. The only sources here that sit
// ON THE WATER, which is why they carry the highest trust in OBS_SOURCES.
//
// Shape of the problem: the list endpoints answer CSV and change about yearly;
// the data endpoints answer JSON but take ONE STATION PER CALL. So the lists are
// cached for a day and filtered to the venue FIRST, and only the handful that
// survive cost a request each. Without that filter a 40 nm query would walk
// every buoy in France to find the two that matter.
const MF_BASE = 'https://public-api.meteofrance.fr/public/DPObs/v1'
const MF_MAX_STATIONS = 8        // per kind; France has ~2-4 near any one venue

// Observations land at round hour + 10'. Asking for the current hour before it
// has been published returns the hour before anyway, but asking explicitly keeps
// the cache key stable for everyone who calls within the same hour.
function mfLatestHour(now = new Date()): string {
  const d = new Date(now)
  if (d.getUTCMinutes() < 10) d.setUTCHours(d.getUTCHours() - 1)
  d.setUTCMinutes(0, 0, 0)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function mfFetch(path: string, key: string, revalidate: number): Promise<Response> {
  return fetch(`${MF_BASE}${path}`, {
    headers: { apikey: key, 'User-Agent': UA, Accept: 'application/json' },
    next: { revalidate },
  })
}

async function mfKind(
  kind: 'buoy' | 'ship',
  key: string,
  lat: number,
  lon: number,
  nm: number,
): Promise<WindObs[]> {
  const [listPath, dataPath] = kind === 'buoy'
    ? ['/liste-bouees', '/bouees']
    : ['/liste-bateaux', '/bateaux']

  const listRes = await mfFetch(listPath, key, 86400)      // metadata moves yearly
  if (!listRes.ok) throw new Error(`mf ${kind} list ${listRes.status}`)
  const meta = parseMfStationList(await listRes.text())

  // Nearest-first, then capped. A ship's listed position is where it last
  // reported, so this is a coarse pre-filter; withinNm re-checks the real
  // position that comes back with the observation.
  const cos = Math.cos((lat * Math.PI) / 180)
  const near = Array.from(meta.entries())
    .filter(([, m]) => m.lat != null && m.lon != null)
    .map(([id, m]) => {
      const dLat = (m.lat! - lat) * 60
      const dLon = (m.lon! - lon) * 60 * cos
      return { id, d2: dLat * dLat + dLon * dLon }
    })
    .filter((x) => x.d2 <= nm * nm)
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, MF_MAX_STATIONS)

  if (!near.length) return []

  const date = mfLatestHour()
  const settled = await Promise.allSettled(
    near.map(async ({ id }) => {
      const q = `?id_station=${encodeURIComponent(id)}&date=${encodeURIComponent(date)}&format=json`
      const r = await mfFetch(`${dataPath}${q}`, key, CACHE_S)
      if (!r.ok) throw new Error(`mf ${kind} ${id} ${r.status}`)
      const body = await r.json()
      return parseMfMarine(Array.isArray(body) ? body : [body], kind, meta)
    }),
  )
  // One silent buoy must not take the other seven with it.
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
}

// France only, and absent entirely until METEOFRANCE_API_KEY is set — same
// contract as FFVL, so a venue outside France simply contributes nothing here.
async function mfMarineAround(lat: number, lon: number, nm: number): Promise<WindObs[]> {
  const key = process.env.METEOFRANCE_API_KEY
  if (!key) return []
  const [buoys, ships] = await Promise.allSettled([
    mfKind('buoy', key, lat, lon, nm),
    mfKind('ship', key, lat, lon, nm),
  ])
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
    ['mf-marine', mfMarineAround(lat, lon, nm)],
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

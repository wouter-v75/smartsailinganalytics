import { NextRequest, NextResponse } from 'next/server'
import { requireActiveUser } from '@/lib/supabase/admin-guard'
import { parseMetar, parseFfvl, withinNm, type WindObs } from '@/lib/windObs'

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

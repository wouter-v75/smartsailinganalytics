// Gathering the public wind networks in one place, so the poller route and the
// command-line script cannot drift apart.
//
// The parsers themselves live in windObs.ts and are tested against payloads
// captured off the wire. This module is the plumbing around them: which
// networks, which venues, and what counts as near enough to keep.
//
// NOTHING HERE TOUCHES A BOAT. Every source is somebody else's public station.

import {
  parseMetar, parseFfvl, parseNdbc, parseNdbcStations, parsePioupiou,
  parseWeatherLinkEmbed, withinNm, type WindObs,
} from './windObs'
import { WEATHERLINK_EMBEDS } from './windObsEmbeds'

export const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'

/**
 * Where we actually sail. A bulk feed hands over every station on earth, and
 * storing all of them would be ~56 M rows a year to answer questions nobody
 * asks. 60 nm is generous for a race area and still cuts NDBC's 865 stations
 * and Pioupiou's 758 down to the hundred or so that could matter.
 */
export const VENUES: Array<[string, number, number]> = [
  ['Solent / Cowes', 50.766, -1.288],
  ['Lymington', 50.733, -1.533],
  ['St Tropez', 43.275, 6.678],
  ['Porto Cervo', 41.135, 9.538],
  ['La Spezia', 44.10, 9.83],
  ['San Juan Islands', 48.5627, -122.8946],
  ['Long Beach / San Pedro', 33.72, -118.27],
  ['Ensenada', 31.85, -116.62],
]
export const VENUE_NM = 60

export function bbox(lat: number, lon: number, nm: number): [number, number, number, number] {
  const dLat = nm / 60
  const dLon = nm / (60 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))
  const r = (v: number) => Math.round(v * 10) / 10
  return [r(lat - dLat), r(lon - dLon), r(lat + dLat), r(lon + dLon)]
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, cache: 'no-store' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r
}

export type SourceName = 'ndbc' | 'metar' | 'davis' | 'pioupiou' | 'ffvl'

export const SOURCE_NAMES: SourceName[] = ['ndbc', 'metar', 'davis', 'pioupiou', 'ffvl']

const RUNNERS: Record<SourceName, () => Promise<WindObs[]>> = {
  ndbc: async () => {
    const [obs, stn] = await Promise.all([
      get('https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt'),
      get('https://www.ndbc.noaa.gov/data/stations/station_table.txt').catch(() => null),
    ])
    const meta = stn ? parseNdbcStations(await stn.text()) : new Map()
    return parseNdbc(await obs.text(), meta)
  },

  // One box per venue, never one big one: a large bbox silently TRUNCATES and
  // the cut falls at the end of the id sort order, so foreign stations go
  // first. Measured over SoCal, 22 Oct 2026.
  metar: async () => {
    // IN PARALLEL, not one after another. Measured on Vercel: eight sequential
    // boxes took 16.9 s of an 18.8 s run — a quarter of the function's budget
    // for one source, and it would grow with every venue added. The boxes are
    // independent and eight at once is nothing against this endpoint's limits.
    const settled = await Promise.allSettled(VENUES.map(async ([, la, lo]) => {
      const [a, b, c, d] = bbox(la, lo, VENUE_NM)
      const r = await get(`https://aviationweather.gov/api/data/metar?bbox=${a},${b},${c},${d}&format=json`)
      return parseMetar(await r.json())
    }))
    const out: WindObs[] = []
    const seen = new Set<string>()
    // One venue's box failing must not lose the other seven; venues overlap, so
    // the same station arrives more than once.
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue
      for (const o of r.value) if (!seen.has(o.id)) { seen.add(o.id); out.push(o) }
    }
    return out
  },

  davis: async () => {
    const settled = await Promise.allSettled(WEATHERLINK_EMBEDS.map(async (st) => {
      const r = await get(`https://www.weatherlink.com/embeddablePage/summaryData/${encodeURIComponent(st.uuid)}`)
      return parseWeatherLinkEmbed(await r.json(), st)
    }))
    return settled.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
  },

  pioupiou: async () => parsePioupiou(await (await get('https://api.pioupiou.fr/v1/live-with-meta/all')).json()),

  ffvl: async () => {
    const key = process.env.FFVL_API_KEY
    if (!key) return []
    const q = (r: string) => `https://data.ffvl.fr/api/?base=balises&r=${r}&mode=json&key=${encodeURIComponent(key)}`
    const [rel, bal] = await Promise.all([get(q('releves')), get(q('list')).catch(() => null)])
    return parseFfvl(await rel.json(), bal ? await bal.json() : [])
  },
}

/** Keep only what is near somewhere we sail, de-duplicated by station. */
export function nearAnyVenue(obs: WindObs[]): WindObs[] {
  const keep = new Map<string, WindObs>()
  for (const [, la, lo] of VENUES) for (const o of withinNm(obs, la, lo, VENUE_NM)) keep.set(o.id, o)
  return Array.from(keep.values())
}

export interface SourceResult { name: SourceName; total: number; kept: number; ms: number; error?: string }

/**
 * Fetch the named sources and return what is near a venue.
 *
 * One network failing is NOT a failed run — the others still have something to
 * say, and a gap in one trace beats a gap in all of them. Each outcome is
 * reported so a source that has been quietly dead for a week is visible.
 */
export async function collectObservations(
  only: SourceName[] = SOURCE_NAMES,
): Promise<{ obs: WindObs[]; results: SourceResult[] }> {
  const results: SourceResult[] = []
  const obs: WindObs[] = []
  for (const name of only) {
    const t0 = Date.now()
    try {
      const got = await RUNNERS[name]()
      const near = nearAnyVenue(got)
      obs.push(...near)
      results.push({ name, total: got.length, kept: near.length, ms: Date.now() - t0 })
    } catch (e) {
      results.push({ name, total: 0, kept: 0, ms: Date.now() - t0, error: (e as Error).message })
    }
  }
  // The same station twice in one run is an upstream oddity; newest wins.
  const byKey = new Map<string, WindObs>()
  for (const o of obs) {
    const k = `${o.id}|${o.t}`
    const prev = byKey.get(k)
    if (!prev || Date.parse(o.t) > Date.parse(prev.t)) byKey.set(k, o)
  }
  return { obs: Array.from(byKey.values()), results }
}

/** WindObs → a wind_observations row. */
export function obsRow(o: WindObs) {
  return {
    station_id: o.id, t: o.t, source: o.source, name: o.name,
    lat: o.lat, lon: o.lon, tws_kn: o.twsKn, gust_kn: o.gustKn,
    twd_deg: o.twdDeg, height_m: o.heightM, surface: o.surface, trust: o.trust,
  }
}

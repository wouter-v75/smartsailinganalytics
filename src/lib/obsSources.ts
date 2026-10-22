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
  parseWeatherLinkEmbed, parseWeatherLinkMapStation, dropDuplicatesOf,
  parseMetOfficeLandObs, withinNm, type WindObs, type MetOfficeSite,
} from './windObs'
import { WEATHERLINK_EMBEDS } from './windObsEmbeds'
import { DAVIS_MAP_STATIONS, type DavisMapStation } from './windObsDavisMap'

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
  // ENSENADA IS THE ONE VENUE WITH NOTHING NEAR IT, and it is not for want of
  // looking (22 Oct 2026):
  //   NDBC stops at the border — nothing within 30 nm, nearest wind 50 nm away
  //     at the Tijuana River.
  //   MMES, Ensenada's airport, publishes NO METAR at all: asked for five
  //     Mexican stations by name, four answered and that was the one missing.
  //     MMTJ (Tijuana), 50 nm north, is the closest METAR there is.
  //   CONAGUA has an EMA 3 nm away — P. LOPEZ ZAMORA, id 68 — but its public
  //     feed is DOWN, not merely awkward: GetInfoEMAS_v2 answers `info: null`
  //     for it, ConsultaCluster.php returns 500, and all 321 stations in the
  //     country are flagged `emaError`. Worth re-checking in a season; the
  //     station is there and the endpoints are known.
  // It stays in the list because the 60 nm filter still catches the Tijuana
  // stations, which is context even if it is not course wind.
  ['Ensenada', 31.85, -116.62],
]
export const VENUE_NM = 60

/**
 * Met Office areas we read, by geohash. UK ONLY — the product covers ~150 land
 * locations across Britain, about 50 km apart, so this is the Solent and its
 * approaches and there is nothing to add for the Med or America.
 *
 * The geohashes came from /nearest for each venue; the names are the API's own
 * `area` strings. Positions are decoded from the hash, since /nearest returns
 * no coordinates at all.
 */
export const METOFFICE_SITES: MetOfficeSite[] = [
  { geohash: 'gbzpdr', name: 'Isle of Wight' },
  { geohash: 'gcnfur', name: 'Hampshire' },
  { geohash: 'gcn8yh', name: 'Bournemouth Christchurch and Poole' },
]

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

export type SourceName = 'ndbc' | 'metar' | 'davis' | 'davis-map' | 'pioupiou' | 'ffvl' | 'metoffice'

export const SOURCE_NAMES: SourceName[] = ['ndbc', 'metar', 'davis', 'davis-map', 'pioupiou', 'ffvl', 'metoffice']

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
  // ONE BOX PER VENUE, SEQUENTIALLY. Both halves of that were measured.
  //
  // One box per venue because a single large bbox silently TRUNCATES: over
  // SoCal a 3.2x2.3 deg box answered 33 stations while its two halves answered
  // 32 and 3, and the cut fell at the end of the id sort order — so the foreign
  // stations went first and MMTJ vanished. Near a border that reads as "nothing
  // over there".
  //
  // Sequentially because PARALLEL WAS TRIED AND WAS NOT FASTER. Eight boxes at
  // once from Vercel took 20.1 s against 10.4 s and 16.9 s for the same eight
  // in sequence; aviationweather.gov appears to throttle concurrent connections
  // from one address, so the requests queue and nothing is gained for the extra
  // moving parts. This is the slowest source either way, at roughly half the
  // poll — well inside the function's 60 s budget. If venues ever double, the
  // thing to try is a CONCURRENCY CAP of two or three, not full parallelism,
  // and not a bigger box.
  metar: async () => {
    const out: WindObs[] = []
    const seen = new Set<string>()
    for (const [, la, lo] of VENUES) {
      const [a, b, c, d] = bbox(la, lo, VENUE_NM)
      try {
        const r = await get(`https://aviationweather.gov/api/data/metar?bbox=${a},${b},${c},${d}&format=json`)
        // Venues overlap, so the same station arrives more than once.
        for (const o of parseMetar(await r.json())) if (!seen.has(o.id)) { seen.add(o.id); out.push(o) }
      } catch { /* one venue's box failing must not lose the other seven */ }
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

  // The public-map stations: private Davis kit their owners chose to publish.
  // One small call each, from a list generated against the map's own index —
  // see windObsDavisMap.ts for why the index itself is not fetched here.
  'davis-map': async () => davisMapStations(DAVIS_MAP_STATIONS),

  // Met Office Land Observations — UK only, and HOURLY. The free plan allows
  // 360 calls a day and one call returns 48 hourly rows, so polling this every
  // quarter hour would spend the budget four times over to fetch the same
  // numbers. Three sites at once an hour is 72 calls a day.
  //
  // Returns every row it is given; the caller keeps the newest for the map and
  // the rest become history, which is the reason to have this source at all —
  // it is coarser than the METAR at the same airports (~50 km spacing, 16-point
  // direction) but it carries two days of past with it.
  metoffice: async () => {
    const key = process.env.METOFFICE_API_KEY
    if (!key) return []
    // Only on the hour. The poller runs every 15 minutes; three of those four
    // would be wasted calls against a small daily budget.
    if (new Date().getUTCMinutes() >= 15) return []
    const out: WindObs[] = []
    for (const site of METOFFICE_SITES) {
      try {
        const r = await fetch(`https://data.hub.api.metoffice.gov.uk/observation-land/1/${encodeURIComponent(site.geohash)}`, {
          headers: { apikey: key, accept: 'application/json', 'User-Agent': UA }, cache: 'no-store',
        })
        if (!r.ok) continue
        out.push(...parseMetOfficeLandObs(await r.json(), site))
      } catch { /* one area failing is not an outage */ }
    }
    return out
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

/**
 * Current conditions for a set of public-map Davis stations.
 *
 * Sequential on purpose: these are small calls to somebody else's public map,
 * and the METAR experiment earlier showed that firing a handful at once is not
 * reliably faster anyway. A station that fails is skipped, not fatal.
 *
 * Anything that is really one of our curated embeds is dropped by POSITION —
 * the two sources id the same station differently, so nothing else connects
 * them, and the embed is the richer reading (10-minute mean, with a gust).
 */
export async function davisMapStations(list: DavisMapStation[]): Promise<WindObs[]> {
  const out: WindObs[] = []
  for (const st of list) {
    try {
      const r = await get(`https://www.weatherlink.com/map/data/station/${encodeURIComponent(st.id)}`)
      const o = parseWeatherLinkMapStation(await r.json(), st.id)
      // The index knows the position and the name; the detail call sometimes
      // carries a blanker version of both.
      if (o) out.push({ ...o, name: st.name || o.name, lat: st.lat, lon: st.lon })
    } catch { /* one garden station being down is not an outage */ }
  }
  return out
}

/** The public-map stations near a point — what the live map needs, and no more. */
export function davisMapNear(lat: number, lon: number, nm: number, max = 8): DavisMapStation[] {
  const cos = Math.cos((lat * Math.PI) / 180)
  return DAVIS_MAP_STATIONS
    .map((s) => ({ s, d: Math.hypot((s.lat - lat) * 60, (s.lon - lon) * 60 * cos) }))
    .filter((x) => x.d <= nm)
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.s)
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
  // A curated embed and a public-map entry can be the SAME physical station
  // under two different ids; the embed is richer, so the map copy goes.
  const embeds = obs.filter((o) => o.id.startsWith('wle:'))
  const deduped = embeds.length
    ? [...obs.filter((o) => !o.id.startsWith('wlmap:')), ...dropDuplicatesOf(obs.filter((o) => o.id.startsWith('wlmap:')), embeds)]
    : obs

  // The same station twice in one run is an upstream oddity; newest wins.
  const byKey = new Map<string, WindObs>()
  for (const o of deduped) {
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

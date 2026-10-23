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
  parsePortlog, parsePortlogLatestUrl, parseWeatherfile,
  parseMetOfficeLandObs, parseFrostObs,
  withinNm, type WindObs, type MetOfficeSite, type FrostSite,
} from './windObs'
import { WEATHERLINK_EMBEDS } from './windObsEmbeds'
import { DAVIS_MAP_STATIONS, type DavisMapStation } from './windObsDavisMap'
import { WEATHERFILE_STATIONS, type WeatherfileStation } from './windObsWeatherfile'
import { CLUB_FEEDS, parseClubFeed, type ClubFeed } from './windObsClubs'

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
  // The Oslofjord corridor: Larvik up to Oslo, east to Sarpsborg and north to
  // Gardermoen. Four points rather than one box, because the Davis station
  // list is picked per venue and one centre would cluster them all together.
  ['Viksfjord / Larvik', 59.03, 10.15],
  ['Oslofjord / Horten', 59.42, 10.48],
  ['Oslo', 59.90, 10.73],
  ['Fredrikstad / Sarpsborg', 59.22, 10.95],
]
export const VENUE_NM = 60

/**
 * How often the poller is expected to run, in minutes.
 *
 * THE CRONTAB ON `regatta` IS THE SOURCE OF TRUTH; this has to match it, and
 * the only reason it exists in code is that one source has to know. The Met
 * Office gate below used to read `getUTCMinutes() >= 15`, a bare 15 that was
 * really this number written down somewhere it could not be found. At the
 * 0,30 schedule that still fired once an hour by luck — but on a :15,:45
 * schedule it would have fired NEVER, and the symptom would have been a
 * source quietly returning nothing with every other check green.
 */
export const POLL_EVERY_MIN = 30

/**
 * Whether this run is the one that starts the hour — for sources whose budget
 * is daily and whose data is hourly, so three or four polls of the same numbers
 * is three or four wasted calls.
 *
 * Works for any cadence that divides the hour and is aligned to it: exactly one
 * run per hour lands in the first `everyMin` minutes.
 */
export function isHourlySlot(d: Date = new Date(), everyMin: number = POLL_EVERY_MIN): boolean {
  return d.getUTCMinutes() < everyMin
}

/**
 * Met Office areas we read, by geohash. UK ONLY — the product covers ~150 land
 * locations across Britain, about 50 km apart, so this is the Solent and its
 * approaches and there is nothing to add for the Med or America.
 *
 * The geohashes came from /nearest for each venue; the names are the API's own
 * `area` strings. Positions are decoded from the hash, since /nearest returns
 * no coordinates at all.
 */
/**
 * MET Norway stations we read. CURATED FROM availableTimeSeries, not from what
 * is nearest: of twelve sources within 8 nm of Viksfjord only FOUR carry wind
 * at all, and only Svenner Fyr carries speed, direction AND gust together.
 * The rest are rain and temperature, or speed with no direction — which is why
 * "the nearest station" is the wrong question to ask this network.
 */
export const FROST_SITES: FrostSite[] = [
  // The lighthouse south of Larvik: exposed, 10-minute resolution, and the
  // only one here with a complete wind observation.
  { id: 'SN29950', name: 'Svenner Fyr', lat: 58.9688, lon: 10.148 },
  // Speed and gust but NO direction — still worth having for the strength.
  { id: 'SN27780', name: 'Tjølling', lat: 59.045747, lon: 10.1250557 },
  { id: 'SN29980', name: 'Brunlanes', lat: 58.9878, lon: 9.96187 },

  // ── Oslofjord, Sarpsborg and north to Gardermoen ─────────────────────────
  // Two lighthouses and an island station, which are the ones worth having:
  // exposed, over water, and nothing like a garden.
  { id: 'SN17000', name: 'Strømtangen Fyr', lat: 59.15154567, lon: 10.82829919 },
  { id: 'SN17280', name: 'Gullholmen', lat: 59.4352, lon: 10.578 },
  { id: 'SN27120', name: 'Horten - Nykirke', lat: 59.4283, lon: 10.3847 },
  { id: 'SN27161', name: 'Horten - Skoppum', lat: 59.3845, lon: 10.3985 },
  { id: 'SN27285', name: 'E18 Tveiten', lat: 59.33085, lon: 10.379 },
  { id: 'SN17050', name: 'Råde - Tomb', lat: 59.3188, lon: 10.8145 },
  { id: 'SN18700', name: 'Oslo - Blindern', lat: 59.9423, lon: 10.72 },
  { id: 'SN3190', name: 'Sarpsborg', lat: 59.2850933, lon: 11.1127995 },
  { id: 'SN3003', name: 'E6 Solbergtårnet Syd', lat: 59.2046108, lon: 11.1780095 },
  // Speed but no direction — kept for the strength, which is still worth having.
  { id: 'SN3370', name: 'Øsaker', lat: 59.31933, lon: 11.04217 },
  { id: 'SN4685', name: 'Gardermoen - Vardåsen', lat: 60.1656, lon: 10.9347 },
  { id: 'SN4780', name: 'Gardermoen', lat: 60.2065, lon: 11.0802 },
]

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

export type SourceName = 'ndbc' | 'metar' | 'davis' | 'davis-map' | 'pioupiou' | 'ffvl' | 'metoffice' | 'frost' | 'portlog' | 'weatherfile' | 'clubs'

export const SOURCE_NAMES: SourceName[] = ['ndbc', 'metar', 'davis', 'davis-map', 'pioupiou', 'ffvl', 'metoffice', 'frost', 'portlog', 'weatherfile', 'clubs']

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

  portlog: async () => portlogObs(),

  weatherfile: async () => weatherfileObs(),

  clubs: async () => clubsObs(),

  // Met Office Land Observations — UK only, and HOURLY. The free plan allows
  // 360 calls a day and one call returns 48 hourly rows, so polling it on every
  // run would spend the budget several times over to fetch the same numbers.
  // Three sites once an hour is 72 calls a day.
  //
  // Returns every row it is given; the caller keeps the newest for the map and
  // the rest become history, which is the reason to have this source at all —
  // it is coarser than the METAR at the same airports (~50 km spacing, 16-point
  // direction) but it carries two days of past with it.
  metoffice: async () => {
    const key = process.env.METOFFICE_API_KEY
    if (!key) return []
    // Once an hour, whatever the poll cadence is.
    if (!isHourlySlot()) return []
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

  // MET Norway Frost — the official Norwegian network, and the best-described
  // source here: it states the unit, the HEIGHT and a quality code per reading.
  // One call covers every station, so this is cheap; hourly would do, but it is
  // light enough to leave on every poll.
  frost: async () => {
    const id = process.env.FROST_CLIENT_ID
    if (!id) return []
    const sites = new Map(FROST_SITES.map((f) => [f.id, f]))
    const els = 'wind_speed,wind_from_direction,max(wind_speed_of_gust PT1H)'
    const url = 'https://frost.met.no/observations/v0.jsonld'
      + `?sources=${FROST_SITES.map((f) => f.id).join(',')}`
      + `&elements=${encodeURIComponent(els)}&referencetime=latest&maxage=PT3H`
    // Basic auth with the client id as the user and NO password: the secret is
    // only for the OAuth2 flow, so it never goes over the wire.
    const auth = Buffer.from(`${id}:`).toString('base64')
    const r = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, accept: 'application/json', 'User-Agent': UA },
      cache: 'no-store',
    })
    if (!r.ok) throw new Error(`frost ${r.status}`)
    return parseFrostObs(await r.json(), sites)
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
 * EIGHT AT A TIME, measured. This used to be sequential, on a comment that
 * generalised the METAR experiment — where tiling a bbox in parallel came out
 * SLOWER — to this endpoint without ever testing it here. The two are not
 * alike: METAR was a few large bbox queries against one search endpoint that
 * serialises them anyway, while these are tiny independent per-station reads.
 * Timed against the 36 nearest stations to Cowes on 22 Oct 2026:
 *
 *     sequential   8.4 s   (233 ms per call)
 *     8 at once    1.15 s
 *     12 at once   1.02 s
 *
 * So 8 is where the curve flattens; 12 buys 130 ms and opens half as many
 * sockets again on somebody else's public map, which is not a trade worth
 * making. Sequential was the whole reason the live map could only afford 8
 * stations, which is why the Solent showed 6 of the 124 Davis stations
 * within 20 nm of Cowes.
 *
 * A station that fails is skipped, not fatal.
 *
 * Anything that is really one of our curated embeds is dropped by POSITION —
 * the two sources id the same station differently, so nothing else connects
 * them, and the embed is the richer reading (10-minute mean, with a gust).
 */
/**
 * Run `fn` over `list` with at most `limit` calls in flight, keeping the
 * caller's order in the result. Indexed rather than pushed, because the
 * workers finish out of order and the de-duplication downstream expects the
 * nearest-first order it was given.
 *
 * `limit` is 8 by measurement, not taste — see DAVIS_MAP_CONCURRENCY.
 */
async function mapPooled<T, R>(
  list: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R | null>,
): Promise<R[]> {
  const slots: Array<R | null> = new Array(list.length).fill(null)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= list.length) return
      slots[i] = await fn(list[i])
    }
  }
  await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, list.length)) }, worker))
  return slots.filter((v): v is R => v !== null)
}

export const DAVIS_MAP_CONCURRENCY = 8

export async function davisMapStations(list: DavisMapStation[]): Promise<WindObs[]> {
  return mapPooled(list, DAVIS_MAP_CONCURRENCY, async (st) => {
    try {
      const r = await get(`https://www.weatherlink.com/map/data/station/${encodeURIComponent(st.id)}`)
      const o = parseWeatherLinkMapStation(await r.json(), st.id)
      // The index knows the position and the name; the detail call sometimes
      // carries a blanker version of both.
      return o ? { ...o, name: st.name || o.name, lat: st.lat, lon: st.lon } : null
    } catch {
      return null // one garden station being down is not an outage
    }
  })
}

/**
 * The public-map stations near a point — what the live map needs, and no more.
 *
 * The cap was 8 when each station cost 233 ms in series: 36 of them would have
 * been eight seconds of the route's budget. At 8-way concurrency the same 36
 * cost 1.15 s, so the cap is now set by what is worth DRAWING rather than by
 * what we can afford to fetch. Windycator shows 24 around the Solent; 36
 * clears that with room, and the declutterer thins them by zoom anyway.
 */
export function davisMapNear(lat: number, lon: number, nm: number, max = 36): DavisMapStation[] {
  const cos = Math.cos((lat * Math.PI) / 180)
  return DAVIS_MAP_STATIONS
    .map((s) => ({ s, d: Math.hypot((s.lat - lat) * 60, (s.lon - lon) * 60 * cos) }))
    .filter((x) => x.d <= nm)
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.s)
}


// ---------------------------------------------------------------------------
// Port-Log (ABP Southampton)
// ---------------------------------------------------------------------------

/**
 * The cluster page. It is an ordinary public page — the one southamptonvts.co.uk
 * embeds in an iframe on its own Live Weather page — and it carries the signed
 * token for the data call in a `latest_url` assignment.
 */
export const PORTLOG_PAGE = 'https://abports.port-log.net/southampton/Latest.php?theme=Day'

/**
 * The sites that stand in open water rather than inside the docks, by Site_Code.
 * Bramble is on the bank mid-Solent, Calshot on the spit, Nab Tower at the
 * eastern approach, No.4 Buoy a quarter of a mile off Cowes. Dock Head, Town
 * Quay, Marchwood and the berths are all up the Water behind buildings.
 */
export const PORTLOG_SEA_SITES: ReadonlySet<string> = new Set([
  'ABPS-TW06', // Bramble
  'ABPS-TW01', // Calshot
  'ABPS-TW04', // Nab Tower
  'CHC-CM02',  // No.4 Buoy, off Cowes
])

/**
 * Cached for the life of the instance. The token is signed, so it changes only
 * when they rotate the PIN; fetching the page on every poll to re-read a
 * constant would double the request count for nothing.
 */
let portlogToken: string | null = null

/** Where the cluster is, and how far out it is worth asking for it. */
const PORTLOG_CENTRE: [number, number] = [50.766, -1.288]
export const PORTLOG_REACH_NM = 60

/**
 * Whether a viewport is near enough the Solent to be worth a Port-Log call.
 *
 * Gated on distance, which frost and ffvl are not — those cover a country and
 * this covers one harbour. A viewport over Long Beach has no business fetching
 * Bramble Bank, and the gate is what stops a pan around California making a
 * request to a British port authority on every move. The viewport's own radius
 * counts, because a wide view centred inland still has the Solent in frame.
 */
export function portlogInReach(lat: number, lon: number, nm: number): boolean {
  const cos = Math.cos((lat * Math.PI) / 180)
  const d = Math.hypot((lat - PORTLOG_CENTRE[0]) * 60, (lon - PORTLOG_CENTRE[1]) * 60 * cos)
  return d <= PORTLOG_REACH_NM + nm
}

export async function portlogObs(): Promise<WindObs[]> {
  if (!portlogToken) {
    const page = await get(PORTLOG_PAGE)
    const url = parsePortlogLatestUrl(await page.text())
    if (!url) {
      // Deliberately loud. The alternative is a hardcoded token that works
      // until it does not, and then an empty mid-Solent with no reason given.
      throw new Error('Port-Log: no latest_url on the cluster page — the page layout or the PIN changed')
    }
    portlogToken = url
  }
  const r = await get(portlogToken)
  // Served as text/html despite being JSON, so .json() is not safe to trust.
  const raw = JSON.parse(await r.text()) as unknown
  return parsePortlog(raw, { seaSites: PORTLOG_SEA_SITES })
}


// ---------------------------------------------------------------------------
// WeatherFile.com (the western Solent)
// ---------------------------------------------------------------------------

/**
 * How much past to keep per poll. One call returns the whole day at five
 * minutes, so asking for six hours means the 6-hour graph is COMPLETE from the
 * first poll rather than filling in over the following six hours. Re-storing
 * the overlap every run is idempotent — wind_observations is keyed
 * (station_id, t).
 */
export const WEATHERFILE_HISTORY_H = 6

/**
 * Current conditions and recent history for WeatherFile locations.
 *
 * Returns NOTHING without WEATHERFILE_TOKEN, by design: the API needs a
 * `wf-tkn`, their own page mints a six-character one against a PHP session,
 * and automating that would be scripting around an access control on somebody
 * else's commercial service. Absent the key this source is structurally inert,
 * the same shape as a missing BUNNY_STORAGE_WRITE_KEY making the app read-only
 * against Bunny. See windObsWeatherfile.ts for how to get a token.
 */
export async function weatherfileObs(
  stations: WeatherfileStation[] = WEATHERFILE_STATIONS,
  historyHours: number = WEATHERFILE_HISTORY_H,
): Promise<WindObs[]> {
  const token = process.env.WEATHERFILE_TOKEN
  if (!token) return []
  const from = Date.now() - historyHours * 3600_000

  const per = await mapPooled(stations, DAVIS_MAP_CONCURRENCY, async (st) => {
    try {
      const r = await fetch(`https://weatherfile.com/api/V03/loc/${encodeURIComponent(st.locId)}/averages.json`, {
        method: 'POST',
        headers: { 'wf-tkn': token, 'User-Agent': UA },
        cache: 'no-store',
      })
      if (!r.ok) return null
      // Their own client JSON.parses a string response, so the content type is
      // not something to rely on.
      const rows = parseWeatherfile(JSON.parse(await r.text()), st)
      return rows.filter((o) => Date.parse(o.t) >= from)
    } catch {
      return null // one club platform being down is not an outage
    }
  })
  return per.flat()
}

/** The WeatherFile locations near a point — what the live map needs. */
export function weatherfileNear(lat: number, lon: number, nm: number): WeatherfileStation[] {
  const cos = Math.cos((lat * Math.PI) / 180)
  return WEATHERFILE_STATIONS.filter(
    (s) => Math.hypot((s.lat - lat) * 60, (s.lon - lon) * 60 * cos) <= nm,
  )
}


// ---------------------------------------------------------------------------
// The open club and agency feeds
// ---------------------------------------------------------------------------

/**
 * Hill Head, Netley, NCI Hengistbury Head and the two CCO piers.
 *
 * No key, no token, nobody's permission — which is the whole reason these are
 * worth having. Four unrelated formats, so the parsing lives in
 * windObsClubs.ts and this only fetches.
 *
 * Hill Head publishes 288 rows, a full 24 hours at five minutes, so the window
 * is trimmed to the history we actually keep. One club's web host being down
 * is not an outage.
 */
export const CLUBS_HISTORY_H = 6

export async function clubsObs(
  feeds: ClubFeed[] = CLUB_FEEDS,
  historyHours: number = CLUBS_HISTORY_H,
): Promise<WindObs[]> {
  const from = Date.now() - historyHours * 3600_000
  const per = await mapPooled(feeds, DAVIS_MAP_CONCURRENCY, async (f) => {
    try {
      const r = await get(f.url)
      return parseClubFeed(f, await r.text()).filter((o) => Date.parse(o.t) >= from)
    } catch {
      return null
    }
  })
  return per.flat()
}

/** The club feeds near a point — what the live map needs. */
export function clubsNear(lat: number, lon: number, nm: number): ClubFeed[] {
  const cos = Math.cos((lat * Math.PI) / 180)
  return CLUB_FEEDS.filter((s) => Math.hypot((s.lat - lat) * 60, (s.lon - lon) * 60 * cos) <= nm)
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

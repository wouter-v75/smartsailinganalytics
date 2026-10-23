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
  parseMfCsv, parseMfStationList, parseMfLand, latestPerStation, type MfStationMeta,
  parseMetOfficeLandObs, parseFrostObs,
  withinNm, type WindObs, type MetOfficeSite, type FrostSite,
} from './windObs'
import { WEATHERLINK_EMBEDS } from './windObsEmbeds'
import { DAVIS_MAP_STATIONS, type DavisMapStation } from './windObsDavisMap'
import { WEATHERFILE_STATIONS, type WeatherfileStation } from './windObsWeatherfile'
import { CLUB_FEEDS, parseClubFeed, type ClubFeed } from './windObsClubs'
import { gradedPick, nmBetween, type GradedOptions } from './obsDensity'
import { VENUES } from './venues'
import {
  decideVenues, IDLE_NM, IDLE_MIN_PER_VENUE,
  type ActivationInput, type VenueDecision,
} from './obsActivation'

export const UA = 'SmartSailingAnalytics/1.0 (+https://ssa.wvsailing.co.uk)'

/**
 * Where we actually sail. A bulk feed hands over every station on earth, and
 * storing all of them would be ~56 M rows a year to answer questions nobody
 * asks. 60 nm is generous for a race area and still cuts NDBC's 865 stations
 * and Pioupiou's 758 down to the hundred or so that could matter.
 */
export { VENUES, venueByKey, venueAt, VENUE_MATCH_NM, type Venue } from './venues'

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

export type SourceName = 'ndbc' | 'metar' | 'davis' | 'davis-map' | 'pioupiou' | 'ffvl' | 'metoffice' | 'frost' | 'portlog' | 'weatherfile' | 'clubs' | 'mf-land'

export const SOURCE_NAMES: SourceName[] = ['ndbc', 'metar', 'davis', 'davis-map', 'pioupiou', 'ffvl', 'metoffice', 'frost', 'portlog', 'weatherfile', 'clubs', 'mf-land']

/**
 * What a runner needs to know besides its own endpoint: which venues are
 * DENSE right now and how far out each is being polled.
 *
 * Passed in rather than read from a module global so the whole collection is
 * testable without a database or a clock.
 */
export interface PollContext {
  venues: VenueDecision[]
}

/** The radius worth STORING from a bulk feed, which costs nothing extra to ask for. */
export function keepRadiusNm(d: VenueDecision): number {
  return d.mode === 'dense' ? VENUE_NM : IDLE_NM
}

const RUNNERS: Record<SourceName, (ctx: PollContext) => Promise<WindObs[]>> = {
  ndbc: async (_ctx) => {
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
  metar: async (ctx) => {
    const out: WindObs[] = []
    const seen = new Set<string>()
    for (const v of ctx.venues) {
      const { lat: la, lon: lo } = v
      // An idle venue gets a small box: same one call, far less to parse.
      const [a, b, c, d] = bbox(la, lo, keepRadiusNm(v))
      try {
        const r = await get(`https://aviationweather.gov/api/data/metar?bbox=${a},${b},${c},${d}&format=json`)
        // Venues overlap, so the same station arrives more than once.
        for (const o of parseMetar(await r.json())) if (!seen.has(o.id)) { seen.add(o.id); out.push(o) }
      } catch { /* one venue's box failing must not lose the other seven */ }
    }
    return out
  },

  davis: async (_ctx) => {
    const settled = await Promise.allSettled(WEATHERLINK_EMBEDS.map(async (st) => {
      const r = await get(`https://www.weatherlink.com/embeddablePage/summaryData/${encodeURIComponent(st.uuid)}`)
      return parseWeatherLinkEmbed(await r.json(), st)
    }))
    return settled.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
  },

  // The public-map stations: private Davis kit their owners chose to publish.
  // One small call each, from a list generated against the map's own index —
  // see windObsDavisMap.ts for why the index itself is not fetched here.
  // THE DENSE SET IS THE EXPENSIVE ONE. 225 stations every poll is 11,000
  // requests a day; the same registry filtered to the idle radius is a small
  // fraction of that, and the dense set comes back the moment a venue does.
  'davis-map': async (ctx) => davisMapStations(stationsForPoll(DAVIS_MAP_STATIONS, ctx)),

  portlog: async (_ctx) => portlogObs(),

  weatherfile: async (ctx) => weatherfileObs(stationsForPoll(WEATHERFILE_STATIONS, ctx)),

  clubs: async (ctx) => clubsObs(stationsForPoll(CLUB_FEEDS, ctx)),

  'mf-land': async (ctx) => mfLandObs(ctx),

  // Met Office Land Observations — UK only, and HOURLY. The free plan allows
  // 360 calls a day and one call returns 48 hourly rows, so polling it on every
  // run would spend the budget several times over to fetch the same numbers.
  // Three sites once an hour is 72 calls a day.
  //
  // Returns every row it is given; the caller keeps the newest for the map and
  // the rest become history, which is the reason to have this source at all —
  // it is coarser than the METAR at the same airports (~50 km spacing, 16-point
  // direction) but it carries two days of past with it.
  metoffice: async (_ctx) => {
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
  frost: async (_ctx) => {
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

  pioupiou: async (_ctx) => parsePioupiou(await (await get('https://api.pioupiou.fr/v1/live-with-meta/all')).json()),

  ffvl: async (_ctx) => {
    const key = process.env.FFVL_API_KEY
    if (!key) return []
    const q = (r: string) => `https://data.ffvl.fr/api/?base=balises&r=${r}&mode=json&key=${encodeURIComponent(key)}`
    const [rel, bal] = await Promise.all([get(q('releves')), get(q('list')).catch(() => null)])
    return parseFfvl(await rel.json(), bal ? await bal.json() : [])
  },
}



/**
 * Which of an UNGRADED pool to poll around one venue.
 *
 * stationsForPoll is for a fixed registry that was already graded when it was
 * built. This is for a pool that was not — the Météo-France station list is
 * every station in France — so a dense venue has to be thinned here, and an
 * idle one still needs the nearest-few floor.
 *
 * THE FLOOR IS THE WHOLE POINT, and leaving it out of the Météo-France path
 * cost exactly what it was written to prevent: CAP CAMARAT is 4.1 nm from the
 * Golfe de Saint-Tropez and the idle radius is 3 nm, so grading to the idle
 * radius alone excluded the single most useful station at the venue — the one
 * station actually in the 5 nm circle — whenever no regatta was running.
 */
export function selectAroundVenue<T extends { lat: number; lon: number }>(
  pool: readonly T[],
  v: VenueDecision,
): T[] {
  if (v.mode === 'dense') return gradedPick(pool, v.lat, v.lon, { outerNm: v.radiusNm })
  const ranked = pool
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => ({ s, d: nmBetween(v.lat, v.lon, s.lat, s.lon) }))
    .sort((a, b) => a.d - b.d)
  const out: T[] = []
  ranked.forEach((x, i) => {
    if (x.d <= v.radiusNm || (i < IDLE_MIN_PER_VENUE && x.d <= VENUE_NM)) out.push(x.s)
  })
  return out
}

/**
 * Which of a fixed station registry to poll this run: anything inside the
 * radius of ANY venue, where an idle venue's radius is its inner circle only.
 *
 * This is where the dense-when-racing decision actually saves requests. The
 * bulk feeds cost one call whatever we keep; these cost one call PER STATION,
 * so the selection has to happen before the fetch, not after.
 */
export function stationsForPoll<T extends { lat: number; lon: number }>(
  list: readonly T[],
  ctx: PollContext,
): T[] {
  const keep = new Set<T>()
  for (const v of ctx.venues) {
    const ranked = list
      .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
      .map((s) => ({ s, d: nmBetween(v.lat, v.lon, s.lat, s.lon) }))
      .sort((a, b) => a.d - b.d)
    ranked.forEach((x, i) => {
      if (x.d <= v.radiusNm) { keep.add(x.s); return }
      // THE FLOOR. An idle venue still polls its nearest few however far out
      // they are, so no venue goes dark: Porto Cervo has nothing within 5 nm,
      // and a venue with no continuous record is a gap nobody notices until
      // they go looking for last month's wind.
      if (v.mode === 'idle' && i < IDLE_MIN_PER_VENUE && x.d <= VENUE_NM) keep.add(x.s)
    })
  }
  // Caller's order, de-duplicated across venues.
  return list.filter((s) => keep.has(s))
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


// ---------------------------------------------------------------------------
// Météo-France LAND stations (RADOME)
// ---------------------------------------------------------------------------
//
// The gap this fills. Until now SSA called Météo-France only for /liste-bouees
// and /liste-bateaux, so at a FRENCH venue it drew American buoys, amateur
// Davis gardens and nothing from the national network. Measured around the
// Golfe de Saint-Tropez on 23 Oct 2026: ZERO public Davis stations within
// 5 nm, zero Pioupiou within 5 nm. RADOME is the only candidate for that
// circle, and Cap Camarat (Météo-France 83101001, 107 m) sits 4.8 nm from it.
//
// POLLER ONLY, and the reason is the endpoint shape. There is no bulk land
// "paquet" in DPObs v2 — /station/infrahoraire-6m takes ONE id_station at a
// time, so a set of thirty stations is thirty calls. Letting every map view
// spend that against a rate-limited free plan would be paying for panning.
// The poller takes it every half hour and the map reads wind_observations,
// exactly as it does for the Met Office.
//
// WHICH STATIONS. gradedPick around each venue: everything inside 5 nm,
// thinning to 4 nm spacing at 50 nm. The list is France-only, so this costs
// nothing at the venues outside France — they select zero stations and make
// zero calls beyond the shared station list.
export const MF_BASE_V2 = 'https://public-api.meteofrance.fr/public/DPObs/v2'

/** Per-station calls, so the selection is deliberately not large. */
export const MF_LAND_MAX = 40

/**
 * How many land stations the LIVE map fetches around a viewport.
 *
 * It was poller-only at first, on the reasoning that thirty stations is thirty
 * calls. That reasoning was right about the poller and wrong about the map:
 * the same route already makes 36 Davis calls per view, so six here is
 * proportionate — and the alternative is that Cap Camarat, the only station
 * inside the 5 nm circle at Saint-Tropez, does not appear until the next poll
 * has run and stored it. "Not visible after reload" is the symptom.
 */
export const MF_LAND_LIVE_MAX = 6

/**
 * The station list: the metadata map AND the subset that has a position.
 *
 * Both come out of one fetch because both callers need both — the positions to
 * choose stations and the metadata to name them and give them an altitude.
 * Cached for a day; stations do not move.
 */
export async function mfLandStations(): Promise<{
  meta: Map<string, MfStationMeta>
  placed: Array<{ id: string; lat: number; lon: number }>
} | null> {
  const key = process.env.METEOFRANCE_API_KEY
  if (!key) return null
  const r = await fetch(`${MF_BASE_V2}/liste-stations?format=csv`, {
    headers: { apikey: key, 'User-Agent': UA },
    next: { revalidate: 86400 },
  })
  if (!r.ok) throw new Error(`mf /liste-stations ${r.status}`)
  const meta = parseMfStationList(await r.text())
  const placed = Array.from(meta.entries())
    .filter(([, m]) => Number.isFinite(m.lat) && Number.isFinite(m.lon))
    .map(([id, m]) => ({ id, lat: m.lat as number, lon: m.lon as number }))
  return { meta, placed }
}

/**
 * The nearest land stations to a point, for the live map. Cached per station
 * for five minutes: the feed is six-minutely, so a shorter window would spend
 * the rate limit re-fetching the same row.
 */
export async function mfLandNear(lat: number, lon: number, nm: number): Promise<WindObs[]> {
  const key = process.env.METEOFRANCE_API_KEY
  if (!key) return []
  const list = await mfLandStations()
  if (!list) return []
  const { meta, placed } = list

  const near = placed
    .map((s) => ({ s, d: nmBetween(lat, lon, s.lat, s.lon) }))
    .filter((x) => x.d <= nm)
    .sort((a, b) => a.d - b.d)
    .slice(0, MF_LAND_LIVE_MAX)
    .map((x) => x.s)
  if (!near.length) return []

  const per = await mapPooled(near, DAVIS_MAP_CONCURRENCY, async (st) => {
    try {
      const r = await fetch(
        `${MF_BASE_V2}/station/infrahoraire-6m?id_station=${encodeURIComponent(st.id)}&format=csv`,
        { headers: { apikey: key, 'User-Agent': UA }, next: { revalidate: 300 } },
      )
      if (!r.ok) return null
      return latestPerStation(parseMfLand(parseMfCsv(await r.text()), meta, { stationId: st.id }))
    } catch {
      return null // one station being down is not an outage
    }
  })
  return per.flat()
}

export async function mfLandObs(ctx: PollContext): Promise<WindObs[]> {
  const key = process.env.METEOFRANCE_API_KEY
  if (!key) return []

  const mfGet = async (path: string) => {
    const r = await fetch(`${MF_BASE_V2}${path}`, {
      headers: { apikey: key, 'User-Agent': UA },
      cache: 'no-store',
    })
    if (!r.ok) throw new Error(`mf ${path} ${r.status}`)
    return r.text()
  }

  // `format` is REQUIRED — omitting it answers 400 wrapped in WSO2 XML that
  // reads like a bad key until you unpick it.
  const meta = parseMfStationList(await mfGet('/liste-stations?format=csv'))
  const placed = Array.from(meta.entries())
    .filter(([, m]) => Number.isFinite(m.lat) && Number.isFinite(m.lon))
    .map(([id, m]) => ({ id, lat: m.lat as number, lon: m.lon as number }))

  // Union across venues, nearest-venue-first, de-duplicated.
  const chosen = new Map<string, { id: string; lat: number; lon: number }>()
  for (const v of ctx.venues) {
    // Dense grades the whole 50 nm; idle takes the inner circle PLUS the
    // nearest few, which is what keeps Cap Camarat at 4.1 nm when the idle
    // radius is 3.
    for (const s of selectAroundVenue(placed, v)) {
      if (!chosen.has(s.id)) chosen.set(s.id, s)
    }
  }
  const list = Array.from(chosen.values()).slice(0, MF_LAND_MAX)
  if (!list.length) return []

  const per = await mapPooled(list, DAVIS_MAP_CONCURRENCY, async (st) => {
    try {
      const csv = await mfGet(`/station/infrahoraire-6m?id_station=${encodeURIComponent(st.id)}&format=csv`)
      return latestPerStation(parseMfLand(parseMfCsv(csv), meta, { stationId: st.id }))
    } catch {
      return null // one station being down is not an outage
    }
  })
  return per.flat()
}

/** Distance from a point to the nearest venue — used to report coverage. */
export function nmToNearestVenue(lat: number, lon: number): number {
  return Math.min(...VENUES.map((v) => nmBetween(v.lat, v.lon, lat, lon)))
}

/** Keep only what is near somewhere we sail, de-duplicated by station. */
export function nearAnyVenue(obs: WindObs[], decisions: VenueDecision[]): WindObs[] {
  const keep = new Map<string, WindObs>()
  for (const v of decisions) for (const o of withinNm(obs, v.lat, v.lon, keepRadiusNm(v))) keep.set(o.id, o)
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
  activation: ActivationInput = {},
): Promise<{ obs: WindObs[]; results: SourceResult[]; venues: VenueDecision[] }> {
  const ctx: PollContext = { venues: decideVenues(VENUES, activation) }
  const results: SourceResult[] = []
  const obs: WindObs[] = []
  for (const name of only) {
    const t0 = Date.now()
    try {
      const got = await RUNNERS[name](ctx)
      const near = nearAnyVenue(got, ctx.venues)
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
  return { obs: Array.from(byKey.values()), results, venues: ctx.venues }
}

/** WindObs → a wind_observations row. */
export function obsRow(o: WindObs) {
  return {
    station_id: o.id, t: o.t, source: o.source, name: o.name,
    lat: o.lat, lon: o.lon, tws_kn: o.twsKn, gust_kn: o.gustKn,
    twd_deg: o.twdDeg, height_m: o.heightM, surface: o.surface, trust: o.trust,
  }
}

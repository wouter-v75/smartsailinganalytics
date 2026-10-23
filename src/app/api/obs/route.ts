import { NextRequest, NextResponse } from 'next/server'
import { requireActiveUser } from '@/lib/supabase/admin-guard'
import { getServerSupabase } from '@/lib/supabase/server'
import { WEATHERLINK_EMBEDS } from '@/lib/windObsEmbeds'
import {
  davisMapNear, davisMapStations, collectObservations,
  portlogObs, portlogInReach, weatherfileObs, weatherfileNear,
  clubsObs, clubsNear, mfLandNear,
} from '@/lib/obsSources'
import { FORCE_ALL } from '@/lib/obsActivation'
import {
  OBS_STALE_MIN,
  parseMetar, parseFfvl, parseMfCsv, parseMfMarine, parseMfStationList,
  parseNdbc, parseNdbcStations, parsePioupiou, dropDuplicatesOf,
  parseWeatherLinkStations, parseWeatherLinkCurrent, parseWeatherLinkEmbed,
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

// A LARGE bbox silently returns a PARTIAL set, and the omission is systematic
// rather than random. Measured 22 Oct 2026 over SoCal: the whole 3.2°x2.3° box
// answered 33 stations (KAJO..KTOA); its north half alone answered 32 and its
// south half 3 — so the union is 35 and the whole box had quietly dropped two,
// MMTJ among them. The cut lands at the end of the id sort order, which means
// US K* stations crowd out everything foreign: M* (Mexico), C* (Canada), L*
// (Europe). At a venue near a border that reads as "no stations over there",
// which is exactly the wrong conclusion to draw from a map.
//
// So the box is split into tiles no larger than this and the answers merged.
// At the default 40 nm that is still one request; it only costs more where it
// would otherwise have lost data.
const METAR_TILE_DEG = 1.5
const METAR_MAX_TILES = 9

function metarTiles(la0: number, lo0: number, la1: number, lo1: number) {
  const nLat = Math.min(3, Math.max(1, Math.ceil((la1 - la0) / METAR_TILE_DEG)))
  const nLon = Math.min(3, Math.max(1, Math.ceil((lo1 - lo0) / METAR_TILE_DEG)))
  const out: Array<[number, number, number, number]> = []
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon && out.length < METAR_MAX_TILES; j++) {
      out.push([
        la0 + ((la1 - la0) * i) / nLat, lo0 + ((lo1 - lo0) * j) / nLon,
        la0 + ((la1 - la0) * (i + 1)) / nLat, lo0 + ((lo1 - lo0) * (j + 1)) / nLon,
      ])
    }
  }
  return out
}

async function metarAround(lat: number, lon: number, nm: number): Promise<WindObs[]> {
  const [la0, lo0, la1, lo1] = bbox(lat, lon, nm)
  const settled = await Promise.allSettled(
    metarTiles(la0, lo0, la1, lo1).map(async ([a, b, c, d]) => {
      const url = `https://aviationweather.gov/api/data/metar?bbox=${a},${b},${c},${d}&format=json`
      const res = await fetch(url, { headers: { 'User-Agent': UA }, next: { revalidate: CACHE_S } })
      if (!res.ok) throw new Error(`metar ${res.status}`)
      return parseMetar(await res.json())
    }),
  )
  const ok = settled.filter((r) => r.status === 'fulfilled')
  if (!ok.length) throw new Error('metar: every tile failed')
  // Tiles share edges, so the same station can arrive twice.
  const byId = new Map<string, WindObs>()
  for (const r of ok) for (const o of (r as PromiseFulfilledResult<WindObs[]>).value) byId.set(o.id, o)
  return Array.from(byId.values())
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

// NDBC (National Data Buoy Center) — US buoys and coastal stations. KEYLESS,
// one bulk file of ~865 stations, so it is always on and costs one request.
//
// This is what makes the American venues work. Measured 22 Oct 2026: the LA28
// course area off San Pedro has 8 wind-reporting stations inside 25 nm (nearest
// 1.5 nm), Long Beach 8 inside 30 nm, the San Juan Islands 7 inside 25 nm.
// It stops at the border, though — nothing within 30 nm of Ensenada.
const NDBC_OBS = 'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt'
const NDBC_STATIONS = 'https://www.ndbc.noaa.gov/data/stations/station_table.txt'

async function ndbcAround(): Promise<WindObs[]> {
  const [obsRes, stnRes] = await Promise.all([
    fetch(NDBC_OBS, { headers: { 'User-Agent': UA }, next: { revalidate: CACHE_S } }),
    // Names and TTYPE only; it moves when a station is commissioned, not hourly.
    fetch(NDBC_STATIONS, { headers: { 'User-Agent': UA }, next: { revalidate: 86400 } }),
  ])
  if (!obsRes.ok) throw new Error(`ndbc ${obsRes.status}`)
  // Without the table every station still reports — it falls back to the id
  // shape for buoy-vs-fixed and shows the station code instead of a name.
  const meta = stnRes.ok ? parseNdbcStations(await stnRes.text()) : new Map()
  return parseNdbc(await obsRes.text(), meta)
}

// Pioupiou / Windbird — KEYLESS, every station and its latest reading in one
// call. Community wind sensors put up by flying and kiting clubs, run as an
// open project by OpenWindMap after the original company went under.
//
// France and the Alps only: 16 fresh stations within 40 nm of St Tropez,
// nearest 4.6 nm, and none at all at Porto Cervo, the Solent, La Spezia or
// either American venue. Worth having for the Riviera, worth not expecting
// anywhere else.
const PIOUPIOU_URL = 'https://api.pioupiou.fr/v1/live-with-meta/all'

async function pioupiouAround(): Promise<WindObs[]> {
  const res = await fetch(PIOUPIOU_URL, { headers: { 'User-Agent': UA }, next: { revalidate: CACHE_S } })
  if (!res.ok) throw new Error(`pioupiou ${res.status}`)
  return parsePioupiou(await res.json())
}

// Davis WeatherLink — privately owned stations: clubs, race offices, coastal
// houses. The violet `pws` tier, and the one part of PredictWind's network that
// is copyable: theirs is fed by owners switching on this same integration.
//
// SCOPE: a key sees only what that ACCOUNT can see — stations it owns, ones
// shared with it, or public ones it paid to upgrade. Per-partner, not global.
// Absent entirely until both env vars are set.
//
// AUTH: api-key in the QUERY STRING, secret in the X-Api-Secret HEADER. Put the
// secret anywhere else and it falls onto a legacy signed path that 401s about a
// timestamp, which looks like a clock problem and is not one.
const WL_BASE = 'https://api.weatherlink.com/v2'
const WL_MAX_STATIONS = 25

async function wlFetch(path: string, key: string, secret: string, revalidate: number) {
  const sep = path.includes('?') ? '&' : '?'
  return fetch(`${WL_BASE}${path}${sep}api-key=${encodeURIComponent(key)}`, {
    headers: { 'X-Api-Secret': secret, 'User-Agent': UA },
    next: { revalidate },
  })
}

async function weatherlinkAround(): Promise<WindObs[]> {
  const key = process.env.WEATHERLINK_API_KEY
  const secret = process.env.WEATHERLINK_API_SECRET
  if (!key || !secret) return []

  const sRes = await wlFetch('/stations', key, secret, 86400)   // moves when a station is added
  if (!sRes.ok) throw new Error(`weatherlink stations ${sRes.status}`)
  const stations = parseWeatherLinkStations(await sRes.json())
  const ids = Array.from(stations.keys()).slice(0, WL_MAX_STATIONS)
  if (!ids.length) return []

  // One call per station, which is fine precisely because the scope is small.
  const settled = await Promise.allSettled(ids.map(async (id) => {
    const r = await wlFetch(`/current/${encodeURIComponent(id)}`, key, secret, CACHE_S)
    if (!r.ok) throw new Error(`weatherlink current ${id} ${r.status}`)
    return parseWeatherLinkCurrent(await r.json(), stations)
  }))
  // A station with no anemometer returns null rather than failing — most Davis
  // kit is temperature and rain, and that is not an observation here.
  return settled.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
}

// Davis WeatherLink EMBEDDABLE pages — KEYLESS. An owner who puts their station
// on their club's website publishes one of these, and it is backed by public
// JSON. No API account, no share, no Pro upgrade, no per-station fee, which is
// what makes a coastline of club stations reachable at all.
//
// The feed carries the readings AND THEIR UNITS; the station's name and
// position come from lib/windObsEmbeds.ts, which is ours to grow.
async function weatherlinkEmbeds(): Promise<WindObs[]> {
  if (!WEATHERLINK_EMBEDS.length) return []
  const settled = await Promise.allSettled(WEATHERLINK_EMBEDS.map(async (st) => {
    const url = `https://www.weatherlink.com/embeddablePage/summaryData/${encodeURIComponent(st.uuid)}`
    const r = await fetch(url, { headers: { 'User-Agent': UA }, next: { revalidate: CACHE_S } })
    if (!r.ok) throw new Error(`wl-embed ${st.uuid} ${r.status}`)
    return parseWeatherLinkEmbed(await r.json(), st)
  }))
  // One club's station going offline must not take the rest of the coast.
  return settled.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
}

// Public Davis stations near the clicked point — gardens, marinas, boatyards,
// a yacht club. KEYLESS, and they are what finally put a reading at the venues
// no official network reaches: 0.2 nm from Ensenada, 0.7 nm from St Tropez.
//
// Only the ones near THIS point, not all 43: one small call each is cheap, but
// forty of them on a map request is not, and the rest are at other venues.
async function davisMapAround(lat: number, lon: number, nm: number): Promise<WindObs[]> {
  const near = davisMapNear(lat, lon, nm)
  return near.length ? davisMapStations(near) : []
}

// Frost is one call for every Norwegian station we read, so the live map can
// afford it directly. It goes through collectObservations so there is ONE
// definition of how to call it, shared with the poller — this route having its
// own copy is what let frost and metoffice be stored for fifteen minutes at a
// time while never once appearing on the map.
/**
 * ABP Southampton's own met network: ONE call for the whole Solent cluster, so
 * the live map can afford it the way it affords frost.
 *
 * Gated on distance, which frost and ffvl are not — those cover a country, and
 * this covers one harbour. A viewport over Long Beach has no business fetching
 * Bramble Bank, and the gate is what stops a pan around California making a
 * request to a British port authority on every move.
 */
async function portlogAround(lat: number, lon: number, nm: number): Promise<WindObs[]> {
  if (!portlogInReach(lat, lon, nm)) return []
  return withinNm(await portlogObs(), lat, lon, nm)
}

/**
 * WeatherFile — the western Solent, and nothing else covers it.
 *
 * Only the latest row per station reaches the map; the rest of what the call
 * returns is history and belongs to the poller. Nothing is fetched at all when
 * no station is in the viewport, or when WEATHERFILE_TOKEN is unset, in which
 * case weatherfileObs returns an empty list without making a request.
 */
async function weatherfileAround(lat: number, lon: number, nm: number): Promise<WindObs[]> {
  const near = weatherfileNear(lat, lon, nm)
  if (!near.length) return []
  return latestPerStation(await weatherfileObs(near))
}

/** The open club and agency feeds near the viewport. Latest row each. */
async function clubsAround(lat: number, lon: number, nm: number): Promise<WindObs[]> {
  const near = clubsNear(lat, lon, nm)
  if (!near.length) return []
  return latestPerStation(await clubsObs(near))
}

/**
 * Météo-France LAND stations near the viewport — the national network, which
 * at a French venue is the only thing in the inner circle.
 *
 * Six stations, not the poller's forty: a per-station endpoint is affordable
 * here only because it is bounded. Absent entirely without the key.
 */
async function mfLandAround(lat: number, lon: number, nm: number): Promise<WindObs[]> {
  return withinNm(await mfLandNear(lat, lon, nm), lat, lon, nm)
}

async function frostLive(): Promise<WindObs[]> {
  // FORCED DENSE. Activation gates the POLLER, which runs unattended; a person
  // looking at the map is itself the answer to "is anybody interested in this
  // venue right now". Without this the live map would be clipped to the idle
  // radius and Frost would cover 10 nm instead of 60.
  const { obs } = await collectObservations(['frost'], { force: [FORCE_ALL] })
  return obs
}

/**
 * Whatever the poller has stored recently, for the sources this route does NOT
 * call live.
 *
 * Met Office is the case in point: 360 calls a day, so letting every map view
 * fetch it would spend the budget on panning. The poller takes it hourly and
 * the map reads the result. The same applies to anything rate-limited we add.
 *
 * It also makes the map survive an upstream outage — a station that answered
 * ten minutes ago still draws, faded by age, instead of vanishing.
 *
 * Only rows newer than the staleness limit, and the live copy always wins.
 */
async function storedAround(lat: number, lon: number, nm: number): Promise<WindObs[]> {
  const sb = getServerSupabase()
  const dLat = nm / 60
  const dLon = nm / (60 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)))
  const since = new Date(Date.now() - OBS_STALE_MIN * 60_000).toISOString()
  const { data, error } = await sb
    .from('wind_observations')
    .select('station_id, t, source, name, lat, lon, tws_kn, gust_kn, twd_deg, height_m, surface, trust')
    .gte('t', since)
    .gte('lat', lat - dLat).lte('lat', lat + dLat)
    .gte('lon', lon - dLon).lte('lon', lon + dLon)
    .order('t', { ascending: false })
    .limit(1500)
  if (error || !Array.isArray(data)) return []
  const rows: WindObs[] = data.map((r) => ({
    id: r.station_id as string,
    source: r.source as WindObs['source'],
    name: (r.name as string) || (r.station_id as string),
    lat: r.lat as number, lon: r.lon as number,
    heightM: (r.height_m as number | null) ?? null,
    elevM: null,
    surface: (r.surface as 'sea' | 'land') || 'land',
    twsKn: r.tws_kn as number,
    twdDeg: (r.twd_deg as number | null) ?? null,
    gustKn: (r.gust_kn as number | null) ?? null,
    t: new Date(r.t as string).toISOString(),
    trust: (r.trust as number) ?? 0,
  }))
  return latestPerStation(rows)
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
    ['ndbc', ndbcAround()],
    ['pioupiou', pioupiouAround()],
    ['weatherlink', weatherlinkAround()],
    ['davis', weatherlinkEmbeds()],
    ['davis-map', davisMapAround(lat, lon, nm)],
    ['frost', frostLive()],
    ['portlog', portlogAround(lat, lon, nm)],
    ['weatherfile', weatherfileAround(lat, lon, nm)],
    ['clubs', clubsAround(lat, lon, nm)],
    ['mf-land', mfLandAround(lat, lon, nm)],
    ['stored', storedAround(lat, lon, nm)],
  ]
  const settled = await Promise.allSettled(sources.map(([, p]) => p))

  const obs: WindObs[] = []
  const failed: string[] = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') obs.push(...r.value)
    else failed.push(sources[i][0])
  })

  // A curated embed and a public-map entry can be the SAME mast under two
  // different ids — Gurnard is in both. Position is all that connects them, and
  // the embed wins because it carries a 10-minute mean and a gust.
  const embeds = obs.filter((o) => o.id.startsWith('wle:'))
  const merged = embeds.length
    ? [...obs.filter((o) => !o.id.startsWith('wlmap:')),
       ...dropDuplicatesOf(obs.filter((o) => o.id.startsWith('wlmap:')), embeds)]
    : obs

  // Say which networks did not answer rather than passing a short list off as the
  // whole picture — "no stations near this venue" and "NOAA timed out" look
  // identical on a map otherwise.
  return NextResponse.json(
    { obs: withinNm(merged, lat, lon, nm), failed, at: new Date().toISOString() },
    { headers: { 'Cache-Control': `private, max-age=${CACHE_S}` } },
  )
}

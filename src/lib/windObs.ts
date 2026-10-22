// Live wind OBSERVATIONS for the wind-field map.
//
// One shape for every network, so nothing downstream knows or cares which one a
// reading came from. Fetching lives in /api/obs (server side — several of these
// need credentials, and one server fetch serves the whole team instead of every
// phone spending its own rate limit); this module is pure so it can be tested.
//
// THE POINT TO HOLD ON TO: an observation and the model's 10 m wind are not the
// same quantity, and four differences all push the observation LOW — sensor
// height, siting, averaging period, and land being rougher than the course. A
// station is therefore never just "the truth" to correct the model against. Each
// one carries its own height, surface and trust, and the map says which.
// Reasoning behind the whole feature: docs/wind-observations-2026-10.md.

export type ObsSourceKey = 'metar' | 'synop' | 'buoy' | 'ship' | 'beacon' | 'pws' | 'ours'

export interface WindObs {
  id: string
  source: ObsSourceKey
  name: string
  lat: number
  lon: number
  /** Anemometer height above ground/water, metres. null = the network does not publish it. */
  heightM: number | null
  /** Station ground elevation, metres. Not the anemometer height — an airport on a
   *  79 m hill still measures at 10 m AGL, but it is not measuring the race area. */
  elevM: number | null
  surface: 'sea' | 'land'
  /** Wind speed AS MEASURED, knots — never silently corrected. */
  twsKn: number
  /** Degrees the wind is FROM. null when the station reports variable or calm. */
  twdDeg: number | null
  gustKn: number | null
  /** Observation time, ISO UTC. */
  t: string
  /** 0..10, the same idea as the model WEIGHTS: a weak source contributes weakly. */
  trust: number
}

export const OBS_SOURCES: Record<ObsSourceKey, {
  label: string; colour: string; trust: number; surface: 'sea' | 'land'; heightM: number | null
}> = {
  // Airports: a known 10 m height, a defined 10-minute mean, a separate gust and
  // somebody maintaining the station. The best-behaved reading we can get — and
  // usually the furthest from the water.
  metar: { label: 'Airport', colour: '#3B82F6', trust: 7, surface: 'land', heightM: 10 },
  synop: { label: 'Synop', colour: '#34D399', trust: 7, surface: 'land', heightM: 10 },
  // Over the water, at the height the course is. Worth more than anything on land.
  buoy: { label: 'Buoy', colour: '#22D3EE', trust: 9, surface: 'sea', heightM: null },
  ship: { label: 'Ship', colour: '#E2E8F0', trust: 6, surface: 'sea', heightM: null },
  // Kite/paraglider spot beacons: close to the water and often the only thing on
  // the right beach, but sited for a sport rather than for measurement.
  beacon: { label: 'Spot beacon', colour: '#F59E0B', trust: 5, surface: 'land', heightM: null },
  // Rooftops and gardens. Kept deliberately low: the siting is unknown and usually bad.
  pws: { label: 'PWS', colour: '#A78BFA', trust: 2, surface: 'land', heightM: null },
  // Our own boat. A calibrated masthead anemometer sitting exactly where the race
  // is — the one source whose height, calibration and siting we actually know.
  ours: { label: 'Ours', colour: '#EC4899', trust: 10, surface: 'sea', heightM: null },
}

// Roughness lengths for the height correction. Sea matches the windweight
// reference (lib/windweight.ts Z0_REF); land is open country. These are the only
// two classes worth claiming — a rooftop in a town is not open country, which is
// exactly why a PWS gets trust 2 rather than a cleverer roughness.
const Z0 = { sea: 2e-4, land: 0.03 } as const

/**
 * Neutral log-law correction of a reading at `heightM` to the 10 m the models use.
 * Returns null when the height is unknown — a guessed height is worse than an
 * uncorrected number, because the correction then looks like a measurement.
 */
export function to10m(twsKn: number | null | undefined, heightM: number | null | undefined, surface: 'sea' | 'land'): number | null {
  if (twsKn == null || !Number.isFinite(twsKn) || twsKn < 0) return null
  if (heightM == null || !Number.isFinite(heightM) || heightM <= 0) return null
  const z0 = Z0[surface]
  if (heightM <= z0 * 1.01) return null
  return twsKn * (Math.log(10 / z0) / Math.log(heightM / z0))
}

/** The speed to compare with the model: height-corrected where we can, else null. */
export function obs10mKn(o: WindObs): number | null {
  return to10m(o.twsKn, o.heightM, o.surface)
}

export function ageMinutes(o: WindObs, nowMs: number = Date.now()): number | null {
  const t = Date.parse(o.t)
  if (Number.isNaN(t)) return null
  return (nowMs - t) / 60000
}

/** Past this, a station is lying rather than reporting. Drawn faded, then dropped. */
export const OBS_STALE_MIN = 90

export function isStale(o: WindObs, nowMs: number = Date.now(), maxMin: number = OBS_STALE_MIN): boolean {
  const a = ageMinutes(o, nowMs)
  return a == null || a > maxMin
}

// ── adapters ────────────────────────────────────────────────────────────────
// Each network gets one function from ITS raw JSON into WindObs[]. Anything the
// network does not give us stays null rather than being invented.

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Met convention: a direction lives in (0, 360], with north reported as 360. */
const normDeg = (d: number): number => {
  const m = ((d % 360) + 360) % 360
  return m === 0 ? 360 : m
}

/**
 * NOAA Aviation Weather Center METAR (aviationweather.gov/api/data/metar, JSON).
 * Keyless and worldwide. Speeds are already knots.
 *
 * Two traps in the real payload, both seen live on 18 Oct:
 *   `wdir` is a NUMBER or the STRING "VRB" — a naive parse turns variable wind
 *   into NaN degrees and points every barb at north.
 *   `00000KT` is calm: direction 0 with speed 0 means "no wind", not "from 000".
 */
export function parseMetar(rows: unknown[]): WindObs[] {
  const out: WindObs[] = []
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue          // a null in the array must not throw
    const o = r as Record<string, unknown>
    const lat = num(o.lat); const lon = num(o.lon); const wspd = num(o.wspd)
    if (lat == null || lon == null || wspd == null) continue          // no wind = not an observation
    const obsTime = num(o.obsTime)
    const t = obsTime != null ? new Date(obsTime * 1000).toISOString()
      : (typeof o.reportTime === 'string' ? new Date(`${o.reportTime.replace(' ', 'T')}`).toISOString() : null)
    if (!t || t.startsWith('Invalid')) continue
    const rawDir = o.wdir
    const dir = typeof rawDir === 'number' && Number.isFinite(rawDir) ? rawDir : null
    const calm = wspd === 0
    const id = typeof o.icaoId === 'string' && o.icaoId ? o.icaoId : `${lat.toFixed(3)},${lon.toFixed(3)}`
    out.push({
      id: `metar:${id}`,
      source: 'metar',
      name: typeof o.name === 'string' && o.name ? o.name : id,
      lat, lon,
      heightM: OBS_SOURCES.metar.heightM,
      elevM: num(o.elev),
      surface: 'land',
      twsKn: wspd,
      // North is 360 in a METAR; 000 appears only in calm (00000KT), which the
      // `calm` test above has already nulled. A bare modulo flattens 360 to 0 and
      // the tooltip then reads "from 0°" for a northerly.
      twdDeg: calm || dir == null ? null : normDeg(dir),
      gustKn: num(o.wgst),
      t,
      trust: OBS_SOURCES.metar.trust,
    })
  }
  return out
}

/**
 * FFVL balise network (data.ffvl.fr) — ~200 French free-flight beacons, 5-minute
 * cadence, dense along the Med coast where nothing official is.
 *
 * NOT keyless, despite being open data: an unkeyed call answers
 * `error#3 : invalid FFVL key length`, and a key is requested by email from
 * informatique@ffvl.fr. Wired here so it works the day the key arrives; the route
 * skips this source while FFVL_API_KEY is unset.
 *
 * Speeds are km/h. The beacon's `balise_id` keys the two endpoints together, and
 * the mast height is not published — so these read as measured, height unknown.
 */
export function parseFfvl(releves: unknown[], balises: unknown[] = []): WindObs[] {
  const meta = new Map<string, Record<string, unknown>>()
  for (const b of Array.isArray(balises) ? balises : []) {
    if (!b || typeof b !== 'object') continue
    const o = b as Record<string, unknown>
    const id = o.idBalise ?? o.balise_id ?? o.id
    if (id != null) meta.set(String(id), o)
  }
  const out: WindObs[] = []
  for (const r of Array.isArray(releves) ? releves : []) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const id = o.idbalise ?? o.idBalise ?? o.balise_id ?? o.id
    if (id == null) continue
    const m = meta.get(String(id)) || {}
    const lat = num(o.latitude) ?? num(m.latitude)
    const lon = num(o.longitude) ?? num(m.longitude)
    const kmh = num(o.vitesseVentMoy) ?? num(o.wind_speed_avg) ?? num(o.speed)
    if (lat == null || lon == null || kmh == null) continue
    const dir = num(o.directVentMoy) ?? num(o.wind_heading) ?? num(o.direction)
    const gustKmh = num(o.vitesseVentMax) ?? num(o.wind_speed_max)
    const when = o.date ?? o.lastUpdate ?? o.time
    const t = typeof when === 'string' ? isoFromFfvl(when) : null
    if (!t) continue
    out.push({
      id: `ffvl:${id}`,
      source: 'beacon',
      name: (typeof m.nom === 'string' && m.nom) || (typeof o.nom === 'string' && o.nom) || `FFVL ${id}`,
      lat, lon,
      heightM: null,                       // mast height is not published
      elevM: num(m.altitude),
      surface: 'land',
      twsKn: kmh * 0.539957,
      twdDeg: dir == null ? null : normDeg(dir),
      gustKn: gustKmh == null ? null : gustKmh * 0.539957,
      t,
      trust: OBS_SOURCES.beacon.trust,
    })
  }
  return out
}

// FFVL stamps "YYYY-MM-DD HH:MM:SS" in PARIS local time with no zone marker —
// the same trap as the log exports (see CLAUDE.md). Read as UTC it is an hour or
// two in the future, which would make every beacon look fresher than it is and
// then abruptly stale. The offset is applied by the caller's tz helper; here we
// only refuse to pretend a zone-less stamp is UTC.
export function isoFromFfvl(s: string, offsetHours = 0): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s.trim())
  if (!m) {
    const d = Date.parse(s)
    return Number.isNaN(d) ? null : new Date(d).toISOString()
  }
  const [, y, mo, da, h, mi, se] = m
  const ms = Date.UTC(+y, +mo - 1, +da, +h - offsetHours, +mi, +(se || 0))
  return new Date(ms).toISOString()
}


// ── Météo-France marine: buoys and partner ships ────────────────────────────
// DPObs **v2** (public-api.meteofrance.fr/public/DPObs/v2), METEOFRANCE_API_KEY.
//
// WHY THESE ARE THE PRIZE: every other network in this file measures over LAND
// and then needs a height correction we usually cannot make, because the mast
// height is unpublished. A buoy sits on the water, at the height the race is,
// with nothing upwind of it. Trust 9, against 7 for an airport and 2 for a roof.
//
// THREE THINGS LEARNED FROM THE WIRE (scripts/mf-obs-probe.ts, 22 Oct 2026),
// each of which contradicts the obvious reading of the docs:
//
//  1. **v1 is SUSPENDED.** It answers 500 with
//     `[State : SUSPENDED]` on every path. Only v2 serves. Subscribing to v1
//     costs nothing and gains nothing.
//  2. **`/liste-bouees` is NOT a station list.** Despite the name, it returns
//     the full observations for EVERY buoy over the retention window — position,
//     wind, pressure, sea state, the lot. So buoys cost ONE bulk call and no
//     per-station requests at all. `/liste-bateaux`, confusingly, really is just
//     a list: `geo_id_wmo;geo_id_wigos;name`, no position and no wind.
//  3. **Everything is SI.** `t` comes back as 302.15 (K, = 29 °C at the Antilles
//     buoy), `pmer` as 101470 (Pa). That is the corroboration that `ff` is m/s
//     and not km/h — the single most expensive thing to get wrong here.
//
// The window holds SEVERAL rows per buoy (02:00 and 13:00 in the same file), so
// a reader must take the newest per station or it draws this morning's wind.

/** MF publishes wind in m/s (`ff`). Knots is what everything downstream speaks. */
const MS_TO_KN = 1.943844

// A unit error is the failure this file most has to fear: reading km/h as m/s
// multiplies every speed by 3.6 and still produces a plausible-looking number on
// a light day. 35 kn of real breeze then reads 126 kn, so anything past this is
// refused rather than drawn. Deliberately far above any sailable wind — this is
// a units tripwire, not a weather filter.
const MAX_PLAUSIBLE_KN = 120

const pickNum = (o: Record<string, unknown>, keys: readonly string[]): number | null => {
  for (const k of keys) {
    const v = num(o[k])
    if (v != null) return v
  }
  return null
}

const pickStr = (o: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

// Confirmed against the live v2 header on 22 Oct 2026:
//   lat;lon;geo_id_wmo;geo_id_wigos;name;reference_time;insert_time;
//   validity_time;t;td;u;dd;ff;pmer;tmer;haut_vag;per_moy_vag;dir_vag;rafper;per
// `rafper` is the gust (rafale sur période) and is the one nobody would guess —
// it is not fxi/fx/fxy, which is what the land stations use.
const MF_KEYS = {
  speed: ['ff'],
  dir: ['dd'],
  gust: ['rafper', 'fxi', 'fx'],
  lat: ['lat', 'latitude'],
  lon: ['lon', 'longitude'],
  id: ['geo_id_wmo', 'geo_id_wigos', 'id_station', 'numer_sta'],
  name: ['name', 'nom_usuel', 'nom'],
  time: ['validity_time', 'reference_time'],
} as const

/**
 * Météo-France answers `format=csv` with a `;`-separated table, headers on line 1.
 *
 * Numeric cells are converted so the adapters can share one `num()` with the JSON
 * sources, with two carve-outs that matter:
 *   an EMPTY cell becomes undefined, never 0 — `Number('')` is 0, and a missing
 *   pressure silently reading as zero is the kind of thing nobody notices;
 *   an *_id_* column stays a STRING, because `geo_id_wmo` is "4100230" for a buoy
 *   but "ADFBKUM" for a ship, and coercing would eat a leading zero.
 */
export function parseMfCsv(text: string): Record<string, unknown>[] {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return []
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ','
  const head = lines[0].split(sep).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''))
  const out: Record<string, unknown>[] = []
  for (const line of lines.slice(1)) {
    const cells = line.split(sep)
    const row: Record<string, unknown> = {}
    head.forEach((h, i) => {
      const raw = (cells[i] ?? '').trim().replace(/^"|"$/g, '')
      if (!raw) return                                   // empty stays ABSENT, not 0
      if (h.includes('id')) { row[h] = raw; return }      // ids are opaque strings
      const n = Number(raw)
      row[h] = Number.isFinite(n) ? n : raw
    })
    if (Object.keys(row).length) out.push(row)
  }
  return out
}

/**
 * One row of Météo-France marine data into a WindObs.
 *
 * `kind` picks the source, and with it the trust and the legend colour — the
 * payloads are the same shape, so nothing else differs between a buoy and a ship.
 *
 * heightM stays null: Météo-France does not publish the anemometer height for
 * either, and a guessed height is worse than none (to10m refuses it, and the
 * reading shows as measured rather than as a correction nobody can check).
 */
export function parseMfMarine(
  rows: unknown[],
  kind: 'buoy' | 'ship',
  meta: Map<string, { name?: string; lat?: number; lon?: number }> = new Map(),
): WindObs[] {
  const out: WindObs[] = []
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const rawId = pickStr(o, MF_KEYS.id)
    if (rawId == null) continue
    const m = meta.get(rawId) || {}
    const lat = pickNum(o, MF_KEYS.lat) ?? (m.lat ?? null)
    const lon = pickNum(o, MF_KEYS.lon) ?? (m.lon ?? null)
    const ms = pickNum(o, MF_KEYS.speed)
    if (lat == null || lon == null || ms == null) continue

    const twsKn = ms * MS_TO_KN
    if (!(twsKn >= 0) || twsKn > MAX_PLAUSIBLE_KN) continue

    const when = pickStr(o, MF_KEYS.time)
    const t = when ? isoFromMf(when) : null
    if (!t) continue

    const dir = pickNum(o, MF_KEYS.dir)
    const gustMs = pickNum(o, MF_KEYS.gust)
    const gustKn = gustMs == null ? null : gustMs * MS_TO_KN

    out.push({
      id: `mf-${kind}:${rawId}`,
      source: kind,
      name: pickStr(o, MF_KEYS.name) ?? m.name ?? `${kind === 'buoy' ? 'Buoy' : 'Ship'} ${rawId}`,
      lat, lon,
      heightM: null,
      elevM: 0,                                  // it floats: ground level IS sea level
      surface: 'sea',
      twsKn,
      // Calm is reported as speed 0; a direction then means nothing. Same rule as
      // the METAR adapter, so the two cannot disagree on screen.
      twdDeg: ms === 0 || dir == null ? null : normDeg(dir),
      gustKn: gustKn != null && gustKn <= MAX_PLAUSIBLE_KN ? gustKn : null,
      t,
      trust: OBS_SOURCES[kind].trust,
    })
  }
  return out
}

/**
 * The bulk feed carries the whole retention window — the live file held the same
 * buoy at 02:00 and at 13:00. Keeping both would draw this morning's wind beside
 * this afternoon's and let `withinNm` sort them into a meaningless order, so a
 * station is reduced to its newest reading before anything else sees it.
 */
export function latestPerStation(obs: WindObs[]): WindObs[] {
  const best = new Map<string, WindObs>()
  for (const o of obs) {
    const prev = best.get(o.id)
    if (!prev || Date.parse(o.t) > Date.parse(prev.t)) best.set(o.id, o)
  }
  return Array.from(best.values())
}

/**
 * Météo-France stamps `validity_time` as ISO with a Z, confirmed on the wire.
 * Unlike the log exports and FFVL this one does carry its zone, so it is parsed
 * as given rather than shifted — but see CLAUDE.md on clocks: a zone-less stamp
 * is REFUSED rather than assumed to be UTC, because every other clock in this
 * project is venue-local even when it is called UTC.
 */
export function isoFromMf(s: string): string | null {
  const v = s.trim()
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v) && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v)) return null
  const d = Date.parse(v)
  return Number.isNaN(d) ? null : new Date(d).toISOString()
}

/**
 * `/liste-bateaux` really IS a list — `geo_id_wmo;geo_id_wigos;name`, with no
 * position and no wind. Returns id -> name so a ship's observation can be given
 * a name, since the data rows carry the id and not much else.
 */
export function parseMfStationList(csv: string): Map<string, { name?: string; lat?: number; lon?: number }> {
  const out = new Map<string, { name?: string; lat?: number; lon?: number }>()
  for (const row of parseMfCsv(csv)) {
    const id = pickStr(row, MF_KEYS.id)
    if (!id) continue
    out.set(id, {
      name: pickStr(row, MF_KEYS.name) ?? undefined,
      lat: pickNum(row, MF_KEYS.lat) ?? undefined,
      lon: pickNum(row, MF_KEYS.lon) ?? undefined,
    })
  }
  return out
}

// ── NDBC: US buoys and coastal stations ─────────────────────────────────────
// www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt — KEYLESS, one bulk file,
// ~865 stations, ~100 KB. The US counterpart of the Météo-France buoy feed and
// the thing that makes the American venues usable: measured 22 Oct 2026, the
// LA28 course area off San Pedro has EIGHT wind-reporting stations inside 25 nm
// (the nearest 1.5 nm), and the San Juan Islands have seven inside 25 nm.
//
// Whitespace-separated, two `#` header lines, and `MM` wherever a value is
// missing. Columns:
//   STN LAT LON YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY
//   ATMP WTMP DEWP VIS TIDE
// WSPD and GST are m/s, WDIR degrees true, the stamp is UTC.
//
// TWO THINGS THE FEED GETS WRONG IF READ NAIVELY:
//
//  1. **Most rows have no wind.** Waverider and water-quality stations are in
//     the same file with `MM` in every wind column — 14 stations within 25 nm of
//     San Pedro, only 8 of them with an anemometer. A row with no WSPD is not an
//     observation and is dropped.
//  2. **Not everything in it floats.** A numeric id like 46088 is a moored buoy;
//     FRDW1 and AGXC1 are fixed structures — a tide gauge on a pier, a light on
//     a breakwater. Calling those "buoy" would claim trust 9 and a sea-level
//     elevation for an instrument bolted to a lighthouse. The station table's
//     TTYPE settles it, and without metadata the id shape is the fallback.

/** NDBC marks every missing value `MM`, in any column. */
const ndbcNum = (v: string | undefined): number | null => {
  if (!v || v === 'MM') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * station_table.txt: `STATION_ID|OWNER|TTYPE|HULL|NAME|…`, pipe-separated.
 * Ids are LOWERCASE in this file and uppercase in the observations, which is a
 * silent way to join nothing at all.
 */
export function parseNdbcStations(text: string): Map<string, { name?: string; ttype?: string }> {
  const out = new Map<string, { name?: string; ttype?: string }>()
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    const p = line.split('|')
    if (p.length < 5) continue
    const id = p[0].trim().toLowerCase()
    if (!id) continue
    out.set(id, { ttype: p[2].trim() || undefined, name: p[4].trim() || undefined })
  }
  return out
}

/**
 * Is this thing floating? TTYPE is authoritative where we have it — "Buoy",
 * "Moored Buoy", "3-meter discus buoy" all float; "C-MAN Station", "Water Level
 * Observation Network", "Oil Platform" do not. Falling back to the id shape:
 * NDBC numbers its buoys (46088) and letters its fixed stations (SISW1).
 */
export function ndbcIsBuoy(id: string, ttype?: string): boolean {
  if (ttype) return /buoy/i.test(ttype)
  return /^\d+$/.test(id)
}

export function parseNdbc(
  text: string,
  meta: Map<string, { name?: string; ttype?: string }> = new Map(),
): WindObs[] {
  const out: WindObs[] = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    const f = line.trim().split(/\s+/)
    if (f.length < 11) continue
    const [stn, latS, lonS, yS, moS, dS, hS, miS, wdirS, wspdS, gstS] = f
    // Refuse a realtime2 (history) row fed in here by mistake. It has no LAT/LON
    // so every index shifts by two, and the MONTH would be read as a latitude —
    // producing a confident buoy at 10N 22E, in the Sahara. The station id of a
    // real row is never a four-digit year.
    if (/^\d{4}$/.test(stn) && Number(stn) >= 1990 && Number(stn) <= 2200) continue
    const lat = ndbcNum(latS); const lon = ndbcNum(lonS); const wspd = ndbcNum(wspdS)
    if (lat == null || lon == null || wspd == null) continue   // no anemometer = not an observation

    const y = ndbcNum(yS); const mo = ndbcNum(moS); const d = ndbcNum(dS)
    const h = ndbcNum(hS); const mi = ndbcNum(miS)
    if (y == null || mo == null || d == null || h == null || mi == null) continue
    const t = new Date(Date.UTC(y, mo - 1, d, h, mi)).toISOString()

    const m = meta.get(stn.toLowerCase()) || {}
    const buoy = ndbcIsBuoy(stn, m.ttype)
    const kind: ObsSourceKey = buoy ? 'buoy' : 'synop'
    const dir = ndbcNum(wdirS)
    const gst = ndbcNum(gstS)
    const twsKn = wspd * MS_TO_KN
    if (!(twsKn >= 0) || twsKn > MAX_PLAUSIBLE_KN) continue
    const gustKn = gst == null ? null : gst * MS_TO_KN

    out.push({
      id: `ndbc:${stn}`,
      source: kind,
      name: m.name || stn,
      lat, lon,
      // NDBC does not put anemometer height in either file, and it genuinely
      // varies — ~4 m on a discus buoy, 10-30 m on a lighthouse. Guessing is
      // worse than not correcting, so to10m refuses and the number shows as
      // measured. Same contract as the Météo-France buoys.
      heightM: null,
      elevM: buoy ? 0 : null,          // a buoy floats; a C-MAN sits on something
      surface: buoy ? 'sea' : 'land',
      twsKn,
      twdDeg: wspd === 0 || dir == null ? null : normDeg(dir),
      gustKn: gustKn != null && gustKn <= MAX_PLAUSIBLE_KN ? gustKn : null,
      t,
      trust: OBS_SOURCES[kind].trust,
    })
  }
  return out
}

// ── history ─────────────────────────────────────────────────────────────────
// What a station did over the last few hours, which is a different question
// from what it says now — a 12 kn reading means one thing on a steady trace and
// another on one that has climbed 6 kn in forty minutes.
//
// Deliberately NOT WindObs: a trace is one station, so repeating its name,
// position, surface and trust on every sample would be sixty copies of the same
// four facts. The caller already has the station.

export interface ObsPoint {
  /** ISO UTC. */
  t: string
  twsKn: number
  gustKn: number | null
  twdDeg: number | null
}

/** A station's own observations, as points, oldest first. */
export function toObsPoints(obs: WindObs[]): ObsPoint[] {
  return obs
    .map((o) => ({ t: o.t, twsKn: o.twsKn, gustKn: o.gustKn, twdDeg: o.twdDeg }))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
}

/** Trim to a window, and drop anything stamped in the future. */
export function withinHours(pts: ObsPoint[], hours: number, nowMs: number = Date.now()): ObsPoint[] {
  const from = nowMs - hours * 3600_000
  return pts.filter((p) => {
    const t = Date.parse(p.t)
    return Number.isFinite(t) && t >= from && t <= nowMs + 5 * 60_000
  })
}

/**
 * NDBC's per-station file, www.ndbc.noaa.gov/data/realtime2/<STN>.txt — the last
 * 45 days at 10-minute cadence.
 *
 * A DIFFERENT SHAPE from latest_obs.txt, which is the trap: there is no LAT/LON,
 * so the row starts at the year and every column index shifts by two. Reading it
 * with the other parser silently takes the MONTH as a latitude.
 *   #YY  MM DD hh mm WDIR WSPD GST  WVHT ...
 */
export function parseNdbcHistory(text: string): ObsPoint[] {
  const out: ObsPoint[] = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    const f = line.trim().split(/\s+/)
    if (f.length < 8) continue
    const y = ndbcNum(f[0]); const mo = ndbcNum(f[1]); const d = ndbcNum(f[2])
    const h = ndbcNum(f[3]); const mi = ndbcNum(f[4])
    const wspd = ndbcNum(f[6])
    if (y == null || mo == null || d == null || h == null || mi == null || wspd == null) continue
    // A four-digit year is the giveaway that this really is the history format.
    if (y < 1990 || y > 2200) continue
    const twsKn = wspd * MS_TO_KN
    if (!(twsKn >= 0) || twsKn > MAX_PLAUSIBLE_KN) continue
    const dir = ndbcNum(f[5])
    const gst = ndbcNum(f[7])
    const gustKn = gst == null ? null : gst * MS_TO_KN
    out.push({
      t: new Date(Date.UTC(y, mo - 1, d, h, mi)).toISOString(),
      twsKn,
      gustKn: gustKn != null && gustKn <= MAX_PLAUSIBLE_KN ? gustKn : null,
      twdDeg: wspd === 0 || dir == null ? null : normDeg(dir),
    })
  }
  return out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
}

// ── Pioupiou / Windbird ─────────────────────────────────────────────────────
// api.pioupiou.fr/v1/live-with-meta/all — KEYLESS, every station with its
// metadata and latest reading in ONE call (~660 KB, 758 stations measured
// 22 Oct 2026).
//
// Solar, SIGFOX-connected wind sensors put up by flying and kiting clubs and by
// individuals. The company went bankrupt; OpenWindMap bought the network out of
// liquidation and runs it as an open community project, which is why the data
// is open at all. Same kind of thing as an FFVL balise — sited for a sport
// rather than for measurement — so it carries the same `beacon` trust and
// colour rather than pretending to be an official station.
//
// WHAT IT IS AND IS NOT WORTH. Measured against our venues: 16 fresh stations
// within 40 nm of St Tropez, nearest 4.6 nm. ZERO at Porto Cervo, the Solent,
// La Spezia, San Juan Islands or Long Beach. It is France (plus the Alps), and
// nothing else — worth having for the Riviera and worth not expecting elsewhere.
//
// UNITS ARE km/h, which the distribution confirms rather than the docs: across
// 668 fresh stations the fastest was 44, i.e. 23.8 kn. Read as m/s that is
// 85 kn, and the 95th percentile would be 43 kn — a continent-wide storm that
// was not happening.
//
// DIRECTION is where the wind comes FROM, same as everything else here. Checked
// on the wire rather than assumed: at 15:30 UTC the three airports around
// St Tropez reported 240-260 deg, and the Pioupiou stations between them read
// 242-270.

/** One Pioupiou/Windbird station record into a WindObs. */
export function parsePioupiou(payload: unknown): WindObs[] {
  const rows = (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data))
    ? (payload as { data: unknown[] }).data
    : (Array.isArray(payload) ? payload : [])
  const out: WindObs[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const meta = (o.meta || {}) as Record<string, unknown>
    const loc = (o.location || {}) as Record<string, unknown>
    const me = (o.measurements || {}) as Record<string, unknown>

    const lat = num(loc.latitude); const lon = num(loc.longitude)
    const kmh = num(me.wind_speed_avg)
    if (lat == null || lon == null || kmh == null) continue
    // A station whose own GPS fix failed is somewhere unknown, and a barb drawn
    // at an unknown place is worse than no barb.
    if (loc.success === false) continue

    const t = typeof me.date === 'string' ? isoFromMf(me.date) : null
    if (!t) continue

    const twsKn = kmh * 0.539957
    if (!(twsKn >= 0) || twsKn > MAX_PLAUSIBLE_KN) continue
    const gustKmh = num(me.wind_speed_max)
    const gustKn = gustKmh == null ? null : gustKmh * 0.539957
    const dir = num(me.wind_heading)
    const id = num(o.id) ?? (typeof o.id === 'string' ? o.id : null)
    if (id == null) continue

    out.push({
      id: `piou:${id}`,
      source: 'beacon',
      name: (typeof meta.name === 'string' && meta.name.trim()) || `Windbird ${id}`,
      lat, lon,
      heightM: null,                     // mast height is not published
      elevM: null,
      surface: 'land',
      twsKn,
      twdDeg: kmh === 0 || dir == null ? null : normDeg(dir),
      gustKn: gustKn != null && gustKn <= MAX_PLAUSIBLE_KN ? gustKn : null,
      t,
      trust: OBS_SOURCES.beacon.trust,
    })
  }
  return out
}

/** Nearest-first, and never show a station from the next sea. */
export function withinNm(obs: WindObs[], lat: number, lon: number, nm: number): WindObs[] {
  const cos = Math.cos((lat * Math.PI) / 180)
  const d2 = (o: WindObs) => {
    const dLat = (o.lat - lat) * 60
    const dLon = (o.lon - lon) * 60 * cos
    return dLat * dLat + dLon * dLon
  }
  return obs.filter((o) => d2(o) <= nm * nm).sort((a, b) => d2(a) - d2(b))
}

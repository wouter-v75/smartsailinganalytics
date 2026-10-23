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

export type ObsSourceKey = 'metar' | 'synop' | 'buoy' | 'ship' | 'port' | 'beacon' | 'pws' | 'ours'

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
  // A harbour authority's own met network: Bramble, Calshot, Nab Tower and the
  // dockside masts, published by the people who run the port and relied on by
  // pilots bringing ships in. Professionally sited, maintained and calibrated,
  // and — the part no garden station can match — sitting OUT IN THE FAIRWAY
  // rather than behind a hedge. Below a buoy only because the network does not
  // publish anemometer heights, so nothing can be corrected to 10 m; above a
  // METAR because an airport is well-behaved but miles from the water.
  port: { label: 'Harbour authority', colour: '#84CC16', trust: 8, surface: 'sea', heightM: null },
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
  // `rafper` is the BUOY gust. The land stations use `raf10` — the maximum
  // over the last ten minutes, with `ddraf10` as its direction. Neither fxi
  // nor fx appears in the land payload at all, and they were in this list on
  // an inference that cost the whole source: measured against
  // /station/infrahoraire-6m on 23 Oct 2026.
  gust: ['rafper', 'raf10', 'fxi', 'fx'],
  lat: ['lat', 'latitude'],
  lon: ['lon', 'longitude'],
  // THE OBSERVATION ROWS AND THE STATION LIST DO NOT AGREE on what to call
  // the station, which is the single thing that stopped mf-land working:
  //   /liste-stations            Id_station;Id_omm;Nom_usuel;Latitude;...
  //   /station/infrahoraire-6m   lat;lon;geo_id_insee;reference_time;...
  // `geo_id_insee` was not in this list, so every land row was discarded for
  // having no id before any of its wind was looked at.
  id: ['geo_id_wmo', 'geo_id_wigos', 'geo_id_insee', 'id_station', 'numer_sta'],
  name: ['name', 'nom_usuel', 'nom'],
  time: ['validity_time', 'reference_time'],
  alt: ['alti', 'altitude', 'alt'],
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
export function parseMfStationList(csv: string): Map<string, MfStationMeta> {
  const out = new Map<string, MfStationMeta>()
  for (const row of parseMfCsv(csv)) {
    const id = pickStr(row, MF_KEYS.id)
    if (!id) continue
    out.set(id, {
      name: pickStr(row, MF_KEYS.name) ?? undefined,
      lat: pickNum(row, MF_KEYS.lat) ?? undefined,
      lon: pickNum(row, MF_KEYS.lon) ?? undefined,
      // Land stations publish an altitude and it matters: Cap Camarat's
      // climatological sheet puts it at 107 m, and a wind measured on a
      // headland is not a wind measured on the water.
      alt: pickNum(row, MF_KEYS.alt) ?? undefined,
    })
  }
  return out
}

export interface MfStationMeta { name?: string; lat?: number; lon?: number; alt?: number }

/**
 * Météo-France LAND stations — the RADOME network, which this app never read.
 *
 * It only ever called /liste-bouees and /liste-bateaux, so at a French venue
 * SSA was drawing American buoys, amateur Davis gardens and nothing from the
 * national network at all. There are no Davis stations within 5 nm of the
 * Golfe de Saint-Tropez and no Pioupiou either; RADOME is the only candidate
 * for that circle.
 *
 * SAME COLUMN VOCABULARY as the marine feeds — `ff` m/s, `dd` degrees,
 * `fxi`/`fx` gust — which is why this reuses MF_KEYS rather than inventing
 * names. Those were measured against the live buoy API on 22 Oct 2026. If the
 * land endpoint turns out to name them differently this returns NOTHING rather
 * than guessing, which is visible, and scripts/mf-land-probe.ts says so.
 *
 * Position and altitude come from the station list, not the reading: a land
 * station does not move, and the observation rows carry no geography.
 */
export function parseMfLand(
  rows: unknown[],
  meta: Map<string, MfStationMeta>,
  opts: { stationId?: string } = {},
): WindObs[] {
  const out: WindObs[] = []
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    // WHEN WE ASKED FOR ONE STATION WE ALREADY KNOW WHICH IT IS. Preferring
    // the caller's id over the row's is not belt-and-braces: the row names the
    // station `geo_id_insee` while the list names it `Id_station`, and nothing
    // promises those are the same string. The metadata lookup — name, altitude
    // — is keyed on the LIST's id, so using the caller's keeps them in step
    // whatever the row calls itself.
    const id = opts.stationId ?? pickStr(o, MF_KEYS.id)
    if (id == null) continue
    const m = meta.get(id)
    const lat = pickNum(o, MF_KEYS.lat) ?? m?.lat ?? null
    const lon = pickNum(o, MF_KEYS.lon) ?? m?.lon ?? null
    const ms = pickNum(o, MF_KEYS.speed)
    if (lat == null || lon == null || ms == null) continue
    if (lat === 0 && lon === 0) continue

    const twsKn = ms * MS_TO_KN
    if (!(twsKn >= 0) || twsKn > MAX_PLAUSIBLE_KN) continue

    const when = pickStr(o, MF_KEYS.time)
    const t = when ? isoFromMf(when) : null
    if (!t) continue

    const dir = pickNum(o, MF_KEYS.dir)
    const gustMs = pickNum(o, MF_KEYS.gust)
    const gustKn = gustMs == null ? null : gustMs * MS_TO_KN

    out.push({
      id: `mf-land:${id}`,
      source: 'synop',
      name: m?.name || `MF ${id}`,
      lat,
      lon,
      // RADOME measures at 10 m by convention, which is what the synop tier
      // already asserts — but it is not restated here as a measurement.
      heightM: OBS_SOURCES.synop.heightM,
      elevM: m?.alt ?? null,
      surface: 'land',
      twsKn,
      twdDeg: dir == null ? null : ((dir % 360) + 360) % 360,
      gustKn: gustKn != null && gustKn <= MAX_PLAUSIBLE_KN ? gustKn : null,
      t,
      trust: OBS_SOURCES.synop.trust,
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

// ── Davis WeatherLink ───────────────────────────────────────────────────────
// api.weatherlink.com/v2 — privately owned Davis stations: clubs, race offices,
// coastal houses. THIS IS THE VIOLET `pws` TIER: the siting is unknown and
// usually imperfect, so it is drawn and weighted as an amateur station however
// good the instrument is.
//
// WHY IT IS WORTH THE TROUBLE. This is the one part of PredictWind's network
// that is copyable. Their observations map is fed by owners enabling the Davis
// WeatherLink integration and emailing their station to support — no licensed
// feed involved. Davis is what yacht clubs, race committees and coastal houses
// actually own, which is exactly where our gaps are (the Solent, Italy).
//
// SCOPE, which is the thing to understand before expecting much: a key sees
// only the stations that ACCOUNT can see — ones it owns, ones shared with it,
// or public ones it has paid to upgrade. It is a per-partner integration, not a
// global network. One club sharing its station is one more barb on the map.
//
// AUTH: `api-key` as a QUERY PARAMETER and `X-Api-Secret` as a HEADER. Sending
// the secret anywhere but a header drops the request onto a legacy signed path
// and answers 401 complaining about a timestamp — which reads like a clock
// problem and is not one.
//
// UNITS ARE NOT VERIFIED. Davis hardware is natively mph and the v2 API serves
// US units, so that is the assumption, but no page in their docs states it and
// there is no key here to check with. mph read as knots is only 1.15x — small
// enough to look plausible all season, which is precisely how a unit error
// survives. scripts/weatherlink-probe.ts prints the raw number against all
// three readings so the first real key settles it.

/** Davis serves US units: mph. UNVERIFIED — see the probe. */
const MPH_TO_KN = 0.868976

// Field names differ by station generation, and a station that answers with the
// wrong generation's names simply vanishes. Vantage consoles use the short
// forms; a WeatherLink Live ISS uses the _last_10_min ones.
const WL_KEYS = {
  speed: ['wind_speed_avg_last_10_min', 'wind_speed_avg', 'wind_speed_last'],
  dir: ['wind_dir_scalar_avg_last_10_min', 'wind_dir_of_prevail', 'wind_dir_last', 'wind_dir'],
  gust: ['wind_speed_hi_last_10_min', 'wind_speed_hi', 'wind_gust_10_min'],
} as const

export interface WlStation { id: string; name?: string; lat?: number; lon?: number; elevM?: number }

/** `/v2/stations` → the positions and names, which the readings do not carry. */
export function parseWeatherLinkStations(payload: unknown): Map<string, WlStation> {
  const out = new Map<string, WlStation>()
  const rows = (payload && typeof payload === 'object' && Array.isArray((payload as { stations?: unknown }).stations))
    ? (payload as { stations: unknown[] }).stations : []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const id = o.station_id != null ? String(o.station_id) : null
    if (!id) continue
    out.set(id, {
      id,
      name: typeof o.station_name === 'string' ? o.station_name : undefined,
      lat: num(o.latitude) ?? undefined,
      lon: num(o.longitude) ?? undefined,
      // `elevation` is feet in US units; left alone rather than converted on a
      // guess, since nothing downstream uses it for arithmetic.
      elevM: undefined,
    })
  }
  return out
}

/**
 * `/v2/current/{station_id}` → a WindObs, or null when that station has no
 * anemometer. Many Davis stations are temperature-and-rain only, and a station
 * with no wind is not an observation.
 */
export function parseWeatherLinkCurrent(payload: unknown, stations: Map<string, WlStation>): WindObs | null {
  if (!payload || typeof payload !== 'object') return null
  const o = payload as Record<string, unknown>
  const id = o.station_id != null ? String(o.station_id) : null
  if (!id) return null
  const meta = stations.get(id)
  if (!meta || meta.lat == null || meta.lon == null) return null   // nowhere to draw it

  const sensors = Array.isArray(o.sensors) ? o.sensors : []
  let best: { mph: number; dir: number | null; gust: number | null; ts: number } | null = null
  for (const sRaw of sensors) {
    if (!sRaw || typeof sRaw !== 'object') continue
    const data = Array.isArray((sRaw as { data?: unknown }).data) ? (sRaw as { data: unknown[] }).data : []
    for (const dRaw of data) {
      if (!dRaw || typeof dRaw !== 'object') continue
      const d = dRaw as Record<string, unknown>
      const mph = pickNum(d, WL_KEYS.speed)
      const ts = num(d.ts)
      if (mph == null || ts == null) continue
      // Several sensors can report wind; keep the most recent.
      if (!best || ts > best.ts) {
        best = { mph, dir: pickNum(d, WL_KEYS.dir), gust: pickNum(d, WL_KEYS.gust), ts }
      }
    }
  }
  if (!best) return null

  const twsKn = best.mph * MPH_TO_KN
  if (!(twsKn >= 0) || twsKn > MAX_PLAUSIBLE_KN) return null
  const gustKn = best.gust == null ? null : best.gust * MPH_TO_KN

  return {
    id: `wl:${id}`,
    source: 'pws',
    name: meta.name || `Davis ${id}`,
    lat: meta.lat, lon: meta.lon,
    // Davis stations are mounted wherever the owner could mount them. The API
    // does not publish the anemometer height and a guess would be worse than
    // none, so the reading stands as measured — which is also why this tier is
    // weighted lowest.
    heightM: null,
    elevM: null,
    surface: 'land',
    twsKn,
    twdDeg: best.mph === 0 || best.dir == null ? null : normDeg(best.dir),
    gustKn: gustKn != null && gustKn <= MAX_PLAUSIBLE_KN ? gustKn : null,
    t: new Date(best.ts * 1000).toISOString(),
    trust: OBS_SOURCES.pws.trust,
  }
}

// ── Davis WeatherLink EMBEDDABLE pages ──────────────────────────────────────
// weatherlink.com/embeddablePage/summaryData/<uuid> — JSON, KEYLESS, no API
// account and no station share required.
//
// This is the good route into Davis, and it is a different thing from the v2
// API above. An owner who wants their station on their club's website publishes
// an "embeddable page"; that page is backed by a public JSON endpoint. Reading
// it is the use it was published for. No key, no share, no Pro upgrade, no
// per-station fee — which is what makes a Solent full of club stations reachable
// at all. The v2 API stays for stations actually shared with our account.
//
// FOUND VIA Windycator (weather.ianmillard.com/windycator), a Solent wind map
// that reads 24 stations around the western Solent this way. Its station LIST is
// its author's own work and is not copied here; what is used is the public
// technique, and the registry in windObsEmbeds.ts is ours to fill.
//
// THE UNITS ARE IN THE PAYLOAD — `unitLabel` on each value, "knots" or "mph" or
// "m/s" depending on what the OWNER set for display. That is worth dwelling on:
// every other source in this file made us infer units from a distribution or a
// doc, and get it wrong by 1.15x or 3.6x if we guessed. Here the feed says. So
// an unrecognised unit is REFUSED rather than assumed — the one case where
// refusing costs nothing, because the answer was supposed to be right there.

const UNIT_TO_KN: Record<string, number> = {
  knots: 1, knot: 1, kn: 1, kts: 1, kt: 1,
  mph: 0.868976,
  'm/s': 1.943844, mps: 1.943844,
  'km/h': 0.539957, kmh: 0.539957, kph: 0.539957,
}

/** One `currConditionValues` entry to knots, or null if the unit is unknown. */
function embedKn(v: { value?: unknown; unitLabel?: unknown } | undefined): number | null {
  if (!v) return null
  const n = num(v.value)
  if (n == null) return null
  const unit = typeof v.unitLabel === 'string' ? v.unitLabel.trim().toLowerCase() : ''
  const f = UNIT_TO_KN[unit]
  return f == null ? null : n * f
}

/** Where the embed station's name and position come from — the feed has neither. */
export interface EmbedStation { uuid: string; name: string; lat: number; lon: number; source?: ObsSourceKey }

export function parseWeatherLinkEmbed(payload: unknown, station: EmbedStation): WindObs | null {
  if (!payload || typeof payload !== 'object') return null
  const o = payload as Record<string, unknown>
  const vals = Array.isArray(o.currConditionValues) ? o.currConditionValues : []
  const by = new Map<string, { value?: unknown; unitLabel?: unknown }>()
  for (const v of vals) {
    if (!v || typeof v !== 'object') continue
    const name = (v as Record<string, unknown>).sensorDataName
    if (typeof name === 'string') by.set(name.toLowerCase(), v as { value?: unknown; unitLabel?: unknown })
  }

  // A 10-minute mean is the right quantity to compare with a model's 10 m wind;
  // the bare "Wind Speed" is an instantaneous sample and jumps about.
  const mean = embedKn(by.get('10 min avg wind speed'))
    ?? embedKn(by.get('2 min avg wind speed'))
    ?? embedKn(by.get('wind speed'))
  if (mean == null || !(mean >= 0) || mean > MAX_PLAUSIBLE_KN) return null

  const gust = embedKn(by.get('10 min high wind speed')) ?? embedKn(by.get('2 min high wind speed'))
  // Direction has no unit label; it is degrees.
  const dirRaw = by.get('wind direction')
  const dir = dirRaw ? num(dirRaw.value) : null

  const ms = num(o.lastReceived)
  if (ms == null) return null
  const t = new Date(ms).toISOString()

  const kind: ObsSourceKey = station.source || 'pws'
  return {
    id: `wle:${station.uuid}`,
    source: kind,
    name: station.name,
    lat: station.lat, lon: station.lon,
    heightM: null,          // never published for a club station
    elevM: null,
    surface: 'land',
    twsKn: mean,
    twdDeg: mean === 0 || dir == null ? null : normDeg(dir),
    gustKn: gust != null && gust <= MAX_PLAUSIBLE_KN ? gust : null,
    t,
    trust: OBS_SOURCES[kind].trust,
  }
}

// ── Davis WeatherLink PUBLIC MAP ────────────────────────────────────────────
// weatherlink.com/map/data — the index behind their public map: 79,522 public
// stations worldwide, each with an id and a position. Then
// /map/data/station/<id> gives that station's current conditions. KEYLESS.
//
// THIS IS THE ONE THAT SCALES. The embed registry in windObsEmbeds.ts is a
// hand-made list: every station on it had to be found on some club's website
// first. This finds them by POSITION, anywhere — 92 within 15 nm of Cowes, 33
// within 25 nm of St Tropez, the nearest of those being the Yacht Club de
// Saint-Tropez itself at 0.7 nm.
//
// These are stations their owners chose to make public, and this is the data
// behind the map anyone can open. Still `pws`, the lowest trust: a good
// instrument in an unknown garden is what the violet tier is for.
//
// WHAT IT DOES NOT GIVE: a gust, and the speed is a rounded integer rather than
// the embed's 10-minute mean to a decimal. So the curated embeds stay — they
// are richer where we have them, and this fills in everywhere else. A station
// that appears in both is dropped from this one by POSITION, because the two
// sources id the same station differently (32-hex for the embed, dashed UUID
// here) and nothing but the coordinates connects them.
//
// UNITS ARE IN THE PAYLOAD again (`windSpeedUnit`), so nothing is assumed.

export interface WlMapStation { id: string; lat: number; lon: number }

/** The index: one entry per public station, position only. */
export function parseWeatherLinkMapIndex(payload: unknown): WlMapStation[] {
  const rows = Array.isArray(payload) ? payload : []
  const out: WlMapStation[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id : null
    const lat = num(o.lat); const lon = num(o.lng)
    if (!id || lat == null || lon == null) continue
    out.push({ id, lat, lon })
  }
  return out
}

/**
 * One station's current conditions into a WindObs.
 *
 * `windDirection` comes back as the STRING "--" when the station is calm or has
 * no vane, which `Number('--')` turns into NaN and a naive parse into a barb
 * pointing at north. Same for the speed.
 */
export function parseWeatherLinkMapStation(payload: unknown, id: string): WindObs | null {
  if (!payload || typeof payload !== 'object') return null
  const o = payload as Record<string, unknown>

  const dash = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (typeof v !== 'string') return null
    const t = v.trim()
    if (!t || t === '--') return null          // their own "no value"
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }

  const raw = dash(o.windSpeed)
  const lat = num(o.lat); const lon = num(o.lng)
  if (raw == null || lat == null || lon == null) return null

  const unit = typeof o.windSpeedUnit === 'string' ? o.windSpeedUnit.trim().toLowerCase() : ''
  const f = UNIT_TO_KN[unit]
  // An unrecognised unit is refused, not guessed — the feed states it.
  if (f == null) return null
  const twsKn = raw * f
  if (!(twsKn >= 0) || twsKn > MAX_PLAUSIBLE_KN) return null

  // A reading with no time cannot be told from a station that died last March.
  const ts = num(o.lastTimestamp)
  if (ts == null || ts <= 0) return null

  const dir = dash(o.windDirection)
  const name = typeof o.sStation === 'string' && o.sStation.trim() ? o.sStation.trim() : `Davis ${id.slice(0, 8)}`

  return {
    id: `wlmap:${id}`,
    source: 'pws',
    name,
    lat, lon,
    heightM: null,
    elevM: null,
    surface: 'land',
    twsKn,
    twdDeg: raw === 0 || dir == null ? null : normDeg(dir),
    gustKn: null,          // the map detail carries none, and null says so
    t: new Date(ts * 1000).toISOString(),
    trust: OBS_SOURCES.pws.trust,
  }
}

/**
 * Drop map stations that are really one of our curated embeds.
 *
 * The two sources identify the same station differently — a 32-hex id for the
 * embed, a dashed UUID here — so position is the only thing connecting them.
 * 100 m is comfortably inside "the same mast" and nowhere near two real
 * stations on the same shore.
 */
export function dropDuplicatesOf(stations: WindObs[], known: WindObs[]): WindObs[] {
  const M_PER_DEG = 111_320
  return stations.filter((s) => !known.some((k) => {
    const dy = (k.lat - s.lat) * M_PER_DEG
    const dx = (k.lon - s.lon) * M_PER_DEG * Math.cos((s.lat * Math.PI) / 180)
    return Math.hypot(dx, dy) < 100
  }))
}

// ── Met Office Land Observations ────────────────────────────────────────────
// data.hub.api.metoffice.gov.uk/observation-land/1/<geohash>  (apikey header)
//
// Free plan: 360 calls a day, resetting 00:00 UTC. The data is HOURLY and one
// call returns 48 ROWS — two days of it — so polling this on every run
// would spend the budget four times over for nothing. Hourly is the cadence,
// and the 48 rows mean a gap is filled in on the next call rather than lost.
//
// THREE THINGS MEASURED RATHER THAN READ, none of them in reachable docs:
//
//  1. UNITS ARE m/s. Established across 373 paired hours against METAR at
//     EIGHT UK airports, each against ITS OWN nearest geohash: median
//     METAR_kn/value 2.045, where m/s predicts 1.94, knots 1.00, mph 0.87.
//     A first attempt got this BACKWARDS by comparing the geohash nearest
//     Cowes with the METAR at Southampton — two different places — and reading
//     the siting difference as a unit. One pair cannot separate the two.
//  2. `wind_direction` IS A COMPASS POINT STRING ("WSW"), not degrees. So the
//     resolution is 22.5°, and a parser expecting a number gets NaN.
//  3. /nearest returns geohashes with NO COORDINATES, so a station's position
//     has to be decoded from its geohash.
//
// WHAT IT IS WORTH. Stations are ~50 km apart and the direction is 16-point,
// so it is COARSER than the METAR we already have at UK airports. Its value is
// the 48 hours of history in one call, for places between the airports.

/** The 16-point compass, in the order the API uses them. */
const COMPASS: Record<string, number> = {
  N: 360, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
}

/** "WSW" to 247.5. Null for anything not a compass point — including "". */
export function compassToDeg(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const k = v.trim().toUpperCase()
  return k in COMPASS ? COMPASS[k] : null
}

/**
 * Geohash to the centre of its cell.
 *
 * Needed because /nearest hands back a geohash and an area name and no
 * coordinates at all. A six-character hash is about 1.2 km by 0.6 km, which is
 * finer than the ~50 km spacing of the stations themselves — so the cell
 * centre is a fair position for a barb, and far better than the area's name.
 */
const GEOHASH_B32 = '0123456789bcdefghjkmnpqrstuvwxyz'
export function geohashDecode(hash: unknown): { lat: number; lon: number } | null {
  if (typeof hash !== 'string' || !hash) return null
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180
  let isLon = true
  for (const ch of hash.toLowerCase()) {
    const idx = GEOHASH_B32.indexOf(ch)
    if (idx < 0) return null
    for (let bit = 4; bit >= 0; bit--) {
      const on = (idx >> bit) & 1
      if (isLon) {
        const mid = (lonMin + lonMax) / 2
        if (on) lonMin = mid; else lonMax = mid
      } else {
        const mid = (latMin + latMax) / 2
        if (on) latMin = mid; else latMax = mid
      }
      isLon = !isLon
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 }
}

export interface MetOfficeSite { geohash: string; name: string }

/**
 * The 48 hourly rows for one geohash, oldest first.
 *
 * Returns EVERY row, not just the newest: that is the point of this source.
 * The caller takes the last one for the map and stores the rest as history.
 */
export function parseMetOfficeLandObs(payload: unknown, site: MetOfficeSite): WindObs[] {
  const rows = Array.isArray(payload) ? payload : []
  const pos = geohashDecode(site.geohash)
  if (!pos) return []
  const out: WindObs[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const ms = num(o.wind_speed)
    const when = typeof o.datetime === 'string' ? o.datetime : null
    if (ms == null || !when) continue
    const t = isoFromMf(when)          // the stamps carry a Z; a zone-less one is refused
    if (!t) continue
    const twsKn = ms * 1.943844
    if (!(twsKn >= 0) || twsKn > MAX_PLAUSIBLE_KN) continue
    const gustMs = num(o.wind_gust)
    const gustKn = gustMs == null ? null : gustMs * 1.943844
    const dir = compassToDeg(o.wind_direction)
    out.push({
      id: `mo:${site.geohash}`,
      source: 'synop',
      name: site.name,
      lat: pos.lat, lon: pos.lon,
      // Met Office land stations are WMO-standard 10 m, which is the one height
      // in this file we can actually claim — so this reading IS directly
      // comparable with a model's 10 m wind, and to10m leaves it alone.
      heightM: 10,
      elevM: null,
      surface: 'land',
      twsKn,
      twdDeg: ms === 0 ? null : dir,
      gustKn: gustKn != null && gustKn <= MAX_PLAUSIBLE_KN ? gustKn : null,
      t,
      trust: OBS_SOURCES.synop.trust,
    })
  }
  return out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
}

// ── MET Norway Frost ────────────────────────────────────────────────────────
// frost.met.no/observations/v0.jsonld — the Norwegian official network, CC BY
// 4.0. HTTP Basic with the CLIENT ID as the username and an EMPTY PASSWORD;
// the secret is only for the OAuth2 token flow and need never be sent.
//
// THE BEST-DESCRIBED SOURCE IN THIS FILE, and it is not close. Every other
// network leaves us inferring something: Météo-France's units came from a
// distribution, NDBC publishes no anemometer height, the Davis map gives a
// rounded integer and no gust, and the Met Office states neither units nor
// degrees. Frost states, per reading:
//   the UNIT ("m/s", "degrees"),
//   the HEIGHT, as level.height_above_ground — so `heightM` is measured here
//     rather than assumed or left null,
//   a qualityCode, and an exposureCategory for the siting.
// Direction is wind_from_direction in DEGREES, matching our convention.
//
// NOT EVERY STATION MEASURES WIND. Of twelve sources within 8 nm of Viksfjord
// only four carry it and only ONE — Svenner Fyr, a lighthouse — carries speed,
// direction AND gust together, at 10-minute resolution. The rest are rain and
// temperature, or speed with no direction. So the site list is curated from
// availableTimeSeries rather than from "what is nearby".

/** Frost says `m/s` and `degrees`; anything else we do not recognise. */
const FROST_SPEED_TO_KN: Record<string, number> = { 'm/s': 1.943844, 'knot': 1, 'knots': 1, 'km/h': 0.539957 }

export interface FrostSite { id: string; name: string; lat: number; lon: number }

/**
 * One Frost observation record per station per time, into WindObs.
 *
 * `sourceId` arrives as "SN29950:0" — the suffix is the sensor number, and
 * stripping it is what matches a reading to its station.
 *
 * QUALITY: only `qualityCode` 0 is taken, which Frost documents as the value
 * being correct. The other codes describe corrections and suspicions we have
 * not studied, and a reading we cannot characterise is worth less than no
 * reading on a map people trim against.
 */
export function parseFrostObs(payload: unknown, sites: Map<string, FrostSite>): WindObs[] {
  const data = (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data))
    ? (payload as { data: unknown[] }).data : []
  const out: WindObs[] = []

  for (const rec of data) {
    if (!rec || typeof rec !== 'object') continue
    const r = rec as Record<string, unknown>
    const srcId = typeof r.sourceId === 'string' ? r.sourceId.split(':')[0] : null
    const when = typeof r.referenceTime === 'string' ? r.referenceTime : null
    if (!srcId || !when) continue
    const site = sites.get(srcId)
    if (!site) continue
    const t = isoFromMf(when)
    if (!t) continue

    const obs = Array.isArray(r.observations) ? r.observations : []
    let twsKn: number | null = null
    let gustKn: number | null = null
    let dir: number | null = null
    let heightM: number | null = null

    for (const oRaw of obs) {
      if (!oRaw || typeof oRaw !== 'object') continue
      const o = oRaw as Record<string, unknown>
      if (num(o.qualityCode) !== 0) continue        // see note above
      const el = typeof o.elementId === 'string' ? o.elementId : ''
      const v = num(o.value)
      if (v == null) continue
      const unit = typeof o.unit === 'string' ? o.unit.trim().toLowerCase() : ''

      // The height comes with the reading, which no other source here does.
      const lvl = (o.level && typeof o.level === 'object') ? o.level as Record<string, unknown> : null
      if (lvl && lvl.levelType === 'height_above_ground' && lvl.unit === 'm') {
        const h = num(lvl.value)
        if (h != null) heightM = h
      }

      if (el === 'wind_speed') {
        const f = FROST_SPEED_TO_KN[unit]
        if (f != null) twsKn = v * f
      } else if (el.startsWith('max(wind_speed_of_gust')) {
        const f = FROST_SPEED_TO_KN[unit]
        if (f != null) gustKn = v * f
      } else if (el === 'wind_from_direction' && unit === 'degrees') {
        dir = v
      }
    }

    if (twsKn == null || !(twsKn >= 0) || twsKn > MAX_PLAUSIBLE_KN) continue

    out.push({
      id: `frost:${srcId}`,
      source: 'synop',
      name: site.name,
      lat: site.lat, lon: site.lon,
      heightM,
      elevM: null,
      surface: 'land',
      twsKn,
      twdDeg: twsKn === 0 || dir == null ? null : normDeg(dir),
      gustKn: gustKn != null && gustKn <= MAX_PLAUSIBLE_KN ? gustKn : null,
      t,
      trust: OBS_SOURCES.synop.trust,
    })
  }
  return out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
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


// ---------------------------------------------------------------------------
// Port-Log — a harbour authority's own met network
// ---------------------------------------------------------------------------
//
// ABP Southampton publish theirs at abports.port-log.net, which is the
// "portlog" that Windycator carries and the reason Windycator has mid-Solent
// covered where a map built from garden stations does not. Bramble sits on the
// bank in the middle of the Solent; Nab Tower is out at the eastern approach.
//
// SHAPE. One JSON object, three levels deep and keyed by number at every one:
//
//   { "<idSite>": { "<idDataset>": { "<idParameter>": { …the reading… } } } }
//
// so a reading is found by parameter id, not by name. The ones that matter:
//
//   50002  Wind Speed       50003  Wind Direction      50006  Gust Speed
//
// Each record repeats its own site name, position, value, units and time, which
// is what makes this parseable without a station registry — unlike the Davis
// map, nothing has to be known in advance except which parameter ids to read.
//
// UNITS ARE READ, NEVER ASSUMED. Wind and gust come in Knots at every site
// today, and it would be easy to hardcode that. But the same feed publishes
// `Max 15 Minute Gust Speed` in **m/s** while its 5, 10, 20, 30 and 60 minute
// siblings are all in Knots. One parameter in a family of six disagreeing is
// exactly how a 20 kn gust becomes 39, so the unit on each record is what
// converts it and an unrecognised unit is refused.
//
// THE CLOCK IS CHECKED AGAINST ITSELF. Every record carries BOTH an absolute
// `DateTime` and a relative `Age` in seconds, and they are independent — so
// `now - DateTime` must come out near `Age`, and when it does not, the
// timestamp is not the thing we think it is. That matters more here than it
// looks: reading a local-time stamp as UTC is the mistake this project keeps
// paying for, and it is invisible in a single number. An hour's offset moves
// the two apart by 3600 s and the record is refused rather than drawn an hour
// out of date. The tolerance has to clear ordinary caching, which freezes
// `Age` while `now - DateTime` keeps growing, so it sits at 20 minutes: wide
// enough for a cached response, far short of an hour.
//
// A refused record disappears from the map, which is visible. A record drawn
// with the wrong hour is not.

const PORTLOG_PID = { wind: '50002', dir: '50003', gust: '50006' } as const

/** Seconds `Age` and `DateTime` may disagree before the record is refused. */
export const PORTLOG_CLOCK_TOL_SEC = 1200

export interface PortlogOptions {
  /**
   * Site codes in open water rather than inside the docks. Presentational
   * while the network publishes no anemometer heights — with `heightM` null
   * `to10m` refuses to correct anything, so `surface` changes no number — but
   * Bramble in the fairway and a mast behind a grain terminal are not the same
   * reading and the panel should not imply they are.
   */
  seaSites?: ReadonlySet<string>
  nowMs?: number
  clockTolSec?: number
}

type PortlogRec = Record<string, unknown>

const portlogRec = (v: unknown): PortlogRec | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as PortlogRec) : null

/** A record's value in knots, or null when the value or its unit is unusable. */
function portlogKn(r: PortlogRec | null): number | null {
  if (!r) return null
  const n = num(r.Value)
  if (n == null) return null
  const unit = typeof r.Units === 'string' ? r.Units.trim().toLowerCase() : ''
  const f = UNIT_TO_KN[unit]
  if (f == null) return null
  const kn = n * f
  return kn >= 0 && kn <= MAX_PLAUSIBLE_KN ? kn : null
}

export function parsePortlog(payload: unknown, opts: PortlogOptions = {}): WindObs[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const nowSec = (opts.nowMs ?? Date.now()) / 1000
  const tol = opts.clockTolSec ?? PORTLOG_CLOCK_TOL_SEC
  const sea = opts.seaSites ?? new Set<string>()
  const out: WindObs[] = []

  for (const [siteId, datasets] of Object.entries(payload as Record<string, unknown>)) {
    const ds = portlogRec(datasets)
    if (!ds) continue

    // The parameter sits under a dataset id we do not care about, so every
    // dataset is searched for the three ids that matter.
    let wind: PortlogRec | null = null
    let dir: PortlogRec | null = null
    let gust: PortlogRec | null = null
    for (const group of Object.values(ds)) {
      const g = portlogRec(group)
      if (!g) continue
      wind = wind ?? portlogRec(g[PORTLOG_PID.wind])
      dir = dir ?? portlogRec(g[PORTLOG_PID.dir])
      gust = gust ?? portlogRec(g[PORTLOG_PID.gust])
    }
    if (!wind) continue

    const twsKn = portlogKn(wind)
    const lat = num(wind.Latitude)
    const lon = num(wind.Longitude)
    if (twsKn == null || lat == null || lon == null) continue
    if (lat === 0 && lon === 0) continue

    const dt = num(wind.DateTime)
    if (dt == null || dt <= 0) continue
    const age = num(wind.Age)
    if (age != null && Math.abs(nowSec - dt - age) > tol) continue

    // Direction is only taken when the feed says it is in degrees.
    let twdDeg: number | null = null
    const dirUnit = dir && typeof dir.Units === 'string' ? dir.Units.trim().toLowerCase() : ''
    const dirVal = dir ? num(dir.Value) : null
    if (dirVal != null && dirUnit === 'deg') twdDeg = ((dirVal % 360) + 360) % 360

    const code = typeof wind.Site_Code === 'string' ? wind.Site_Code.trim() : ''
    const name = typeof wind.Site_Name === 'string' && wind.Site_Name.trim()
      ? wind.Site_Name.trim()
      : code || `Port-Log ${siteId}`
    const surface: 'sea' | 'land' = code && sea.has(code) ? 'sea' : 'land'

    out.push({
      id: `portlog:${siteId}`,
      source: 'port',
      name,
      lat,
      lon,
      heightM: null,
      elevM: null,
      surface,
      twsKn,
      twdDeg,
      gustKn: portlogKn(gust),
      t: new Date(dt * 1000).toISOString(),
      trust: OBS_SOURCES.port.trust,
    })
  }
  return out
}

/**
 * The signed `item` token out of a Port-Log cluster page.
 *
 * The endpoint does not take plain parameters: `item` is base64 of
 * `cluster=…&dataset=All&parameter=Latest&format=JSON&PIN=$F734`, and the PIN
 * signs the rest, so the token cannot be composed — only used as published.
 * Reading it from the page each time rather than hardcoding it means a rotated
 * PIN costs one extra request instead of a silent outage.
 */
export function parsePortlogLatestUrl(html: string): string | null {
  const m = /latest_url\s*=\s*["']([^"']+GetLatest\.php[^"']*)["']/.exec(html)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// WeatherFile.com averages.json
// ---------------------------------------------------------------------------
//
// See windObsWeatherfile.ts for how the units and the clock were pinned down.
// In short: wsa/wsh/wsl are mean/gust/lull in m/s, wda is the direction, `ts`
// is UTC, and all three were confirmed against Windycator's independent read
// of the same station at the same minute, to 0.1 kn.
//
// Returns EVERY row it is given, newest last. The caller keeps the newest for
// the map and the rest become history — the same contract as the Met Office
// land observations, and the reason one poll of this source fills a 6-hour
// graph instead of starting it.

/** How far ahead of now a row may be stamped before the feed is disbelieved. */
export const WEATHERFILE_FUTURE_TOL_SEC = 600

export function parseWeatherfile(
  payload: unknown,
  station: { locId: string; name: string; lat: number; lon: number; surface: 'sea' | 'land' },
  nowMs: number = Date.now(),
): WindObs[] {
  if (!payload || typeof payload !== 'object') return []
  const rows = (payload as { data?: unknown }).data
  if (!Array.isArray(rows)) return []

  const out: WindObs[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const row = r as Record<string, unknown>

    const mean = num(row.wsa)
    if (mean == null) continue
    const twsKn = mean * MS_TO_KN
    if (!(twsKn >= 0) || twsKn > MAX_PLAUSIBLE_KN) continue

    // `ts` is "YYYY-MM-DD HH:MM:SS", UTC, with no marker saying so — hence the
    // explicit Z rather than letting the runtime assume the server's zone.
    const ts = typeof row.ts === 'string' ? row.ts.trim() : ''
    const ms = Date.parse(`${ts.replace(' ', 'T')}Z`)
    if (!Number.isFinite(ms)) continue
    // A reading cannot be from the future. If this ever fires it means the feed
    // started stamping local time, which is the one mistake that is invisible
    // in the value itself.
    if (ms > nowMs + WEATHERFILE_FUTURE_TOL_SEC * 1000) continue

    const gust = num(row.wsh)
    const gustKn = gust == null ? null : gust * MS_TO_KN
    const dir = num(row.wda)

    out.push({
      id: `wf:${station.locId}`,
      source: 'beacon',
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      // The network publishes no anemometer heights, so nothing is corrected
      // to 10 m — a platform rail and a clubhouse roof are not the same.
      heightM: null,
      elevM: null,
      surface: station.surface,
      twsKn,
      twdDeg: dir == null ? null : ((dir % 360) + 360) % 360,
      gustKn: gustKn != null && gustKn <= MAX_PLAUSIBLE_KN ? gustKn : null,
      t: new Date(ms).toISOString(),
      trust: OBS_SOURCES.beacon.trust,
    })
  }
  return out
}

/**
 * A speed in a STATED unit, to knots — null when the unit is not one we know.
 *
 * Exported because several feeds name their own unit and the right response to
 * an unrecognised one is always the same: refuse it. A guessed unit is a 2x
 * error that looks like weather.
 */
export function knFromUnit(value: number | null, unit: string | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const u = typeof unit === 'string' ? unit.trim().toLowerCase() : ''
  const f = UNIT_TO_KN[u]
  if (f == null) return null
  const kn = value * f
  return kn >= 0 && kn <= MAX_PLAUSIBLE_KN ? kn : null
}

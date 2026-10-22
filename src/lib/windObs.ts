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
// DPObs (public-api.meteofrance.fr/public/DPObs/v1), key in METEOFRANCE_API_KEY.
//
// WHY THESE TWO ARE THE PRIZE: every other network in this file measures over
// LAND and then needs a height correction we usually cannot make, because the
// mast height is unpublished. A buoy sits on the water, at the height the race
// is, with nothing upwind of it. In OBS_SOURCES that is trust 9 against 7 for an
// airport and 2 for a rooftop — and it is the only reading whose SURFACE is the
// one the model is being checked over.
//
// Updated hourly at round hour + 10'. Buoy ids are 7 digits, ship ids 7
// characters, both from the matching /liste-* endpoint. France only.

/** MF publishes wind in m/s (`ff`). Knots is what everything downstream speaks. */
const MS_TO_KN = 1.943844

// A unit error is the failure this file most has to fear: reading km/h as m/s
// multiplies every speed by 3.6 and still produces a plausible-looking number on
// a light day. 35 kn of real breeze then reads 126 kn, so anything past this is
// refused rather than drawn. It is deliberately far above any sailable wind —
// this is a units tripwire, not a weather filter.
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
  }
  return null
}

// Several spellings per quantity on purpose. The wind codes are not documented
// publicly for the marine endpoints — `dd`/`ff`/`fxi` are the Météo-France and
// SYNOP convention and are what we expect, but the alternatives cost nothing and
// turn "the adapter returned zero rows" into "it just worked". Run
// scripts/mf-obs-probe.ts against a real key to see which one answers, then this
// list can be cut down to the truth.
const MF_KEYS = {
  speed: ['ff', 'vitesse_vent', 'wind_speed', 'ffm', 'vent_moyen'],
  dir: ['dd', 'direction_vent', 'wind_direction', 'ddm'],
  gust: ['fxi', 'fx', 'fxy', 'rafale', 'wind_gust'],
  lat: ['lat', 'latitude'],
  lon: ['lon', 'longitude'],
  id: ['id_station', 'numer_sta', 'num_sta', 'geo_id_insee', 'id'],
  name: ['nom_usuel', 'nom', 'name', 'libelle'],
  time: ['validity_time', 'reference_time', 'date', 'time'],
} as const

/**
 * One row of /bouees or /bateaux into a WindObs.
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
    const rawId = pickStr(o, MF_KEYS.id) ?? (pickNum(o, MF_KEYS.id)?.toString() ?? null)
    const m = (rawId && meta.get(rawId)) || {}
    const lat = pickNum(o, MF_KEYS.lat) ?? (m.lat ?? null)
    const lon = pickNum(o, MF_KEYS.lon) ?? (m.lon ?? null)
    const ms = pickNum(o, MF_KEYS.speed)
    if (lat == null || lon == null || ms == null || rawId == null) continue

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
 * Météo-France stamps `validity_time` as ISO. Unlike the log exports and FFVL
 * this one does carry its zone, so it is parsed as given rather than shifted —
 * but see CLAUDE.md on clocks: if the probe shows the newest observation sitting
 * an exact venue-offset in the future, this is the line that is wrong, not the
 * API. A bare "YYYY-MM-DD HH:MM:SS" with no zone is refused rather than assumed.
 */
export function isoFromMf(s: string): string | null {
  const v = s.trim()
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) {
    // No zone marker. Guessing costs an hour of silent error; say so instead.
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v)) return null
  }
  const d = Date.parse(v)
  return Number.isNaN(d) ? null : new Date(d).toISOString()
}

/**
 * The /liste-bouees and /liste-bateaux endpoints answer with CSV, not JSON.
 * Returns id -> position/name so a data row that omits its own coordinates can
 * still be placed, and so the caller can pick the handful of stations near the
 * venue BEFORE spending one request each on them.
 */
export function parseMfStationList(csv: string): Map<string, { name?: string; lat?: number; lon?: number }> {
  const out = new Map<string, { name?: string; lat?: number; lon?: number }>()
  const lines = String(csv || '').split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return out
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ','
  const head = lines[0].split(sep).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''))
  const col = (names: readonly string[]) => head.findIndex((h) => names.includes(h))
  const iId = col(['id_station', 'numer_sta', 'num_sta', 'id'])
  const iNm = col(['nom_usuel', 'nom', 'name', 'libelle'])
  const iLa = col(['lat', 'latitude'])
  const iLo = col(['lon', 'longitude'])
  if (iId < 0) return out
  for (const line of lines.slice(1)) {
    const c = line.split(sep).map((x) => x.trim().replace(/^"|"$/g, ''))
    const id = c[iId]
    if (!id) continue
    const f = (i: number) => {
      if (i < 0) return undefined
      // MF CSVs use a comma decimal separator in some exports; only safe to swap
      // when the separator itself is a semicolon, or "43,2" would already be split.
      const v = Number(sep === ';' ? (c[i] || '').replace(',', '.') : c[i])
      return Number.isFinite(v) ? v : undefined
    }
    out.set(id, { name: iNm >= 0 ? c[iNm] || undefined : undefined, lat: f(iLa), lon: f(iLo) })
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

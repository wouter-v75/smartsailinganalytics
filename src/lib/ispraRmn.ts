// ISPRA Rete Mareografica Nazionale — the Italian coastal wind archive.
//
// WHAT THIS IS. Thirteen years of 10-minute wind at Italian coastal stations,
// CC-BY-4.0, from the one source in this whole network that documents itself
// properly. Measured against the live SPARQL endpoint on 23 Oct 2026:
//
//   the catalogue      dati.isprambiente.it/sparql, 413 M triples
//   the data           monthly CSVs at rep.isprambiente.it/file/rmn/
//   span               2014-01 to 2023-10 for wind; nothing newer
//   cadence            10 minutes
//   columns            UTC;WS;WD  — semicolon, header present
//   units              WS metres_per_second, WD degree — DECLARED in the
//                      dataschema, not inferred
//   the clock          column 1 is named UTC, in the schema, by ISPRA
//   missing            the string NA
//   anemometer height  DECLARED: hasSystemDeployment names
//                      "..._anemometer_measurement_height_10_m"
//   averaging period   DECLARED: hasSystemCapability names
//                      "..._averaging_period_10m"
//   validation level   hasValidationLevel = l0, i.e. NOT validated
//
// THIS IS AN ARCHIVE, NOT A FEED. The latest wind month anywhere in the LOD is
// October 2023 — ISPRA's "real-time Linked Open Data" description is three
// years out of date. The live portal at mareografico.it does carry current
// data, but it is session-keyed and disables text selection and the context
// menu in its own page script, so it is not a door to walk through. Use this
// for TRAINING and climatology; use Davis, METAR and Port-Log for what the
// wind is doing now.
//
// WHY IT IS WORTH HAVING ANYWAY. The verification literature puts a local wind
// MOS fit at 365-1816 days of record. SSA's own table starts from the day the
// poller began. This is thirteen years that already exist, properly licensed,
// with a stated height and a stated averaging period — the two things every
// other station in the network is missing.
//
// WHAT TO HOLD AGAINST IT. The stations are, in ISPRA's own words, "ubicate
// prevalentemente all'interno delle strutture portuali" — inside port
// structures. That is a sheltered site, which the siting literature puts in
// the uncorrectable WMO class 4/5 band. Good for climatology, gradient and
// timing; a poor target for fitting an absolute bias. And the LOD gives only
// the PLATFORM position (the tide gauge); the station pages note that the
// meteorological pole can stand somewhere else entirely — Ancona's is at a
// different marina, with its own coordinates — so the position here is the
// gauge's, good to a few hundred metres for the anemometer.

import { OBS_SOURCES, type WindObs } from './windObs'

const MS_TO_KN = 1.943844
const MAX_PLAUSIBLE_KN = 120

/** A station as the LOD describes it. */
export interface IspraStation {
  /** The slug used in the CSV filename, e.g. `napoli`, `la-spezia`. */
  slug: string
  name: string
  /** The PLATFORM position — the tide gauge, not necessarily the met pole. */
  lat: number
  lon: number
  /** Declared anemometer height in metres, from hasSystemDeployment. */
  heightM: number | null
}

/**
 * The measurement height out of a systemDeployment URI.
 *
 * ISPRA encode it in the identifier —
 * `.../systemdeployment/na23_09_anemometer_measurement_height_10_m` — and the
 * resource's label confirms the semantics ("Measurement height of the sensor
 * of the Anemometer"). Parsed rather than followed to hasValue because the URI
 * is what the enumeration query already returns, and a mismatch between the
 * two would be worth knowing about rather than silently preferring one.
 */
export function ispraHeightFromDeployment(uri: string | null | undefined): number | null {
  if (!uri) return null
  const m = /measurement_height_(\d+(?:_\d+)?)_m\b/.exec(String(uri))
  if (!m) return null
  // `10_5_m` would mean 10.5 m; ISPRA use plain integers today.
  const n = Number(m[1].replace('_', '.'))
  return Number.isFinite(n) && n > 0 && n < 200 ? n : null
}

/**
 * One monthly wind CSV into observations.
 *
 * `UTC;WS;WD`, semicolon-separated, header present, `NA` for missing.
 *
 * A ROW WITH NO SPEED IS DROPPED; a row with a speed and `NA` for direction is
 * KEPT with a null direction. That is not a technicality — in the real files
 * `NA` appears in WD exactly where WS is near zero (`0.1;NA`), which is a vane
 * with too little wind to point rather than a broken sensor. Dropping those
 * rows would quietly delete the calms from a training set, and a calm is a
 * real state of the race course.
 */
export function parseIspraWindCsv(
  text: string,
  st: IspraStation,
  nowMs: number = Date.now(),
): WindObs[] {
  if (typeof text !== 'string' || !text.trim()) return []
  const lines = text.split(/\r?\n/)
  if (!lines.length) return []

  // The header states the column order; honour it rather than assuming.
  const head = lines[0].split(';').map((h) => h.trim().toUpperCase())
  const iT = head.indexOf('UTC')
  const iS = head.indexOf('WS')
  const iD = head.indexOf('WD')
  // No usable header means this is not the file we think it is.
  if (iT < 0 || iS < 0) return []

  const num = (v: string | undefined): number | null => {
    if (v == null) return null
    const t = v.trim()
    if (!t || t.toUpperCase() === 'NA') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }

  const out: WindObs[] = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const c = line.split(';')
    const stamp = (c[iT] || '').trim()
    // "2014-01-01 00:10:00", UTC by ISPRA's own schema — hence the explicit Z
    // rather than letting the runtime guess the server's zone.
    const ms = Date.parse(`${stamp.replace(' ', 'T')}Z`)
    if (!Number.isFinite(ms)) continue
    if (ms > nowMs + 600_000) continue       // never from the future

    const msSpeed = num(c[iS])
    if (msSpeed == null) continue
    const twsKn = msSpeed * MS_TO_KN
    if (!(twsKn >= 0) || twsKn > MAX_PLAUSIBLE_KN) continue

    const dir = iD >= 0 ? num(c[iD]) : null

    out.push({
      id: `rmn:${st.slug}`,
      source: 'synop',
      name: st.name,
      lat: st.lat,
      lon: st.lon,
      // The one network that tells us. Everything else in SSA stores null here.
      heightM: st.heightM,
      elevM: null,
      // 'land' DELIBERATELY, though a tide gauge sits at the water: these are
      // inside port structures, and claiming open-sea roughness for a harbour
      // basin would overstate the exposure. The conservative choice.
      surface: 'land',
      twsKn,
      twdDeg: dir == null ? null : ((dir % 360) + 360) % 360,
      // The feed carries a 10-minute MEAN and no gust at all.
      gustKn: null,
      t: new Date(ms).toISOString(),
      trust: OBS_SOURCES.synop.trust,
    })
  }
  return out
}

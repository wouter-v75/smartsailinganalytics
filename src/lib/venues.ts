// WHERE WE SAIL — the one list of venues.
//
// It lives in its own module, with no dependencies, because two different
// parts of the app need it and neither should drag the other in: the
// observation poller (obsSources, which imports the station registries) and
// the MOS runtime (components/weather/mos.js, which runs in the BROWSER and
// must not ship 225 Davis stations to do it).
//
// ONE VOCABULARY, which it was not. MOS matched venues by position against its
// own VENUE_CENTERS keyed `st_tropez`, `porto_cervo`, `sorrento`; the
// observation code keyed the same places `st-tropez`, `porto-cervo`; and
// forecastDiagnostics.VENUE_COAST_NORMAL was keyed by the MOS spelling
// (`la_spezia`) for a venue the observation list called `la-spezia`. Three
// places that had to agree, nothing keeping them in step, and the failure mode
// is silent: a key that matches nothing just means no correction, no coast
// normal, or no dense network, with everything looking fine.
//
// So: hyphenated keys, here, once. Anything keyed by venue is keyed by these.

import type { GradedOptions } from './obsDensity'

export interface Venue {
  /**
   * Stable slug. This is what a cron line, an activation row and a hand-run
   * poll all name a venue by, so it must not change with the display name —
   * renaming "St Tropez" to "Golfe de Saint-Tropez" must not silently stop a
   * regatta's dense polling.
   */
  key: string
  name: string
  lat: number
  lon: number
  /** Overrides for the DENSE graded set; obsDensity defaults otherwise. */
  dense?: GradedOptions
  /**
   * Other spellings that mean this venue, for matching the free-text
   * `location` on a campaign session. Matching is on a normalised form —
   * unaccented, lower case, punctuation stripped — so "Saint-Tropez" already
   * covers "SAINT TROPEZ" and an en dash. What belongs here is a DIFFERENT
   * NAME for the same water, not a different typography of the same name.
   *
   * Nothing is guessed by near-spelling: a location either matches or it is
   * reported unmatched, because a regatta with no dense network and no
   * complaint is the failure this exists to prevent.
   */
  aliases?: readonly string[]
}

export const VENUES: Venue[] = [
  { key: 'solent', name: 'Solent / Cowes', lat: 50.766, lon: -1.288,
    aliases: ['the solent', 'cowes iow', 'isle of wight', 'rys', 'cowes week'] },
  { key: 'lymington', name: 'Lymington', lat: 50.733, lon: -1.533,
    aliases: ['lymington river', 'rlymyc', 'western solent'] },
  // The middle of the Golfe de Saint-Tropez, off the point Wouter races
  // around, not the town quay: 43.266897, 6.698371.
  { key: 'st-tropez', name: 'St Tropez', lat: 43.266897, lon: 6.698371,
    aliases: [
      'saint tropez', 'golfe de saint tropez', 'golfe de st tropez',
      'les voiles de saint tropez', 'les voiles de st tropez',
      'giraglia', 'maxi worlds', 'maxi yacht rolex cup st tropez',
    ] },
  { key: 'porto-cervo', name: 'Porto Cervo', lat: 41.135, lon: 9.538,
    aliases: ['costa smeralda', 'yccs', 'sardinia', 'maxi yacht rolex cup'] },
  // SORRENTO was in the MOS venue list and NOT in this one, which is the
  // clearest sign the two had drifted: a venue with three years of fitted
  // coefficients that the observation network had never heard of.
  // THE MIDDLE OF THE GULF OF NAPLES, 40.703947 / 14.215522 — the race area
  // Wouter gave, not the town. It is 11.2 nm NW of [40.60, 14.42], which is
  // where mos.js hardcoded the centre and therefore where the fitted Sorrento
  // MOS has been matched until now.
  //
  // THAT MOVES THE MOS MATCH REGION. VENUE_MATCH_NM is 20, so the two centres
  // are inside each other's radius and anything that matched before still
  // matches — but a point 15 nm SE of the old centre is now 26 nm from this
  // one and gets the raw forecast instead. The spec cannot tell us whether
  // that is right: mos_sorrento.json records `venue`, `target_height_m`,
  // `bands` and `models`, and NO POSITION, so where its three years of boat
  // logs were actually sailed is not written down anywhere. Worth recording in
  // the spec next time it is refitted.
  { key: 'sorrento', name: 'Sorrento', lat: 40.703947, lon: 14.215522,
    aliases: ['golfo di napoli', 'gulf of naples', 'bay of naples', 'napoli', 'naples'] },
  { key: 'la-spezia', name: 'La Spezia', lat: 44.10, lon: 9.83,
    aliases: ['golfo dei poeti', 'portovenere'] },
  { key: 'san-juan', name: 'San Juan Islands', lat: 48.5627, lon: -122.8946,
    aliases: ['san juans', 'friday harbor', 'friday harbour', 'anacortes'] },
  { key: 'long-beach', name: 'Long Beach / San Pedro', lat: 33.72, lon: -118.27,
    aliases: ['los angeles', 'la28', 'alamitos bay', 'abyc', 'long beach ca'] },
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
  { key: 'ensenada', name: 'Ensenada', lat: 31.85, lon: -116.62,
    aliases: ['bahia de todos santos', 'newport to ensenada', 'n2e'] },
  // The Oslofjord corridor: Larvik up to Oslo, east to Sarpsborg and north to
  // Gardermoen. Four points rather than one box, because the Davis station
  // list is picked per venue and one centre would cluster them all together.
  { key: 'viksfjord', name: 'Viksfjord / Larvik', lat: 59.03, lon: 10.15,
    aliases: ['stavern', 'nevlunghavn'] },
  { key: 'oslofjord', name: 'Oslofjord / Horten', lat: 59.42, lon: 10.48,
    aliases: ['oslofjorden', 'moss', 'tonsberg', 'toensberg'] },
  { key: 'oslo', name: 'Oslo', lat: 59.90, lon: 10.73,
    aliases: ['indre oslofjord', 'kns', 'bygdoy'] },
  { key: 'fredrikstad', name: 'Fredrikstad / Sarpsborg', lat: 59.22, lon: 10.95,
    aliases: ['hvaler', 'vesteroy'] },
]
/** A venue by key, or undefined. */
export function venueByKey(key: string | null | undefined): Venue | undefined {
  if (!key) return undefined
  const want = key.trim().toLowerCase()
  return VENUES.find((v) => v.key === want)
}

/**
 * How near a point must be to count as AT a venue.
 *
 * 20 nm, which is the figure MOS has used since it was fitted: outside it a
 * point gets the raw forecast rather than a neighbouring venue's correction,
 * because a correction fitted off Saint-Tropez is worse than nothing at
 * La Spezia.
 */
export const VENUE_MATCH_NM = 20

/** Flat-earth nautical miles; the venues are points, not a projection. */
function nm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const cos = Math.cos(((aLat + bLat) / 2) * (Math.PI / 180))
  return Math.hypot((aLat - bLat) * 60, (aLon - bLon) * 60 * cos)
}

/**
 * The venue a position is at, or null when it is not near one.
 *
 * NEAREST, and only within VENUE_MATCH_NM. The radius is the point: a venue
 * list that always returns something would hand La Spezia Saint-Tropez's
 * correction.
 */
export function venueAt(
  lat: number | null | undefined,
  lon: number | null | undefined,
  maxNm: number = VENUE_MATCH_NM,
): Venue | null {
  if (!Number.isFinite(lat as number) || !Number.isFinite(lon as number)) return null
  let best: Venue | null = null
  let bd = Infinity
  for (const v of VENUES) {
    const d = nm(lat as number, lon as number, v.lat, v.lon)
    if (d < bd) { bd = d; best = v }
  }
  return bd <= maxNm ? best : null
}

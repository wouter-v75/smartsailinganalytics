// How far a station is from the water, from the same "coastline dataset" the
// forecast diagnostics already use: the Open-Meteo Elevation DEM.
//
// WHY A DEM AND NOT A COASTLINE. components/weather/coastline.js settled this
// already — land is where the elevation is above a small threshold, sea is at
// or below it. No polyline to curate, no shapefile to ship, no dependency on
// the NWP box, and it is the same approach the reference sailing-forecast
// tooling uses. This module is the same idea asked a different question: not
// "which way is the sea from here" but "how far".
//
// HOW. Sample a ring of points at increasing radii and take the smallest
// radius at which any sample comes out as sea. That is a lower bound on the
// true distance, which is the right side to err on: a station is never
// reported as more inland than it is, so the coast bias never penalises
// something that is actually on the quay.
//
// WHAT IT COSTS. Open-Meteo's elevation API is billed PER LOCATION, not per
// request — a hundred coordinates in one call is a hundred against the quota.
// So the sampling is deliberately coarse: eight bearings at three radii is 24
// points per station, and only stations OUTSIDE the inner circle need asking
// at all, because the bias cannot affect the inner circle. For a 70-station
// Saint-Tropez selection that is about 1,700 locations — a once-a-season cost,
// not a per-poll one, and the answer is written into the registry so a repeat
// run pays nothing.
//
// THE GEOMETRY AND THE NETWORK ARE SEPARATE on purpose. seaProbePoints and
// seaNmFromElevations are pure and tested; the fetching and batching live in
// the generator, where the network is.

/** At or below this elevation (metres) a sample counts as sea. */
export const SEA_LAND_M = 1

export interface SeaProbeOptions {
  /** Radii to sample, nautical miles, ascending. */
  radiiNm?: readonly number[]
  /** How many bearings per radius. */
  bearings?: number
  /** Elevation at or below which a sample is sea. */
  landM?: number
}

export const SEA_PROBE_DEFAULTS: Required<SeaProbeOptions> = {
  // Three radii, the outermost matching obsDensity's coastScaleNm so that
  // "no sea anywhere in the ring" saturates the bias exactly.
  radiiNm: [1.5, 5, 10],
  bearings: 8,
  landM: SEA_LAND_M,
}

/**
 * The points to ask the DEM about for one station, as [lat, lon] pairs.
 *
 * ORDER IS PART OF THE CONTRACT: radius-major, so the first `bearings` points
 * are the innermost ring. seaNmFromElevations relies on that to find the
 * smallest sea radius, and the two must be given the same options.
 */
export function seaProbePoints(
  lat: number,
  lon: number,
  opts: SeaProbeOptions = {},
): Array<[number, number]> {
  const { radiiNm, bearings } = { ...SEA_PROBE_DEFAULTS, ...opts }
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180))
  const out: Array<[number, number]> = []
  for (const r of radiiNm) {
    for (let b = 0; b < bearings; b++) {
      const th = (2 * Math.PI * b) / bearings
      // r is in nm; a minute of latitude is a nautical mile by definition.
      const dLat = (r * Math.cos(th)) / 60
      const dLon = (r * Math.sin(th)) / (60 * cosLat)
      out.push([lat + dLat, lon + dLon])
    }
  }
  return out
}

/**
 * The smallest sampled radius at which the DEM says sea.
 *
 * TWO DIFFERENT NULLS, and conflating them got this backwards first time.
 * "We never looked" and "we looked out to ten miles and found no water" are
 * opposite conclusions: the first must not penalise a station, the second is
 * the strongest possible evidence that it is inland. Measured on the DEM,
 * Le Luc — the most inland station in the Saint-Tropez pick — found no sea in
 * its whole ring and so came back as the one station the coast bias ignored.
 *
 * So:
 *   a radius            sea was found there
 *   the OUTERMOST radius no sea in the ring, i.e. "at least this far"
 *   null                the response was unusable — wrong length, or all holes
 *
 * Returning the outermost radius for "nothing found" is a LOWER BOUND, which
 * is the right direction to err: a station is never reported as more inland
 * than it is, so the bias never penalises something that is really on the
 * quay. Aubagne measures 9-10 nm and is truly about 12; both saturate.
 */
export function seaNmFromElevations(
  elevations: ReadonlyArray<number | null | undefined>,
  opts: SeaProbeOptions = {},
): number | null {
  const { radiiNm, bearings, landM } = { ...SEA_PROBE_DEFAULTS, ...opts }
  if (!radiiNm.length || elevations.length !== radiiNm.length * bearings) return null
  let usable = 0
  for (let i = 0; i < radiiNm.length; i++) {
    for (let b = 0; b < bearings; b++) {
      const e = elevations[i * bearings + b]
      if (typeof e !== 'number' || !Number.isFinite(e)) continue
      usable++
      if (e <= landM) return radiiNm[i]
    }
  }
  // Nothing usable came back at all: that is a failed measurement, not a
  // verdict about the station.
  if (!usable) return null
  return radiiNm[radiiNm.length - 1]
}

/** How many DEM locations a set of stations will cost to measure. */
export function seaProbeCost(stationCount: number, opts: SeaProbeOptions = {}): number {
  const { radiiNm, bearings } = { ...SEA_PROBE_DEFAULTS, ...opts }
  return stationCount * radiiNm.length * bearings
}

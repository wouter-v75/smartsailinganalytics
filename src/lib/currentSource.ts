// Which current source serves a position.
//
// Two exist and they are not interchangeable. Open-Meteo's marine currents cover
// the world from a 1/12 degree global ocean model; SalishSeaCast covers one sea
// at 500 m. Measured at the San Juan Islands on 27 Oct 2026, the global model
// returned 0.8-1.2 km/h — under 0.6 kn — where the channels run 3 to 6. So in
// the Salish Sea the global field is not a coarser answer, it is a different
// quantity, and the choice has to be made per position rather than globally.
//
// The router lives in its own file to keep the dependency direction one-way:
// salishSeaCurrents imports the shared `CurrentSeries` shape and `distanceKm`
// from oceanCurrent, so oceanCurrent must not import it back.
//
// A null from the local source is not a failure to paper over. Falling back to
// the global model inside the Salish Sea would replace "we do not know" with a
// confident half a knot, which is worse — so the fallback is deliberately NOT
// taken there, and the caller is told which source answered.

import { fetchOceanCurrent, type CurrentQuery, type CurrentSeries } from './oceanCurrent'
import { fetchSalishSeaCurrent, inSalishSea } from './salishSeaCurrents'

export type CurrentSourceId = 'salishseacast' | 'open-meteo'

export interface SourcedCurrent extends CurrentSeries {
  source: CurrentSourceId
  /** Fastest speed within the local search window; SalishSeaCast only. */
  localMaxKn?: number
  depthM?: number | null
}

/** Which source WOULD serve this position, without fetching anything. */
export function sourceFor(lat: number, lon: number): CurrentSourceId {
  return inSalishSea(lat, lon) ? 'salishseacast' : 'open-meteo'
}

/**
 * The current series for a position, from whichever source covers it.
 *
 * Inside the Salish Sea this returns SalishSeaCast or null — never the global
 * model — for the reason in the header.
 */
export async function fetchCurrentForPoint(
  q: CurrentQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<SourcedCurrent | null> {
  if (inSalishSea(q.lat, q.lon)) {
    return fetchSalishSeaCurrent({ lat: q.lat, lon: q.lon }, fetchImpl)
  }
  const s = await fetchOceanCurrent(q, fetchImpl)
  return s ? { ...s, source: 'open-meteo' } : null
}

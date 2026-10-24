// Sea-surface temperature, per VENUE, for the stability term.
//
// WHY PER VENUE AND NOT PER POINT. The air-sea temperature difference is what
// sets the Obukhov length, and without it lib/windProfile can only return the
// neutral profile — which understates a masthead wind by around 9 %, and by
// 2.1 kn on a light offshore morning. The obvious way to get it is one marine
// call per forecast grid point, and Open-Meteo bills per LOCATION, so a field
// of a few hundred points would be a few hundred calls an hour.
//
// It is not needed. Measured on the Open-Meteo marine endpoint for the Gulf of
// Naples on 24 Oct 2026: SST ran 21.8 to 22.0 °C across the whole 48-hour
// forecast — 0.2 K of variation in two days. SST is the slowest-moving field
// in this whole system; a gulf does not have a different sea temperature at
// one end than the other on any scale that matters to a wind profile. So one
// call per venue per hour, and every point at that venue shares it.
//
// THE CLOCK TRAP, which is specific and would have bitten. The marine endpoint
// defaults to `timezone: "GMT"` and returns NAIVE ISO stamps — "2026-10-24T12:00"
// with no offset. The surface model fetch passes the venue's timezone, so ITS
// stamps are local. Line the two up by index and at a Mediterranean venue
// every air-sea difference is taken two hours out of step, which in a diurnal
// sea breeze is the difference between stable and unstable. So the same
// `timezone` goes on both calls, times are matched by their exact STRING, and
// a series that does not line up is REFUSED rather than aligned by position.
//
// UNITS ARE CHECKED, not assumed: the response declares
// `hourly_units.sea_surface_temperature`, and anything but °C is refused. The
// same endpoint can be asked for Fahrenheit.

export interface SstSeries {
  /** Naive ISO stamps, in whatever timezone the request asked for. */
  times: string[]
  /** Degrees Celsius, null where the model has no value. */
  sstC: Array<number | null>
  /** The grid point the request actually snapped to. */
  lat: number | null
  lon: number | null
  /** The timezone the stamps are in, as the endpoint reported it. */
  timezone: string | null
}

export const MARINE_ENDPOINT = 'https://marine-api.open-meteo.com/v1/marine'

/**
 * The marine URL for one venue.
 *
 * `timezone` MUST match the one used for the surface model, or the two time
 * series cannot be matched — see the clock note above.
 */
export function marineSstUrl(lat: number, lon: number, timezone: string, days = 3): string {
  return `${MARINE_ENDPOINT}?latitude=${lat}&longitude=${lon}`
    + '&hourly=sea_surface_temperature'
    + `&timezone=${encodeURIComponent(timezone)}&forecast_days=${days}`
}

/** Parse the marine response, refusing anything whose units are not °C. */
export function parseMarineSst(payload: unknown): SstSeries | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const hourly = p.hourly as { time?: unknown; sea_surface_temperature?: unknown } | undefined
  if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.sea_surface_temperature)) return null

  const units = (p.hourly_units as Record<string, unknown> | undefined)?.sea_surface_temperature
  // The endpoint states its unit. A Fahrenheit series read as Celsius would
  // make every sea warmer than every air and flip the whole stability sign.
  if (typeof units === 'string' && !/^°?C$/i.test(units.trim())) return null

  const times = hourly.time.filter((t): t is string => typeof t === 'string')
  if (times.length !== hourly.time.length) return null

  const sstC = hourly.sea_surface_temperature.map((v) =>
    typeof v === 'number' && Number.isFinite(v) ? v : null)
  if (sstC.length !== times.length) return null

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    times,
    sstC,
    lat: num(p.latitude),
    lon: num(p.longitude),
    timezone: typeof p.timezone === 'string' ? p.timezone : null,
  }
}

/**
 * The SST at one stamp, matched by EXACT STRING.
 *
 * Deliberately strict. A near-miss match would paper over exactly the
 * timezone mismatch this module exists to avoid, and an SST that is two hours
 * stale is not the problem — an SST attributed to the wrong hour of a diurnal
 * cycle is.
 */
export function sstAt(series: SstSeries | null, isoLocal: string | null | undefined): number | null {
  if (!series || !isoLocal) return null
  // Open-Meteo writes "2026-10-24T12:00"; a caller may hold seconds.
  const want = isoLocal.length > 16 ? isoLocal.slice(0, 16) : isoLocal
  const i = series.times.findIndex((t) => t.slice(0, 16) === want)
  return i < 0 ? null : series.sstC[i]
}

/**
 * Air minus sea, in kelvin. POSITIVE IS STABLE — warm air over cooler water.
 *
 * The air figure is the model's 2 m temperature, because that is what the
 * forecast call can be asked for. Strictly the bulk difference wants the air
 * at the reference height, and in stable conditions temperature INCREASES
 * with height, so a 2 m value understates the 10 m value and therefore
 * understates the stability. The error is in the conservative direction: it
 * under-corrects rather than over-corrects, which is the right way round for
 * a term whose strong-stability end the theory cannot pin down anyway.
 */
export function airSeaDeltaK(air2mC: number | null | undefined, sstC: number | null | undefined): number | null {
  if (typeof air2mC !== 'number' || !Number.isFinite(air2mC)) return null
  if (typeof sstC !== 'number' || !Number.isFinite(sstC)) return null
  return air2mC - sstC
}

/** Convenience: ΔT straight from a model's hourly block at one index. */
export function deltaKFromHourly(
  hourly: { time?: Array<string | null>; temperature_2m?: Array<number | null> } | null | undefined,
  idx: number,
  sst: SstSeries | null,
): number | null {
  if (!hourly || !Array.isArray(hourly.time) || !Array.isArray(hourly.temperature_2m)) return null
  return airSeaDeltaK(hourly.temperature_2m[idx], sstAt(sst, hourly.time[idx]))
}

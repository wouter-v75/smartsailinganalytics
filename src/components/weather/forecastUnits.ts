// Temperature units for the forecast generator, per venue.
//
// A deck is read by the crew on the dock, so the temperature has to be in the
// unit they think in. At a US venue that is Fahrenheit, and the °C stays in
// brackets beside it rather than being dropped — the boat's own instruments,
// the sea-temperature feeds and every other number in SSA are metric, so a
// deck that printed °F alone would be the one document nobody could reconcile.
//
// WHAT THIS DELIBERATELY DOES NOT TOUCH. Temperature DIFFERENCES and lapse
// rates on the Stability slide — the sea-breeze ΔT (air minus SST), the
// capping inversion's strength, the environmental lapse rate in °C/km — stay
// in °C. They are not temperatures anybody feels; they are diagnostics whose
// thresholds are stated in °C in forecastDiagnostics.js (the SBI saturates at
// 4 °C, the inversion test at 0.5 °C), and a ΔT converted as if it were a
// temperature would be wrong by 32 degrees. The Skew-T's own axis stays °C for
// the same reason: that is the unit the chart is defined in, worldwide.

/**
 * Venues whose decks lead with Fahrenheit.
 *
 * Long Beach is the other US venue and is deliberately NOT here: it was not
 * asked for, and adding it is this one line. Everything else is metric.
 */
export const FAHRENHEIT_VENUES: readonly string[] = ['san-juan']

export type TempUnit = 'F' | 'C'

/** Which unit this venue's deck leads with. Default metric. */
export function tempUnitFor(venueKey?: string | null): TempUnit {
  return venueKey && FAHRENHEIT_VENUES.includes(venueKey) ? 'F' : 'C'
}

export const cToF = (c: number): number => (c * 9) / 5 + 32

/**
 * An absolute air or sea temperature, in the venue's unit.
 *
 * `fmtTemp(12.3, 'F')` -> `"54 °F (12 °C)"`, `fmtTemp(12.3, 'C')` -> `"12 °C"`.
 *
 * Each figure is rounded from the ORIGINAL °C, not from the other printed
 * value, so neither is a rounding of a rounding: 12.3 °C gives 54 °F (54.14),
 * never the 53.6 you get by converting a displayed 12.
 */
export function fmtTemp(c: number | null | undefined, unit: TempUnit = 'C'): string | null {
  if (c == null || !Number.isFinite(c)) return null
  const cR = Math.round(c)
  if (unit !== 'F') return `${cR} °C`
  return `${Math.round(cToF(c))} °F (${cR} °C)`
}

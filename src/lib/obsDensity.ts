// Which stations to keep around a venue: everything close in, thinning out.
//
// WHY NOT "THE NEAREST N". That is what the Davis registry used, and at a
// COASTAL venue it fails in a particular way: the nearest 24 to Saint-Tropez
// were one station in the gulf and then a tail of hinterland — Collobrières,
// Le Luc, Callas, twenty minutes' drive inland and behind hills. Counting
// stations takes no account of where they are, so a dense inland suburb
// crowds out the whole of the rest of the coast.
//
// WHAT THIS DOES INSTEAD. Keep EVERYTHING within `innerNm` — that is the race
// area and there is no such thing as too much detail there — then require
// progressively wider spacing the further out a station is, so the far field
// is sampled rather than enumerated. The result is one dense circle and a thin
// even spread around it, which is the shape of the question being asked of it:
// what is the wind doing HERE, and where is the gradient coming from.
//
// The spacing is evaluated at the CANDIDATE's own range, and candidates are
// considered nearest-first, so a station close to the venue is never dropped
// in favour of one further out and the result is deterministic.
//
// MEASURED, so the defaults are not taste. Public Davis stations around
// 43.266897, 6.698371 (the Golfe de Saint-Tropez) on 23 Oct 2026:
//
//     5 nm    0        20 nm   19
//    10 nm    5        30 nm   51
//    15 nm    8        40 nm   87
//                      50 nm  108
//
// Flat "nearest 24" takes everything to about 21 nm and nothing beyond. These
// defaults keep all of the inner circle and spread the remainder over the
// whole 50 nm, which is where a Mistral or an easterly actually announces
// itself.

export interface GradedOptions {
  /** Keep every station inside this, whatever the spacing. */
  innerNm?: number
  /** Keep nothing beyond this. */
  outerNm?: number
  /** Required spacing between kept stations AT `outerNm`. */
  maxSepNm?: number
  /**
   * How the spacing grows between inner and outer. 1 is linear; above 1 keeps
   * the near-middle denser and thins harder at the edge.
   */
  curve?: number
  /**
   * How much wider the spacing gets for a station far from the water. 0 is
   * off, which is the default — an inland station is the right answer on a
   * land-breeze morning and biasing against it is a choice, not an
   * improvement.
   *
   * WHY IT IS WORTH HAVING. Graded to 50 nm, Saint-Tropez picks up Aubagne,
   * Brignoles, Besse-sur-Issole and Le Luc: inland Var, behind hills, 200-500 m
   * up. For a Mistral arriving they are genuinely useful. For the SEA-BREEZE
   * gradient along the coast they are noise, and they are occupying the budget
   * that Hyeres, Porquerolles, Antibes and Nice could be using.
   *
   * At 1.5 an inland station needs two and a half times the spacing of a
   * coastal one at the same range, so the outer ring fills up with the coast
   * first and the hinterland gets what is left.
   */
  coastBias?: number
  /** The distance from the sea at which the full bias applies. */
  coastScaleNm?: number
}

export const GRADED_DEFAULTS: Required<GradedOptions> = {
  innerNm: 5,
  outerNm: 50,
  maxSepNm: 4,
  curve: 1.5,
  coastBias: 0,
  coastScaleNm: 10,
}

export interface Placed { lat: number; lon: number }

/** Great-circle-ish distance in nautical miles, flat-earth at these scales. */
export function nmBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const cos = Math.cos(((aLat + bLat) / 2) * (Math.PI / 180))
  return Math.hypot((aLat - bLat) * 60, (aLon - bLon) * 60 * cos)
}

/**
 * The spacing required of a station at range `nm`: zero inside the inner
 * circle, then growing to `maxSepNm` at the outer edge.
 */
export function minSepNm(nm: number, opts: GradedOptions = {}): number {
  const { innerNm, outerNm, maxSepNm, curve } = { ...GRADED_DEFAULTS, ...opts }
  if (nm <= innerNm) return 0
  if (outerNm <= innerNm) return maxSepNm
  const f = Math.min(1, (nm - innerNm) / (outerNm - innerNm))
  return maxSepNm * Math.pow(f, curve)
}

/**
 * The spacing actually required of a candidate: its range's base spacing,
 * widened if it is inland and a coast bias is in force.
 *
 * `seaNm` is the station's distance from the water. Null means unknown, and an
 * unknown station is NOT penalised — a missing measurement must not quietly
 * drop a station that might be on the quay.
 */
export function requiredSepNm(
  nm: number,
  seaNm: number | null | undefined,
  opts: GradedOptions = {},
): number {
  const { coastBias, coastScaleNm } = { ...GRADED_DEFAULTS, ...opts }
  const base = minSepNm(nm, opts)
  if (!coastBias || seaNm == null || !Number.isFinite(seaNm) || coastScaleNm <= 0) return base
  const inland = Math.min(1, Math.max(0, seaNm) / coastScaleNm)
  return base * (1 + coastBias * inland)
}

/**
 * Pick stations around a point with density falling off by range.
 *
 * Nearest-first and greedy: a candidate is kept unless an already-kept station
 * is closer to it than the spacing its own range demands.
 *
 * `seaNmOf` is optional and only matters when `coastBias` is set. It is a
 * callback rather than a field on the station so that this module stays pure —
 * measuring a distance from the sea needs a digital elevation model, and that
 * is a network call belonging to a generator, not to a selection rule.
 *
 * THE INNER CIRCLE IS NEVER AFFECTED. Base spacing there is zero, and zero
 * times any bias is still zero — so everything inside `innerNm` is kept
 * however far inland it is. That is deliberate: Cap Camarat is 107 m up on a
 * headland and is the single most useful station at Saint-Tropez.
 */
export function gradedPick<T extends Placed>(
  items: readonly T[],
  lat: number,
  lon: number,
  opts: GradedOptions = {},
  seaNmOf?: (item: T) => number | null | undefined,
): T[] {
  const { outerNm } = { ...GRADED_DEFAULTS, ...opts }
  const cand = items
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => ({ s, d: nmBetween(lat, lon, s.lat, s.lon) }))
    .filter((x) => x.d <= outerNm)
    .sort((a, b) => a.d - b.d)

  const kept: Array<{ s: T; d: number }> = []
  for (const c of cand) {
    const sep = requiredSepNm(c.d, seaNmOf ? seaNmOf(c.s) : null, opts)
    if (sep > 0 && kept.some((k) => nmBetween(k.s.lat, k.s.lon, c.s.lat, c.s.lon) < sep)) continue
    kept.push(c)
  }
  return kept.map((k) => k.s)
}

/** How many of `items` fall inside each given range — for reporting a pick. */
export function bandCounts<T extends Placed>(
  items: readonly T[],
  lat: number,
  lon: number,
  bands: readonly number[] = [5, 10, 20, 30, 50],
): Record<string, number> {
  const d = items
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => nmBetween(lat, lon, s.lat, s.lon))
  const out: Record<string, number> = {}
  for (const b of bands) out[`${b}nm`] = d.filter((x) => x <= b).length
  return out
}

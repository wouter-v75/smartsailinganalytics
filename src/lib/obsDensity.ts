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
}

export const GRADED_DEFAULTS: Required<GradedOptions> = {
  innerNm: 5,
  outerNm: 50,
  maxSepNm: 4,
  curve: 1.5,
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
 * Pick stations around a point with density falling off by range.
 *
 * Nearest-first and greedy: a candidate is kept unless an already-kept station
 * is closer to it than the spacing its own range demands.
 */
export function gradedPick<T extends Placed>(
  items: readonly T[],
  lat: number,
  lon: number,
  opts: GradedOptions = {},
): T[] {
  const { outerNm } = { ...GRADED_DEFAULTS, ...opts }
  const cand = items
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => ({ s, d: nmBetween(lat, lon, s.lat, s.lon) }))
    .filter((x) => x.d <= outerNm)
    .sort((a, b) => a.d - b.d)

  const kept: Array<{ s: T; d: number }> = []
  for (const c of cand) {
    const sep = minSepNm(c.d, opts)
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

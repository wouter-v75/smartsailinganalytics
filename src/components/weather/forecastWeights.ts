// Which models the forecast generator puts in the deck, and what each one is
// WORTH at a given venue.
//
// WHY THIS FILE EXISTS, and it is not the obvious reason. The weights used to
// be one flat object in ForecastDeck.jsx, so every venue got the same ranking —
// a ranking written for the Mediterranean, where the SSA-Race nest and AROME
// are the models we race off and the globals are a sanity check (8.5 against
// 1.3, a 6.5x standing). At the San Juan Islands that ranking is simply wrong
// about which models are good, and the measured evidence is in the venue's own
// MOS spec (mos_san_juan.json, 4.8 years against Smith Island at 10 m):
//
//   HRRR   raw rmse 2.79 kn      the best model at this venue
//   HRDPS  raw rmse 3.29 kn      and the only one whose levels BRACKET 30 m
//   GFS    raw rmse 3.77 kn
//   ECMWF  raw rmse 3.77 kn
//   ICON   raw rmse 5.04 kn      ~11 km, no cell here free of island
//
// So the weights are per venue now, with the old table kept verbatim as the
// default so no existing deck moves.
//
// THE OTHER HALF OF THE BUG was the model LIST. `ALL_TODAY` was a third list
// beside MODEL_ORDER (which drives the fetch) and COMPARE_ORDER (which drives
// the picker), and HRDPS and GFS were in both of those and in neither of the
// deck's. Both were fetched at San Juan and then dropped on the floor — the
// same failure the comment above ALL_TODAY already recorded for HRRR and NAM,
// one list deeper. That is why modelCoverage.test.ts exists, and why
// forecastWeights.test.ts now pins this list against the other two.

/**
 * Every model the deck may use for TODAY's rows, bands and comparison.
 *
 * Membership costs nothing where a model has no data: the deck filters on
 * `hasValidSpeed`, and the region-gated ones (HRRR, NAM, HRDPS) only ever
 * return data in North America. GFS is global, so it is the one addition that
 * widens an existing deck — at weight 1.0, below ECMWF and ICON.
 */
export const DECK_MODELS = [
  'ICONRACE', 'ICONRACE_1KM', 'AROME', 'METNO',
  'HRRR', 'HRDPS', 'NAM', 'GFS',
  'ECMWF', 'ICON', 'ARPEGE', 'ITALIA', 'DMI',
] as const

/**
 * The venue-agnostic ranking, unchanged from the single table it replaces.
 *
 * The 1-3 km local models sit at 8.5, the SSA-Race parent at 7.0, NAM (12 km,
 * regional) at 3.0 and the globals near 1. HRDPS joins the 2.5 km group at 8.5,
 * which is where its resolution and its San Juan rmse both put it; GFS joins
 * the globals at 1.0, between ARPEGE 0.9 and ECMWF 1.3.
 */
export const DEFAULT_WEIGHTS: Record<string, number> = {
  ICONRACE: 7.0, ICONRACE_1KM: 8.5, AROME: 8.5, METNO: 8.5,
  HRRR: 8.5, HRDPS: 8.5, NAM: 3.0, GFS: 1.0,
  ECMWF: 1.3, ICON: 1.3, ARPEGE: 0.9, ITALIA: 1.5, DMI: 1.0,
}

/** What a model not named in the table is worth. The old `|| 0.5` fallback. */
export const DEFAULT_OTHER = 0.5

export interface WeightTable {
  /** Weight for any model in DECK_MODELS this table does not name. */
  other: number
  /** Per-model weights. */
  models: Record<string, number>
  /**
   * Collapse the SSA-Race pair onto ONE member (see SSA_FAMILY).
   *
   * The 1 km nest is DRIVEN BY the 2 km parent — same ICON-LAM, same
   * initial conditions, the inner domain reading the outer one's boundaries.
   * They are not two opinions, they are one forecast at two resolutions, so
   * counting both puts 2x the intended weight on that single forecast. With
   * the old 8.5/7.0 table that was already happening (15.5 of ~25 total), and
   * it is tolerable only because those numbers were never meant as a budget.
   * The moment a venue declares "SSA = 0.8" it is a budget, and it has to be
   * honoured, so a venue that states its weights states this too.
   */
  dedupeSsa?: boolean
  /** One line on why these numbers, shown nowhere — for whoever reads this next. */
  note?: string
}

/**
 * The SSA-Race members, in the order a de-duplicated venue keeps them.
 * The nest first: higher resolution, and 30 m is a NATIVE output for both.
 */
export const SSA_FAMILY = ['ICONRACE_1KM', 'ICONRACE'] as const

/**
 * Per-venue weights, keyed by the venue keys in `lib/venues.ts`.
 *
 * A venue absent here gets DEFAULT_WEIGHTS, so adding one changes nothing
 * anywhere else.
 */
export const VENUE_WEIGHTS: Record<string, WeightTable> = {
  // San Juan Islands — set 2026-11-05 at Wouter's direction, HRRR and ECMWF
  // swapped on 2026-11-06 to match the measured ranking: SSA and HRRR 0.8,
  // HRDPS and ECMWF 0.6, everything else 0.3.
  //
  // The swap is the point. The first version had ECMWF at 0.8 and HRRR at
  // 0.6, which inverted the venue's own rmse table above — HRRR 2.79 against
  // ECMWF 3.77 kn over 4.8 years. The order now runs with it: HRRR 0.8,
  // HRDPS 3.29 kn at 0.6, ECMWF 3.77 kn at 0.6, and the three models with no
  // local resolution and no better score at 0.3.
  //
  // SSA-Race keeps 0.8 on a different argument, since it has no entry in that
  // table: it is the only model that outputs 30 m natively on a 1 km grid
  // here, and it is ours to inspect when it is wrong.
  'san-juan': {
    other: 0.3,
    dedupeSsa: true,
    models: {
      ICONRACE: 0.8, ICONRACE_1KM: 0.8, HRRR: 0.8,
      HRDPS: 0.6, ECMWF: 0.6,
    },
    note: 'SSA + HRRR 0.8 · HRDPS + ECMWF 0.6 · rest 0.3',
  },
}

/**
 * One line naming the weights a deck was actually built with, for the deck.
 *
 * Every TWS and TWD range on the deck is a WEIGHTED mean ±1σ, so the weights
 * are part of the answer and belong on the page beside it — the footnote used
 * to say "weighted-model mean" without ever saying weighted how. A model held
 * at 0 is named too: it is drawn on the comparison charts, so a reader who
 * cannot see why it failed to move the band deserves to be told.
 */
export function weightNote(
  weights: Record<string, number>,
  labelOf: (k: string) => string = (k) => k,
): string {
  const entries = Object.entries(weights).filter(([, v]) => Number.isFinite(v))
  if (!entries.length) return ''
  // A plain object keyed by the weight, not a Map: tsconfig's target predates
  // es2015 iterators, so spreading a Map's entries fails to compile here.
  const groups: Record<string, string[]> = {}
  for (const [k, v] of entries) {
    if (v <= 0) continue
    const g = String(v)
    groups[g] = groups[g] ?? []
    groups[g].push(labelOf(k))
  }
  const levels = Object.keys(groups)
  if (!levels.length) return ''
  const parts = levels
    .sort((a, b) => Number(b) - Number(a))
    .map((v) => `${groups[v].join(' / ')} ${v}`)
  const zero = entries.filter(([, v]) => v <= 0).map(([k]) => labelOf(k))
  const tail = zero.length ? ` · not weighted: ${zero.join(' / ')}` : ''
  return `Model weights — ${parts.join(' · ')}${tail}`
}

/** The table a venue fits under. */
export function weightTableFor(venueKey?: string | null): WeightTable {
  if (venueKey && VENUE_WEIGHTS[venueKey]) return VENUE_WEIGHTS[venueKey]
  return { other: DEFAULT_OTHER, models: DEFAULT_WEIGHTS }
}

/**
 * Resolve one weight per model actually PRESENT in this deck.
 *
 * @param venueKey    venue key, or null/undefined for the default table
 * @param presentKeys the models that returned usable data at this point
 * @param o.prefer    the deck's primary model — kept if it is an SSA member
 *                    and the venue de-duplicates, so the model the tables are
 *                    built around is never the one zeroed
 * @returns a weight for every key in presentKeys. A 0 means "present in the
 *   deck, excluded from the weighted mean and the spread" — both
 *   `weightedBand` and `weightedSpread` filter on `w > 0`, so the model still
 *   appears on the comparison page and no longer votes twice.
 */
export function weightsFor(
  venueKey: string | null | undefined,
  presentKeys: readonly string[],
  o: { prefer?: string | null } = {},
): Record<string, number> {
  const t = weightTableFor(venueKey)
  const out: Record<string, number> = {}
  for (const k of presentKeys) out[k] = t.models[k] ?? t.other
  if (t.dedupeSsa) {
    const order = o.prefer && (SSA_FAMILY as readonly string[]).includes(o.prefer)
      ? [o.prefer, ...SSA_FAMILY.filter((k) => k !== o.prefer)]
      : [...SSA_FAMILY]
    const live = order.filter((k) => presentKeys.includes(k) && (out[k] ?? 0) > 0)
    for (const k of live.slice(1)) out[k] = 0
  }
  return out
}

// Reading a shipped MOS spec for DISPLAY, across the three generations of spec
// that now exist.
//
// WHY THIS FILE. The Venue MOS table read one vocabulary — the Mediterranean
// one — and the venues fitted since write different names for the same numbers.
// San Juan and Long Beach therefore rendered a row per model with every metric
// column showing a dash: the venue was in the picker, the spec was registered,
// and the table said nothing. Worse than nothing in one case, because San Juan's
// `icon_global` row showed a 25.4 % gain for a model the spec itself declares is
// never applied.
//
// The three generations, and what each stores:
//
//   Mediterranean (sorrento, porto-cervo, st-tropez) — fitted against a boat's
//     own masthead log over regattas. best / sector_agreement / raw_rmse /
//     cv_rmse / reduction_pct / n / folds / holds_every_regatta / blocked_by.
//   Frost stations (oslofjord, viksfjord) — mos-fit.ts. Same names MINUS
//     sector_agreement (a station has no boat heading to agree with), plus
//     n_eff / params / skill_vs_persistence / boot_ci / dm_stat / blocks.
//   Station + tail bars (san-juan, long-beach) — mos-sanjuan-fit.ts and
//     mos-longbeach-fit.ts. type (no `best`), measured_gain_pct (no
//     reduction_pct), paired_hours (no n), holds_every_block, and NO rmse
//     values at all — those were never written to the spec.
//
// So some fields MAP and some are genuinely ABSENT, and the difference matters:
// a dash where a number was never stored is honest, a dash where the number is
// present under another name is a bug. Everything here is the mapping; the
// absences stay absent and `missing` names them so the view can say which.

export interface MosSpecModel {
  type?: string
  best?: string
  a?: number
  b?: number
  sector_agreement?: number
  raw_rmse?: number
  cv_rmse?: number
  reduction_pct?: number
  measured_gain_pct?: number
  n?: number
  paired_hours?: number
  folds?: number
  blocks?: number
  holds_every_regatta?: boolean
  holds_every_block?: boolean
  not_shipped?: string
  why?: string
  slope_constrained?: boolean
  form?: string
  warn_kept_pct?: number
  n_eff?: number
  [k: string]: unknown
}

export interface MosSpec {
  venue?: string
  fit_height_m?: number
  target_height_m?: number
  bands?: Array<[string, number, number]>
  models: Record<string, MosSpecModel>
  models_not_applied?: Record<string, string>
  truth?: string
  truth_station?: string
  truth_station_name?: string
  truth_anemometer_m?: number
  truth_nm_from_venue?: number
  truth_masthead_m?: number[]
  obs_height_adjustment?: { factor?: number; from_m?: number; to_m?: number }
  fitted_from?: string
  fitted_to?: string
  seasonal?: { months?: number[]; label?: string }
  slope_policy?: { constrained?: boolean; threshold_kn?: number; warn_keep?: number }
  tail_bars?: { threshold_kn?: number; top_bin_kn?: number }
  [k: string]: unknown
}

export interface ModelRow {
  id: string
  /** The correction form the spec will actually apply. */
  best: string
  /** True when no correction is applied at all. */
  isRaw: boolean
  /** Per-cent rmse reduction, from whichever field the generation used. */
  gainPct: number | null
  rawRmse: number | null
  cvRmse: number | null
  /** Only the boat-log venues have this: a station has no heading to agree with. */
  agree: number | null
  n: number | null
  /**
   * Effective sample size after autocorrelation, where the fit recorded it.
   * The number to read beside n: 36,000 hourly samples behave like some 8,500
   * independent ones, and every bar is measured on this, not on n.
   */
  nEff: number | null
  blocks: number | null
  /** Did the gain hold in EVERY held-out block, rather than on average? */
  holds: boolean | null
  /** Why a form that won the ladder was not shipped. */
  why: string | null
  /**
   * Set when the spec declares this model is NOT reachable — the coefficients
   * are stored and inert. Without it the table advertises a gain that can
   * never fire, which is the one way a display here can mislead rather than
   * merely omit.
   */
  notApplied: string | null
  /** The slope was pinned at 1 to protect the strong-wind tail. */
  slopeConstrained: boolean
  /** Fields this generation of spec never stored, so the view can say so. */
  missing: string[]
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A bare form name gets "not shipped" appended; a sentence is left alone. */
function formatNotShipped(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null
  return /^[a-z][a-z_]*$/.test(v) ? `${v} not shipped` : v
}

/** One display row per model, in the spec's own order. */
export function modelRows(spec: MosSpec | null | undefined): ModelRow[] {
  if (!spec?.models) return []
  const na = spec.models_not_applied ?? {}
  return Object.entries(spec.models).map(([id, m]) => {
    const best = m.best || m.type || 'raw'
    const gainPct = num(m.reduction_pct) ?? num(m.measured_gain_pct)
    const rawRmse = num(m.raw_rmse)
    const cvRmse = num(m.cv_rmse)
    const agree = num(m.sector_agreement)
    const n = num(m.n) ?? num(m.paired_hours)
    const missing: string[] = []
    if (rawRmse == null && cvRmse == null) missing.push('rmse')
    if (agree == null) missing.push('agree')
    if (n == null) missing.push('n')
    return {
      id,
      best,
      isRaw: best === 'raw',
      gainPct,
      rawRmse,
      cvRmse,
      agree,
      n,
      nEff: num(m.n_eff),
      blocks: num(m.folds) ?? num(m.blocks),
      holds: typeof m.holds_every_regatta === 'boolean' ? m.holds_every_regatta
        : typeof m.holds_every_block === 'boolean' ? m.holds_every_block : null,
      // `not_shipped` is TWO different things across the generations, which
      // is why this is not a plain concatenation. The Mediterranean specs put
      // a FORM NAME there ("bias_scale") with the reason in `why`, so it
      // reads "bias_scale not shipped — the gain did not hold...". The newest
      // two put a whole SENTENCE there ("best ladder gain 0.0% did not clear
      // the bars"), and appending "not shipped" to that produced "...did not
      // clear the bars not shipped".
      why: [formatNotShipped(m.not_shipped), m.why || null]
        .filter(Boolean).join(' — ') || null,
      notApplied: id in na ? String(na[id]) : null,
      slopeConstrained: m.slope_constrained === true,
      missing,
    }
  })
}

/**
 * Which optional columns any row at this venue can actually fill.
 *
 * A column of pure dashes is worse than no column: it reads as missing data
 * when the honest statement is that the measure does not exist here. "Dir
 * agree" is the clear case — it counts how often the model put the wind in the
 * band the BOAT was in, and a fixed station has no heading to agree with, so
 * at every station venue that column can only ever be empty. Same for the
 * stationarity flag at the two venues whose script enforced it without
 * recording it.
 *
 * Model / Correction / Gain are always drawn: the first two cannot be absent
 * and a venue with no gain anywhere has nothing to show at all.
 */
export type OptionalColumn = 'holds' | 'rawRmse' | 'cvRmse' | 'agree' | 'n'

export function columnsFor(rows: readonly ModelRow[]): OptionalColumn[] {
  const any = (f: (r: ModelRow) => unknown) => rows.some((r) => f(r) != null)
  return ([
    ['holds', (r: ModelRow) => r.holds],
    ['rawRmse', (r: ModelRow) => r.rawRmse],
    ['cvRmse', (r: ModelRow) => r.cvRmse],
    ['agree', (r: ModelRow) => r.agree],
    ['n', (r: ModelRow) => r.n],
  ] as Array<[OptionalColumn, (r: ModelRow) => unknown]>)
    .filter(([, f]) => any(f))
    .map(([k]) => k)
}

/** Where the truth came from, in one line, whichever generation wrote it. */
export function truthLine(spec: MosSpec | null | undefined): string | null {
  if (!spec) return null
  if (spec.truth_station_name) {
    const bits = [`${spec.truth_station_name} (${spec.truth_station})`]
    if (spec.truth_anemometer_m != null) bits.push(`anemometer ${spec.truth_anemometer_m} m`)
    if (spec.truth_nm_from_venue != null) bits.push(`${spec.truth_nm_from_venue} nm from the venue`)
    const f = spec.obs_height_adjustment?.factor
    if (f != null && spec.fit_height_m != null) bits.push(`reduced to ${spec.fit_height_m} m by x${f}`)
    return bits.join(', ')
  }
  if (spec.truth) {
    // The boat-log venues. The masthead heights are worth naming because the
    // obs files' own 30.0 is extract_obs.py's default, not a measurement.
    const mast = spec.truth_masthead_m?.length
      ? ` Masthead ${spec.truth_masthead_m.join(' and ')} m.`
      : ''
    return `${spec.truth}.${mast}`
  }
  return null
}

/**
 * How it was cross-validated. The footnote used to say leave-one-regatta-out
 * for every venue, which is true only of the boat-log ones — the station
 * venues hold out a YEAR at a time with a buffer, because an hourly series'
 * autocorrelation makes neighbouring hours nearly the same sample.
 */
export function cvScheme(spec: MosSpec | null | undefined): string {
  const byRegatta = Object.values(spec?.models ?? {})
    .some((m) => m.blocked_by === 'regatta' || typeof m.holds_every_regatta === 'boolean')
  return byRegatta
    ? 'leave-one-regatta-out'
    : 'leave-one-year-out, with a buffer either side of each held-out block'
}

/**
 * What height the coefficients were fitted at, and therefore where in the
 * chain they are applied. A 10 m-fitted intercept applied to a 30 m value is
 * wrong by the lift ratio, so `correctedWind30` corrects BEFORE lifting —
 * which is worth saying on screen, because the panel's heading says 30 m.
 */
export function heightNote(spec: MosSpec | null | undefined): string | null {
  const fit = spec?.fit_height_m
  const target = spec?.target_height_m ?? 30
  if (fit == null || fit >= target) {
    return `Fitted directly against ${target} m wind, so the correction is applied to the ${target} m value.`
  }
  return `Fitted at ${fit} m, where the truth is, then the corrected value is lifted to ${target} m `
    + `— the correction is applied BEFORE the lift, not after.`
}

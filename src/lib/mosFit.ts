// Fitting a MOS correction — the maths, kept pure so it can be tested.
//
// Built to the recommendation in reports/Mesoscale wind MOS post processing.md.
// The orchestration (fetching observations and archived forecasts) lives in
// scripts/mos-fit.ts; everything here is arithmetic on arrays.
//
// THREE THINGS THIS FILE EXISTS TO GET RIGHT.
//
// 1. THE FITTED FORM MUST BE THE FORM THE APP APPLIES. `applyMOS()` in
//    components/weather/mos.js computes a·x + b, optionally plus a 24 h
//    harmonic or a per-band offset. If the fit here parameterises any of that
//    differently, the stored spec silently does not reproduce the fit that
//    justified it. `predictSpecModel` below mirrors applyMOS term for term and
//    a test asserts the two agree to floating point.
//
// 2. b AND c0 ARE THE SAME COLUMN. applyMOS's diurnal form is
//    a·x + b + c0 + c1·sin + c2·cos, so b and c0 are both constants and a
//    joint least-squares fit of all five is singular. The existing
//    Mediterranean specs carry both non-zero, which means they were fitted in
//    some two-stage way that cannot be recovered from the JSON. So this fits
//    a, b, c1, c2 jointly and sets c0 = 0, folding the whole constant into b.
//    Four parameters, non-singular, and identical in output to any other split
//    of the same sum.
//
// 3. THE EFFECTIVE SAMPLE SIZE IS THE BINDING CONSTRAINT. Gullholmen's hourly
//    wind has a lag-1 autocorrelation of 0.883, so 33,932 hours behave like
//    about 2,100 independent samples. Every score here is reported with both
//    n and nEff, and the significance machinery (Diebold-Mariano with a
//    Newey-West long-run variance, plus a block bootstrap) exists because a
//    naive standard error on this data is about four times too narrow.

/** One paired hour: the model's wind, the observation, and when it was. */
export interface Pair {
  /** Epoch milliseconds, UTC. */
  t: number
  /** Model wind speed at the fit height, knots. */
  model: number
  /** Observed wind speed at the same height, knots. */
  obs: number
  /** Model wind direction, degrees FROM. Null where unavailable. */
  twd: number | null
  /** Local hour of day at the venue, 0-23, fractional allowed. */
  hour: number
  /**
   * Venue-local calendar month, 1-12. Optional, and the local one MATTERS:
   * a season window is a statement about the weather, which keeps venue time,
   * not UTC. `inMonths` falls back to the UTC month when it is absent, which
   * is off by an hour at the edges of a day and so by one day at the edge of a
   * month — tolerable for a season boundary, wrong for anything finer.
   */
  month?: number
}

export type MosType = 'raw' | 'bias_scale' | 'diurnal' | 'sector' | 'sector_diurnal'

/** A direction band, as the spec stores it: [name, loDeg, hiDeg]. */
export type Band = [string, number, number]

/** The coefficients for one model, in the shape the spec JSON stores. */
export interface MosModelSpec {
  type: MosType
  a?: number
  b?: number
  c0?: number
  c1?: number
  c2?: number
  delta?: Record<string, number>
  global?: number
}

// ── the form the app applies ───────────────────────────────────────────────

/**
 * Which band a direction falls in — mirrors assignSector in mos.js, including
 * the wrap-around case where lo > hi and the 'other' fallback.
 */
export function assignSector(twd: number, bands: readonly Band[]): string {
  const t = ((twd % 360) + 360) % 360
  for (const [name, lo, hi] of bands) {
    if (lo <= hi) { if (t >= lo && t <= hi) return name } else if (t >= lo || t <= hi) return name
  }
  return 'other'
}

/**
 * The corrected wind, computed exactly as applyMOS does.
 *
 * Kept here rather than imported because mos.js is a browser module and this
 * runs in scripts and tests; the test that pins them together is what stops
 * the two drifting.
 */
export function predictSpecModel(
  m: MosModelSpec,
  ws: number,
  twd: number | null,
  localHour: number | null,
  bands: readonly Band[],
): number {
  const t = m.type || 'raw'
  if (t === 'raw') return ws
  const base = (m.a ?? 1) * ws + (m.b ?? 0)
  if (t === 'bias_scale') return base
  if (t === 'diurnal') {
    if (localHour == null) return base
    const ang = (2 * Math.PI * localHour) / 24
    return base + (m.c0 ?? 0) + (m.c1 ?? 0) * Math.sin(ang) + (m.c2 ?? 0) * Math.cos(ang)
  }
  if (t === 'sector') {
    if (twd == null) return base
    const sec = assignSector(twd, bands)
    const d = m.delta ?? {}
    return base + (sec in d ? d[sec] : (m.global ?? 0))
  }
  if (t === 'sector_diurnal') {
    // Both terms, each degrading independently: a missing direction drops the
    // band offset and keeps the harmonic, a missing hour the other way round.
    // That is what applyMOS does, and the two must agree term for term.
    let v = base
    if (twd != null) {
      const sec = assignSector(twd, bands)
      const d = m.delta ?? {}
      v += sec in d ? d[sec] : (m.global ?? 0)
    }
    if (localHour != null) {
      const ang = (2 * Math.PI * localHour) / 24
      v += (m.c0 ?? 0) + (m.c1 ?? 0) * Math.sin(ang) + (m.c2 ?? 0) * Math.cos(ang)
    }
    return v
  }
  return ws
}

/** How many free parameters a form carries — for the parameter ceiling. */
export function paramCount(m: MosModelSpec, bands: readonly Band[]): number {
  switch (m.type) {
    case 'raw': return 0
    case 'bias_scale': return 2
    case 'diurnal': return 4            // a, b, c1, c2 — c0 is pinned to 0
    case 'sector': return 2 + Math.max(0, bands.length - 1)
    // a, b, c1, c2 and one offset per band beyond the reference. Seven with
    // four bands, which is why selectForm also asks for effective samples per
    // parameter rather than trusting a flat ceiling.
    case 'sector_diurnal': return 4 + Math.max(0, bands.length - 1)
    default: return 0
  }
}

// ── least squares ──────────────────────────────────────────────────────────

/**
 * Solve (XᵀX + λI)β = Xᵀy by Gaussian elimination with partial pivoting.
 *
 * The ridge term is a numerical floor, not a statistical choice: λ is tiny and
 * only stops a singular or near-singular normal matrix from returning
 * nonsense. A design that is genuinely rank-deficient — an empty direction
 * band, say — is caught by the caller, which refuses the form rather than
 * letting the ridge quietly invent a coefficient.
 */
export function solveOls(X: readonly number[][], y: readonly number[], lambda = 1e-10): number[] | null {
  const n = X.length
  if (!n || n !== y.length) return null
  const p = X[0].length
  if (p === 0) return []
  const A: number[][] = Array.from({ length: p }, () => new Array(p + 1).fill(0))
  for (let i = 0; i < n; i++) {
    const xi = X[i]
    for (let r = 0; r < p; r++) {
      for (let c = 0; c < p; c++) A[r][c] += xi[r] * xi[c]
      A[r][p] += xi[r] * y[i]
    }
  }
  for (let r = 0; r < p; r++) A[r][r] += lambda
  for (let col = 0; col < p; col++) {
    let piv = col
    for (let r = col + 1; r < p; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r
    if (Math.abs(A[piv][col]) < 1e-12) return null
    if (piv !== col) { const tmp = A[piv]; A[piv] = A[col]; A[col] = tmp }
    const d = A[col][col]
    for (let c = col; c <= p; c++) A[col][c] /= d
    for (let r = 0; r < p; r++) {
      if (r === col) continue
      const f = A[r][col]
      if (f === 0) continue
      for (let c = col; c <= p; c++) A[r][c] -= f * A[col][c]
    }
  }
  return A.map((row) => row[p])
}

// ── fitting each form ──────────────────────────────────────────────────────

/**
 * The reference band is the one with the most cases, and its offset is folded
 * into b so the design is not rank-deficient. `global` — applyMOS's fallback
 * for a direction in no band — is set to 0 for the same reason: it is the
 * reference level, not a free parameter.
 */
export function fitForm(
  type: MosType,
  rows: readonly Pair[],
  bands: readonly Band[],
  opts: { minPerBand?: number } = {},
): MosModelSpec | null {
  if (type === 'raw') return { type: 'raw' }
  if (!rows.length) return null

  const y = rows.map((r) => r.obs)

  if (type === 'bias_scale') {
    const X = rows.map((r) => [r.model, 1])
    const beta = solveOls(X, y)
    return beta ? { type, a: beta[0], b: beta[1] } : null
  }

  if (type === 'diurnal') {
    const X = rows.map((r) => {
      const ang = (2 * Math.PI * r.hour) / 24
      return [r.model, 1, Math.sin(ang), Math.cos(ang)]
    })
    const beta = solveOls(X, y)
    // c0 is pinned to 0: it is the same column as b (see the header note).
    return beta ? { type, a: beta[0], b: beta[1], c0: 0, c1: beta[2], c2: beta[3] } : null
  }

  if (type !== 'sector' && type !== 'sector_diurnal') return null

  // sector, and sector_diurnal — the same dummy coding, with the 24 h harmonic
  // carried as two more columns so every coefficient is fitted jointly. Fitting
  // the bands first and the harmonic on the residual would give a different
  // answer whenever the two are correlated, which on a thermal coast they are:
  // the sea breeze arrives in the afternoon AND from one quadrant.
  const harmonic = type === 'sector_diurnal'
  const minPer = opts.minPerBand ?? 50
  const withDir = rows.filter((r) => r.twd != null)
  if (!withDir.length) return null
  const counts = new Map<string, number>()
  for (const r of withDir) {
    const s = assignSector(r.twd!, bands)
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  // Every band the spec declares must be populated, or the offset for an empty
  // one is whatever the ridge says. Refuse instead.
  for (const [name] of bands) if ((counts.get(name) ?? 0) < minPer) return null

  // 'other' — a direction in NO declared band — is its own level, because
  // applyMOS gives those rows `global` rather than any band's offset. Folding
  // them into the reference band instead (the first version of this) fits a
  // model the app does not apply: with bands of 0-70/80-200/200-270/270-360
  // the 10-degree gap is ~3% of rows, and giving them the reference offset
  // dragged every recovered offset about 3% short of truth.
  //
  // If 'other' is too rare to estimate, those rows are DROPPED from the fit
  // and `global` stays 0, which is the reference level — honest, and the only
  // value that cannot be worse than an offset invented from a dozen cases.
  const names = bands.map(([n]) => n)
  const otherN = counts.get('other') ?? 0
  const fitOther = otherN >= minPer
  const levels = fitOther ? [...names, 'other'] : names
  const used = fitOther ? withDir : withDir.filter((r) => assignSector(r.twd!, bands) !== 'other')
  if (!used.length) return null

  const ref = levels.slice().sort((p, q) => (counts.get(q) ?? 0) - (counts.get(p) ?? 0))[0]
  const free = levels.filter((n) => n !== ref)
  const X = used.map((r) => {
    const s = assignSector(r.twd!, bands)
    const ang = (2 * Math.PI * r.hour) / 24
    return [
      r.model, 1,
      ...(harmonic ? [Math.sin(ang), Math.cos(ang)] : []),
      ...free.map((n) => (s === n ? 1 : 0)),
    ]
  })
  const beta = solveOls(X, used.map((r) => r.obs))
  if (!beta) return null
  const k = harmonic ? 4 : 2
  const coef: Record<string, number> = { [ref]: 0 }
  free.forEach((n, i) => { coef[n] = beta[k + i] })
  const delta: Record<string, number> = {}
  for (const n of names) delta[n] = coef[n] ?? 0
  const out: MosModelSpec = {
    type, a: beta[0], b: beta[1], delta, global: fitOther ? (coef.other ?? 0) : 0,
  }
  // c0 is pinned to 0 here for the same reason as in the diurnal form: it is
  // the same column as b.
  if (harmonic) { out.c0 = 0; out.c1 = beta[2]; out.c2 = beta[3] }
  return out
}

/**
 * The rows whose venue-local month is in `months` (1-12).
 *
 * A season window, which is the Mediterranean specs' hidden ingredient: those
 * were fitted on regatta days, every one of them in summer, so their diurnal
 * term is a SUMMER harmonic. Fitting the same term across twelve months
 * averages a sea-breeze amplitude against the five months that have none, and
 * the amplitude comes out shrunk by roughly the fraction of the year that is
 * not summer — then gets applied in January, where it is noise.
 */
export function inMonths(rows: readonly Pair[], months: readonly number[]): Pair[] {
  const want = new Set(months)
  return rows.filter((r) => want.has(r.month ?? new Date(r.t).getUTCMonth() + 1))
}

// ── scoring ────────────────────────────────────────────────────────────────

export interface Scores {
  n: number
  nEff: number
  bias: number
  mae: number
  rmse: number
  /** Regression slope of obs on prediction — 1.0 means variance preserved. */
  slope: number
  /** sd(prediction) / sd(observation). Below 1 means the fit flattened variance. */
  varRatio: number
}

const mean = (a: readonly number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1)

export function lag1(series: readonly number[]): number {
  const n = series.length
  if (n < 3) return 0
  const mu = mean(series)
  let num = 0; let den = 0
  for (let i = 0; i < n; i++) {
    den += (series[i] - mu) ** 2
    if (i) num += (series[i] - mu) * (series[i - 1] - mu)
  }
  return den > 0 ? num / den : 0
}

/**
 * Wilks' effective sample size, N(1−r₁)/(1+r₁).
 *
 * Measured on Gullholmen's own series this takes 8,753 hourly rows to 542 —
 * 6.2% — so a standard error computed on the nominal count is about four
 * times too narrow. Floored at 2 because a non-positive effective n is
 * meaningless, and clamped at n because a negative r₁ should not manufacture
 * more information than was collected.
 */
export function effectiveN(n: number, r1: number): number {
  if (!(n > 0)) return 0
  const r = Math.max(-0.999, Math.min(0.999, r1))
  return Math.max(2, Math.min(n, (n * (1 - r)) / (1 + r)))
}

export function score(pred: readonly number[], obs: readonly number[]): Scores {
  const n = Math.min(pred.length, obs.length)
  // An empty set has no score. Without this the mean() helper divides by 1 and
  // reports a confident rmse of 0 — "perfect" — for no data at all, which is
  // the worst possible way to fail.
  if (!n) return { n: 0, nEff: 0, bias: NaN, mae: NaN, rmse: NaN, slope: NaN, varRatio: NaN }
  const e: number[] = []
  for (let i = 0; i < n; i++) e.push(pred[i] - obs[i])
  const mp = mean(pred.slice(0, n)); const mo = mean(obs.slice(0, n))
  let sxy = 0; let sxx = 0; let syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (pred[i] - mp) * (obs[i] - mo)
    sxx += (pred[i] - mp) ** 2
    syy += (obs[i] - mo) ** 2
  }
  return {
    n,
    nEff: effectiveN(n, lag1(e)),
    bias: mean(e),
    mae: mean(e.map(Math.abs)),
    rmse: Math.sqrt(mean(e.map((x) => x * x))),
    slope: sxx > 0 ? sxy / sxx : NaN,
    varRatio: syy > 0 ? Math.sqrt(sxx / syy) : NaN,
  }
}

/** Percentage RMSE improvement against the uncorrected model. */
export function piRmse(rmseMos: number, rmseRaw: number): number {
  return rmseRaw > 0 ? 100 * (1 - rmseMos / rmseRaw) : NaN
}

/** Skill score against a reference forecast: 1 is perfect, 0 is no better. */
export function skill(rmse: number, rmseRef: number): number {
  return rmseRef > 0 ? 1 - rmse / rmseRef : NaN
}

/**
 * Persistence as a reference: the observation one hour earlier.
 *
 * The harder benchmark inside a few hours and the easier one beyond about
 * half a day, which is why the report asks for both this and climatology.
 * Only consecutive hours count — a gap must not be scored as persistence.
 */
export function persistenceRmse(rows: readonly Pair[], maxGapMs = 3600_000 * 1.5): number {
  const s = rows.slice().sort((p, q) => p.t - q.t)
  const e: number[] = []
  for (let i = 1; i < s.length; i++) {
    if (s[i].t - s[i - 1].t <= maxGapMs) e.push(s[i - 1].obs - s[i].obs)
  }
  return e.length ? Math.sqrt(mean(e.map((x) => x * x))) : NaN
}

// ── cross-validation blocking ──────────────────────────────────────────────

/**
 * Leave-one-year-out blocks, which is what the report prescribes: four blocks
 * over this archive, blocking at a scale far beyond any plausible residual
 * timescale while also testing across-season and across-year transfer.
 *
 * A year with fewer than `minRows` hours is merged into the next one, so the
 * Dec-2022 stub joins 2023 rather than becoming a block of its own.
 */
export function yearBlocks(rows: readonly Pair[], minRows = 2000): Pair[][] {
  const byYear = new Map<number, Pair[]>()
  for (const r of rows) {
    const y = new Date(r.t).getUTCFullYear()
    const a = byYear.get(y) ?? []
    a.push(r)
    byYear.set(y, a)
  }
  const years = Array.from(byYear.keys()).sort()
  const out: Pair[][] = []
  let carry: Pair[] = []
  for (const y of years) {
    const block = carry.concat(byYear.get(y)!)
    if (block.length < minRows) { carry = block; continue }
    out.push(block)
    carry = []
  }
  if (carry.length) {
    if (out.length) out[out.length - 1] = out[out.length - 1].concat(carry)
    else out.push(carry)
  }
  return out
}

/**
 * Drop training rows within `bufferMs` of any test row.
 *
 * At a lag-1 autocorrelation of 0.883 an adjacent hour is very nearly the same
 * observation, so a block boundary without a buffer still leaks. The report
 * asks for at least 48 h, bracketed by the measured 11 h speed decorrelation
 * above and the 6.3-6.5 h literature figure for residuals below.
 */
export function withBuffer(train: readonly Pair[], test: readonly Pair[], bufferMs = 48 * 3600_000): Pair[] {
  if (!test.length) return train.slice()
  const times = test.map((r) => r.t).sort((a, b) => a - b)
  // Find the insertion point, then check only its two neighbours. The nearest
  // test row to t is necessarily one of those, which makes this obviously
  // correct rather than correct-if-you-trace-the-probes.
  const near = (t: number) => {
    let lo = 0; let hi = times.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (times[mid] < t) lo = mid + 1; else hi = mid
    }
    if (lo < times.length && times[lo] - t <= bufferMs) return true
    if (lo > 0 && t - times[lo - 1] <= bufferMs) return true
    return false
  }
  return train.filter((r) => !near(r.t))
}

// ── significance ───────────────────────────────────────────────────────────

/**
 * Diebold-Mariano on a paired loss differential, with a Newey-West long-run
 * variance.
 *
 * `d` is lossA − lossB per observation (squared error for an RMSE comparison,
 * absolute error for MAE). A positive statistic means A is worse. The HAC
 * bandwidth should come from the residual autocorrelation, not from a rule of
 * thumb — the caller measures it.
 */
export function dieboldMariano(d: readonly number[], bandwidth: number): { stat: number; meanDiff: number; se: number } {
  const n = d.length
  if (n < 10) return { stat: NaN, meanDiff: NaN, se: NaN }
  const md = mean(d)
  const dev = d.map((x) => x - md)
  let lrv = dev.reduce((s, x) => s + x * x, 0) / n
  const L = Math.max(0, Math.min(Math.floor(bandwidth), n - 2))
  for (let k = 1; k <= L; k++) {
    let g = 0
    for (let i = k; i < n; i++) g += dev[i] * dev[i - k]
    g /= n
    lrv += 2 * (1 - k / (L + 1)) * g      // Bartlett kernel
  }
  const se = Math.sqrt(Math.max(lrv, 0) / n)
  return { stat: se > 0 ? md / se : NaN, meanDiff: md, se }
}

/**
 * Block bootstrap confidence interval for the mean of a loss differential.
 *
 * Blocks of at least a day, per the report, so that the resampling preserves
 * the dependence the Newey-West correction only approximates. Deterministic by
 * default: the seed is fixed so a reported interval is reproducible.
 */
export function blockBootstrapCI(
  d: readonly number[],
  blockLen: number,
  iters = 2000,
  alpha = 0.05,
  seed = 20261027,
): { lo: number; hi: number } {
  const n = d.length
  if (n < blockLen * 3) return { lo: NaN, hi: NaN }
  let s = seed >>> 0
  const rnd = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
  const nb = Math.ceil(n / blockLen)
  const means: number[] = []
  for (let it = 0; it < iters; it++) {
    let sum = 0; let cnt = 0
    for (let b = 0; b < nb; b++) {
      const start = Math.floor(rnd() * (n - blockLen + 1))
      for (let i = 0; i < blockLen; i++) { sum += d[start + i]; cnt++ }
    }
    means.push(sum / cnt)
  }
  means.sort((a, b) => a - b)
  return {
    lo: means[Math.floor((alpha / 2) * iters)],
    hi: means[Math.min(iters - 1, Math.floor((1 - alpha / 2) * iters))],
  }
}

// ── nested selection ───────────────────────────────────────────────────────

export interface FormResult {
  type: MosType
  spec: MosModelSpec
  /** Out-of-sample scores, pooled across the held-out blocks. */
  cv: Scores
  params: number
  /**
   * Per-block scores, which the pooled figure hides.
   *
   * The report's bar for a meaningful gain is that it "hold in sign in EVERY
   * held-out year rather than on average". A pooled RMSE cannot answer that: a
   * form that helps hugely in three years and hurts in the fourth averages out
   * looking fine, and that fourth year is the one that says the correction is
   * not stationary — which is the live risk when the underlying model is
   * upgraded mid-archive.
   */
  perBlock: Array<{ label: string; n: number; rmse: number; rawRmse: number; piRmse: number }>
  /** Why this form was rejected, where it was. */
  refused?: string
}

/**
 * Fit each candidate form on the training blocks and score it on the held-out
 * ones, pooling predictions across folds.
 *
 * Nested on purpose, so each comparison is one step: raw, then a·x+b, then the
 * harmonic, then the sector offsets. A step is kept only if it wins out of
 * sample — the protocol the report takes from Schulz & Lerch.
 */
export function crossValidateForms(
  rows: readonly Pair[],
  bands: readonly Band[],
  opts: { bufferMs?: number; minPerBand?: number; minRowsPerBlock?: number; types?: MosType[] } = {},
): { blocks: number; results: FormResult[] } {
  const blocks = yearBlocks(rows, opts.minRowsPerBlock ?? 2000)
  // Training on "every other block" and training on "every year not in this
  // block" are the same thing here, because yearBlocks partitions by whole
  // years. So this is the general function with the whole series as its pool.
  return { blocks: blocks.length, results: crossValidateAgainstBlocks(rows, blocks, bands, opts) }
}

/** The ladder, in order. Each step adds one idea to the one before it. */
export const LADDER: MosType[] = ['raw', 'bias_scale', 'diurnal', 'sector', 'sector_diurnal']

/**
 * Fit each form on a training POOL and score it on given held-out blocks.
 *
 * Separating the pool from the blocks is what lets a season-restricted fit be
 * compared with a year-round one ON THE SAME HELD-OUT HOURS — the only
 * comparison that answers "does fitting summer separately pay?". Both arms
 * hold out the same summer; one trains on summers, the other on whole years.
 *
 * Training rows are excluded by YEAR, not by membership of the test block: a
 * summer block of 2025 must not be predicted by a model trained on April 2025,
 * and a 48 h buffer would not have stopped that.
 */
export function crossValidateAgainstBlocks(
  trainPool: readonly Pair[],
  testBlocks: readonly Pair[][],
  bands: readonly Band[],
  opts: { bufferMs?: number; minPerBand?: number; types?: MosType[] } = {},
): FormResult[] {
  const types = opts.types ?? LADDER
  const results: FormResult[] = []
  const yearOf = (r: Pair) => new Date(r.t).getUTCFullYear()

  for (const type of types) {
    const pred: number[] = []
    const obs: number[] = []
    const perBlock: FormResult['perBlock'] = []
    let refused: string | undefined
    for (let i = 0; i < testBlocks.length; i++) {
      const test = testBlocks[i]
      if (!test.length) continue
      const years = new Set(test.map(yearOf))
      const pool = trainPool.filter((r) => !years.has(yearOf(r)))
      const train = withBuffer(pool, test, opts.bufferMs ?? 48 * 3600_000)
      const m = fitForm(type, train, bands, { minPerBand: opts.minPerBand })
      if (!m) { refused = `fold ${i + 1} could not be fitted (rank or band support)`; break }
      const bp: number[] = []
      const bo: number[] = []
      const bm: number[] = []
      for (const r of test) {
        if ((type === 'sector' || type === 'sector_diurnal') && r.twd == null) continue
        const v = predictSpecModel(m, r.model, r.twd, r.hour, bands)
        pred.push(v); obs.push(r.obs)
        bp.push(v); bo.push(r.obs); bm.push(r.model)
      }
      if (bp.length) {
        const sc = score(bp, bo)
        const sr = score(bm, bo)
        perBlock.push({
          label: String(new Date(test[0].t).getUTCFullYear()),
          n: bp.length,
          rmse: sc.rmse,
          rawRmse: sr.rmse,
          piRmse: piRmse(sc.rmse, sr.rmse),
        })
      }
    }
    if (refused || !pred.length) {
      results.push({
        type,
        spec: { type },
        cv: score([], []),
        params: paramCount({ type }, bands),
        perBlock,
        refused: refused ?? 'no out-of-sample predictions',
      })
      continue
    }
    // The shipped coefficients are refitted on the whole pool; the CV scores
    // above are what justify the FORM, not these numbers.
    const full = fitForm(type, trainPool, bands, { minPerBand: opts.minPerBand })
    results.push({
      type,
      spec: full ?? { type },
      cv: score(pred, obs),
      params: paramCount({ type }, bands),
      perBlock,
    })
  }
  return results
}

/**
 * Does fitting a season on its own beat fitting the whole year?
 *
 * Both arms are scored on the SAME held-out season hours, blocked by year. The
 * seasonal arm trains only on the season; the year-round arm trains on every
 * month of the other years. If the seasonal arm does not win here it should
 * not be shipped, because a season-restricted spec trades away five sixths of
 * its training data for the privilege of having its own coefficients.
 */
export function seasonComparison(
  rows: readonly Pair[],
  bands: readonly Band[],
  months: readonly number[],
  opts: { bufferMs?: number; minPerBand?: number; minRowsPerBlock?: number; types?: MosType[] } = {},
): { blocks: number; nSeason: number; yearRound: FormResult[]; seasonal: FormResult[] } {
  const season = inMonths(rows, months)
  const blocks = yearBlocks(season, opts.minRowsPerBlock ?? 500)
  return {
    blocks: blocks.length,
    nSeason: season.length,
    yearRound: crossValidateAgainstBlocks(rows, blocks, bands, opts),
    seasonal: crossValidateAgainstBlocks(season, blocks, bands, opts),
  }
}

/**
 * Pick the form to ship.
 *
 * The one-standard-error rule: among forms whose CV RMSE is within one
 * standard error of the best, take the one with the fewest parameters. With
 * about 2,100 independent samples the difference between two forms is usually
 * inside the noise, and preferring the simpler one is how that gets respected
 * rather than ignored. The standard error uses nEff, not n.
 */
export function selectForm(
  results: readonly FormResult[],
  maxParams = 7,
  minEffPerParam = 20,
): FormResult | null {
  // A flat parameter ceiling is the wrong instrument on its own: six
  // parameters are comfortable on 24,000 year-round hours and reckless on a
  // single summer's worth. So a form must ALSO have `minEffPerParam`
  // effective samples per parameter — the classic twenty — measured on nEff,
  // because that is the number the autocorrelation leaves.
  const ok = results.filter((r) => !r.refused && Number.isFinite(r.cv.rmse) && r.params <= maxParams
    && (r.params === 0 || r.cv.nEff / r.params >= minEffPerParam))
  if (!ok.length) return null
  const best = ok.reduce((p, q) => (q.cv.rmse < p.cv.rmse ? q : p))
  // SE of an RMSE is approximately rmse / sqrt(2·nEff).
  const se = best.cv.rmse / Math.sqrt(2 * Math.max(2, best.cv.nEff))
  const within = ok.filter((r) => r.cv.rmse <= best.cv.rmse + se)
  return within.reduce((p, q) => (q.params < p.params ? q : p))
}

/**
 * Does the gain hold in sign in every held-out block?
 *
 * The report's bar, and the one a pooled average cannot answer. `raw` is
 * exempt because it has no gain to hold.
 */
export function gainHoldsEveryBlock(r: FormResult): boolean {
  if (r.type === 'raw' || r.refused) return false
  return r.perBlock.length > 1 && r.perBlock.every((b) => b.piRmse > 0)
}

// ── the tail: what an rmse-optimal slope does to the strong wind ────────────
//
// WHY THIS IS HERE AND NOT IN ONE VENUE'S SCRIPT. Found 28 Oct 2026 fitting
// Long Beach, then run against the three Mediterranean specs that had shipped
// seven months earlier. An rmse-optimal slope is a SHRINKAGE: ordinary least
// squares sets a = cov(x,y)/var(x), so a model poorly correlated with the
// truth is pulled toward the climatological mean, and rmse is minimised by
// exactly that. It reads as a large gain — 13 to 30 % at Long Beach — and what
// it buys that gain with is the venue's strong wind. ECMWF's corrected
// forecast there warned on ZERO of the 130 hours Angels Gate really had
// 18 kn or more; the raw forecast warned on 86.
//
// None of rmse, the per-block stationarity bar or the parameter ceiling can
// see it, because all three are averages over a distribution whose mass is in
// the middle. So it needs its own measurement, and every venue's fit needs the
// same one or the next spec ships with the same hole.
//
// THE SLOPE ALONE IS NOT THE DIAGNOSTIC, which is the part worth not
// re-deriving. a < 1 rotates the forecast about its FIXED POINT
// x* = b/(1 - a), and the sign of the change at a strong-wind threshold T is
// the sign of T - x*. Sorrento's icon_eu has a = 0.76 and x* = 20.6 kn, above
// almost everything that venue blows, so its correction LIFTS the whole
// observed range. Porto Cervo's ecmwf has a = 0.70 and x* = 9.2 kn, so at
// 20 kn it takes 3.2 kn off. Same slope to one decimal place, opposite
// behaviour where it matters. Report `shrinkageAt`, not `a`.

/** The strong-wind levels a tail check is measured at, in knots. */
export interface TailBars {
  /** "it will blow this hard" — the level the warning rate is counted at. */
  threshold: number
  /** The strong end, whose mean error must not collapse. */
  topBin: number
  label?: string
}

export interface TailStat {
  /** Cases the truth was at or above `threshold`. */
  nAbove: number
  /** Of those, how many the RAW forecast also put at or above it. */
  warnRaw: number
  /** Of those, how many the CORRECTED forecast did. */
  warnCor: number
  /** Cases the truth was at or above `topBin`. */
  topN: number
  /** Mean signed error (forecast - truth) over those, raw and corrected. */
  topRaw: number
  topCor: number
}

/** How many cases a warning rate needs before it is worth reading. */
export const TAIL_MIN_ABOVE = 20
/** How many a top-bin mean error needs. */
export const TAIL_MIN_TOP = 10
/** Keep at least this fraction of raw's strong-wind hits. */
export const TAIL_WARN_KEEP = 0.9
/** Knots of allowed degradation in the top bin's mean error. */
export const TAIL_TOP_SLACK = 2

export interface TailOpts {
  warnKeep?: number
  topSlack?: number
  minAbove?: number
  minTop?: number
}

/**
 * Tail statistics, on predictions that must be OUT OF SAMPLE for the numbers
 * to mean anything.
 *
 * `warn` is a hit COUNT, not a skill score, on purpose: the operational
 * question is how many of the windy hours you were told about, and rmse is
 * blind to it. The three arrays are parallel — truth, raw forecast, corrected
 * forecast, one entry per case.
 */
export function tailStats(
  obs: readonly number[], raw: readonly number[], cor: readonly number[], bars: TailBars,
): TailStat {
  let nAbove = 0; let warnRaw = 0; let warnCor = 0
  let topN = 0; let topRaw = 0; let topCor = 0
  for (let i = 0; i < obs.length; i++) {
    if (obs[i] >= bars.threshold) {
      nAbove++
      if (raw[i] >= bars.threshold) warnRaw++
      if (cor[i] >= bars.threshold) warnCor++
    }
    if (obs[i] >= bars.topBin) { topN++; topRaw += raw[i] - obs[i]; topCor += cor[i] - obs[i] }
  }
  return {
    nAbove, warnRaw, warnCor, topN,
    topRaw: topN ? topRaw / topN : NaN,
    topCor: topN ? topCor / topN : NaN,
  }
}

/** Fraction of raw's strong-wind hits the correction keeps, NaN if raw had none. */
export function tailKeep(t: TailStat): number {
  return t.warnRaw ? t.warnCor / t.warnRaw : NaN
}

/** Is there enough strong wind in the record to judge the tail at all? */
export function tailJudgeable(t: TailStat, o: TailOpts = {}): boolean {
  return t.nAbove >= (o.minAbove ?? TAIL_MIN_ABOVE) && t.warnRaw > 0
}

/**
 * The tail bar. A form passes when it keeps enough of raw's strong-wind hits
 * and does not wreck the top bin's mean error.
 *
 * An unjudgeable tail passes — a venue whose record holds nine cases above the
 * threshold cannot refuse a form on them, and saying so is more honest than a
 * bar measured on nine cases. `tailVerdict` prints which of the two happened.
 */
export function tailPasses(t: TailStat, _bars: TailBars, o: TailOpts = {}): boolean {
  const warnKeep = o.warnKeep ?? TAIL_WARN_KEEP
  const topSlack = o.topSlack ?? TAIL_TOP_SLACK
  if (tailJudgeable(t, o) && tailKeep(t) < warnKeep) return false
  if (t.topN >= (o.minTop ?? TAIL_MIN_TOP) && Number.isFinite(t.topCor)
    && t.topCor < t.topRaw - topSlack) return false
  return true
}

/** The verdict in one line, in the same vocabulary as the bar. */
export function tailVerdict(t: TailStat, bars: TailBars, o: TailOpts = {}): string {
  const topPart = t.topN >= (o.minTop ?? TAIL_MIN_TOP)
    ? `, ${bars.topBin}+ err ${t.topCor.toFixed(1)} vs raw ${t.topRaw.toFixed(1)} kn (n ${t.topN})`
    : ''
  if (!tailJudgeable(t, o)) {
    return `too few cases >= ${bars.threshold} kn (${t.nAbove}`
      + `${t.warnRaw === 0 && t.nAbove > 0 ? ', none of which raw caught' : ''})`
      + ` to judge the warning rate${topPart}`
  }
  return `${tailPasses(t, bars, o) ? 'PASSES' : 'FAILS'} the tail bar — keeps`
    + ` ${(100 * tailKeep(t)).toFixed(0)}% of raw's >=${bars.threshold} kn hits`
    + ` (${t.warnCor}/${t.warnRaw})${topPart}`
}

/**
 * Read the bars off the observed distribution rather than choosing them.
 *
 * The levels have to come from the record or they are tuned to the result:
 * Long Beach's racing season never reaches 20 kn in five years, so an 18 kn
 * warning bar inside it is measured on one hour, and the first run of that arm
 * printed "1 hrs only" and could not judge the thing the bar exists for.
 *
 * `threshold` is the highest step with at least `minAbove` cases and `topBin`
 * the highest with at least `minTop`; a venue with a thin tail comes back with
 * the two equal, which is two statements about the same cases and is still
 * worth having. Null when even the lowest step is too thin.
 */
export function pickTailBars(
  obs: readonly number[],
  o: { steps?: readonly number[]; minAbove?: number; minTop?: number; label?: string } = {},
): TailBars | null {
  const steps = o.steps ?? [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]
  const minAbove = o.minAbove ?? 25
  const minTop = o.minTop ?? TAIL_MIN_TOP
  const count = (t: number) => obs.reduce((n, x) => n + (x >= t ? 1 : 0), 0)
  let threshold = NaN; let topBin = NaN
  for (const s of steps) {
    if (count(s) >= minAbove) threshold = s
    if (count(s) >= minTop) topBin = s
  }
  if (!Number.isFinite(threshold)) return null
  return {
    threshold,
    topBin: Number.isFinite(topBin) ? Math.max(topBin, threshold) : threshold,
    ...(o.label ? { label: o.label } : {}),
  }
}

/**
 * The fixed point of a linear correction, b/(1 - a): the wind speed it leaves
 * alone. Below it the correction lifts and above it the correction cuts, or
 * the other way round for a slope above 1. Null for a slope of exactly 1 (a
 * pure offset moves everything equally) or a form with no slope.
 */
export function shrinkageFixedPoint(m: MosModelSpec): number | null {
  if (!m || (m.type ?? 'raw') === 'raw') return null
  const a = m.a ?? 1
  if (Math.abs(1 - a) < 1e-9) return null
  return (m.b ?? 0) / (1 - a)
}

/**
 * What the correction's SLOPE AND BIAS do to a forecast of `ws`, in knots,
 * ignoring the sector and diurnal offsets — which are bounded, while this term
 * grows without limit as the wind does.
 *
 * This is the number to report beside a slope. A 3 kn cut at the venue's
 * 20 kn is a different object from the same slope lifting the whole range.
 */
export function shrinkageAt(m: MosModelSpec, ws: number): number {
  if (!m || (m.type ?? 'raw') === 'raw') return 0
  return (m.a ?? 1) * ws + (m.b ?? 0) - ws
}

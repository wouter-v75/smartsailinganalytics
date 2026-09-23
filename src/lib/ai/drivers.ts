// src/lib/ai/drivers.ts
// ─────────────────────────────────────────────────────────────────────────────
// "What is the dominant parameter to get right for optimum VMG% in 12–14 kn?"
//
// Ranks every candidate channel by how much of the target's variation it
// accounts for, inside whatever slice of phases it is handed. Pure maths, no
// Supabase, no model — because this is the question where a language model left
// to reason on its own is at its most confidently wrong, and where a number that
// nobody computed is indistinguishable from one that somebody did.
//
// Two deliberate choices about the statistic:
//
// • BANDS, NOT A STRAIGHT LINE. The interesting settings do not behave linearly.
//   Heel has an optimum — too little and too much are both slow — and a
//   correlation coefficient reports ~0 for a perfect inverted U, which would
//   rank the single most important thing on the boat dead last. Splitting the
//   channel into equal-count bands and comparing the target across them finds
//   the optimum AND says where it is, which is the half the crew can act on.
//
// • EQUAL-COUNT BANDS, NOT EQUAL-WIDTH. One phase at 31° of heel must not
//   become a band of its own and win the ranking with a sample of one.
//
// What it will NOT do is call anything a cause. A crew trims IN RESPONSE to
// conditions, so a setting that tracks the target may be reading the day rather
// than driving it. Every ranking here carries its n, its separation from the
// next candidate, and a flag when it moves with the wind — see the caveats
// assembled in rankDrivers().
// ─────────────────────────────────────────────────────────────────────────────

export interface DriverPoint { x: number; y: number }

export interface Band {
  lo: number
  hi: number
  n: number
  mean: number
}

export interface DriverResult {
  key: string
  n: number
  bands: Band[]
  /** Share of the target's variance the bands account for — 0 to 1. */
  eta2: number
  /** Best band's mean minus worst band's — the target units actually on offer. */
  spread: number
  best: Band
  worst: Band
  /** Pearson r against the target: sign and straightness, next to a banded eta². */
  r: number
  /** |r| against the conditions channel — high means it may be reading the day. */
  rWithConditions: number
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

export function pearson(pts: DriverPoint[]): number {
  const n = pts.length
  if (n < 3) return 0
  const mx = mean(pts.map(p => p.x)), my = mean(pts.map(p => p.y))
  let sxy = 0, sxx = 0, syy = 0
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0
}

/**
 * Split into `count` bands of roughly equal COUNT, by the x quantiles. Bands
 * thinner than `minPerBand` are merged away rather than reported — a band of two
 * phases is a rumour, and the whole point of this ranking is not to publish one.
 */
export function quantileBands(pts: DriverPoint[], count: number, minPerBand: number): Band[] {
  const sorted = [...pts].sort((a, b) => a.x - b.x)
  if (sorted.length < minPerBand * 2) return []
  const k = Math.min(count, Math.floor(sorted.length / minPerBand))
  if (k < 2) return []
  const out: Band[] = []
  for (let i = 0; i < k; i++) {
    const a = Math.floor((i * sorted.length) / k)
    const b = i === k - 1 ? sorted.length : Math.floor(((i + 1) * sorted.length) / k)
    const slice = sorted.slice(a, b)
    if (slice.length < minPerBand) continue
    out.push({
      lo: slice[0].x,
      hi: slice[slice.length - 1].x,
      n: slice.length,
      mean: mean(slice.map(p => p.y)),
    })
  }
  return out
}

/** Share of the target's variance explained by which band a phase falls in. */
export function etaSquared(bands: Band[], all: number[]): number {
  if (bands.length < 2 || all.length < 2) return 0
  const grand = mean(all)
  const ssTot = all.reduce((s, v) => s + (v - grand) ** 2, 0)
  if (!ssTot) return 0
  const ssBetween = bands.reduce((s, b) => s + b.n * (b.mean - grand) ** 2, 0)
  return Math.max(0, Math.min(1, ssBetween / ssTot))
}

export interface RankOptions {
  /** Phases as {values: channel → number, target: number}. */
  rows: { values: Record<string, number | null | undefined>; target: number }[]
  candidates: string[]
  /** The channel the conditions live in — used only to flag a confound. */
  conditionsKey?: string
  bands?: number
  minPerBand?: number
}

export interface RankedDrivers {
  ranked: DriverResult[]
  /** Everything the reader must know before treating the top row as an instruction. */
  caveats: string[]
}

/** Above this, a candidate is probably tracking the conditions rather than the boat. */
export const CONFOUND_R = 0.5
/** Below this separation, the top two are a coin toss and must not be ranked against each other. */
export const TIE_MARGIN = 0.03

export function rankDrivers(opts: RankOptions): RankedDrivers {
  const { rows, candidates, conditionsKey = 'tws', bands = 3, minPerBand = 5 } = opts
  const ranked: DriverResult[] = []

  for (const key of candidates) {
    const pts: DriverPoint[] = []
    const cond: DriverPoint[] = []
    for (const r of rows) {
      const x = r.values[key]
      if (typeof x !== 'number' || !Number.isFinite(x)) continue
      pts.push({ x, y: r.target })
      const c = r.values[conditionsKey]
      if (typeof c === 'number' && Number.isFinite(c)) cond.push({ x, y: c })
    }
    const b = quantileBands(pts, bands, minPerBand)
    if (b.length < 2) continue
    const sortedByMean = [...b].sort((p, q) => p.mean - q.mean)
    const worst = sortedByMean[0], best = sortedByMean[sortedByMean.length - 1]
    ranked.push({
      key,
      n: pts.length,
      bands: b,
      eta2: etaSquared(b, pts.map(p => p.y)),
      spread: best.mean - worst.mean,
      best,
      worst,
      r: pearson(pts),
      rWithConditions: Math.abs(pearson(cond)),
    })
  }

  ranked.sort((a, b) => b.eta2 - a.eta2)

  // ── The caveats are not decoration: they are the difference between a ranking
  // and an instruction, and the model is told to relay them.
  const caveats: string[] = []
  if (!ranked.length) {
    caveats.push('No channel had enough phases spread across enough of its range to rank.')
    return { ranked, caveats }
  }
  caveats.push(
    'This is association, not cause. A crew trims in response to the conditions, so a setting that moves with the target may be reading the day rather than driving it.',
  )
  if (ranked.length > 1 && ranked[0].eta2 - ranked[1].eta2 < TIE_MARGIN) {
    caveats.push(
      `${ranked[0].key} and ${ranked[1].key} are within ${TIE_MARGIN} of each other — on this much data they cannot be separated, so neither is "the" dominant one.`,
    )
  }
  const confounded = ranked.filter(d => d.rWithConditions >= CONFOUND_R).map(d => d.key)
  if (confounded.length) {
    caveats.push(
      `${confounded.join(', ')} ${confounded.length === 1 ? 'moves' : 'move'} with the wind inside this slice, so ${confounded.length === 1 ? 'its' : 'their'} apparent effect may just be the breeze.`,
    )
  }
  if (ranked.length >= 6) {
    caveats.push(
      `${ranked.length} channels were tested and the best one reported; with that many, the top of the list is partly luck. Treat it as somewhere to look, not as a finding.`,
    )
  }
  const thin = ranked[0].bands.reduce((a, b) => Math.min(a, b.n), Infinity)
  if (thin < 10) {
    caveats.push(`The top channel's smallest band holds ${thin} phases — about ${Math.round((thin * 30) / 60)} minutes of sailing.`)
  }
  return { ranked, caveats }
}

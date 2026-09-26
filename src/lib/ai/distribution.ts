// src/lib/ai/distribution.ts
// ─────────────────────────────────────────────────────────────────────────────
// "A bell curve of the rate of turn of all tacks of the season."
//
// A histogram of the values, with a normal curve fitted to their mean and spread
// drawn over it — so the shape can be read against the bell it would be if the
// boat tacked the same way every time. The gap between the two is the point: a
// long tail to the slow side is a handful of bad tacks, and two humps are two
// different manoeuvres filed under one name.
//
// Pure. No Supabase, no model.
//
// The curve is FITTED, never assumed. It is drawn from the mean and standard
// deviation of the values themselves, and the summary carries the skew, so a
// distribution that is plainly not normal says so rather than being dressed as
// one by the curve laid over it.
// ─────────────────────────────────────────────────────────────────────────────

export interface Bin { lo: number; hi: number; centre: number; n: number }

export interface Distribution {
  bins: Bin[]
  binWidth: number
  n: number
  mean: number
  sd: number
  median: number
  /** Fisher's moment skew: 0 symmetric, positive = a tail to the high side. */
  skew: number
  min: number
  max: number
}

/** Sturges, bounded — enough bars to show a shape, never so many that each holds one. */
export function binCount(n: number, asked?: number): number {
  if (asked && asked >= 3) return Math.min(30, Math.round(asked))
  return Math.max(5, Math.min(20, Math.ceil(Math.log2(Math.max(2, n)) + 1)))
}

export function distribution(values: number[], bins?: number): Distribution | null {
  const v = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  // Three points is not a distribution; drawing one from them invents a shape.
  if (v.length < 5) return null

  const n = v.length
  const min = v[0], max = v[n - 1]
  const mean = v.reduce((s, x) => s + x, 0) / n
  const variance = v.reduce((s, x) => s + (x - mean) ** 2, 0) / n
  const sd = Math.sqrt(variance)
  const median = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2
  const skew = sd > 0 ? v.reduce((s, x) => s + ((x - mean) / sd) ** 3, 0) / n : 0

  // Every value identical: one bin, and no bell to draw over it.
  if (max === min) {
    return { bins: [{ lo: min, hi: min, centre: min, n }], binWidth: 0, n, mean, sd, median, skew, min, max }
  }

  const k = binCount(n, bins)
  const width = (max - min) / k
  const out: Bin[] = Array.from({ length: k }, (_, i) => ({
    lo: min + i * width, hi: min + (i + 1) * width, centre: min + (i + 0.5) * width, n: 0,
  }))
  for (const x of v) {
    // The last bin owns its upper edge, or the maximum falls outside every bin.
    const i = Math.min(k - 1, Math.floor((x - min) / width))
    out[i].n++
  }
  return { bins: out, binWidth: width, n, mean, sd, median, skew, min, max }
}

/**
 * The fitted normal, scaled to the histogram's counts so the two can be read on
 * one axis: density × n × binWidth is the count the bell would put in each bin.
 */
export function normalCurve(d: Distribution, steps = 48): { x: number; y: number }[] {
  if (!(d.sd > 0) || !(d.binWidth > 0)) return []
  const lo = Math.min(d.min, d.mean - 3 * d.sd)
  const hi = Math.max(d.max, d.mean + 3 * d.sd)
  const scale = (d.n * d.binWidth) / (d.sd * Math.sqrt(2 * Math.PI))
  return Array.from({ length: steps + 1 }, (_, i) => {
    const x = lo + ((hi - lo) * i) / steps
    return { x, y: scale * Math.exp(-((x - d.mean) ** 2) / (2 * d.sd * d.sd)) }
  })
}

/** How far from a bell it actually is, in words the answer can use. */
export function shapeNote(d: Distribution): string {
  const bits: string[] = []
  if (Math.abs(d.skew) >= 0.5) {
    bits.push(d.skew > 0
      ? 'the spread is skewed to the high side — a tail of slow ones rather than a bell'
      : 'the spread is skewed to the low side — a tail of slow ones rather than a bell')
  }
  // Mean and median far apart says the same thing from a different direction, and
  // is the one a reader checks by eye against the chart.
  if (d.sd > 0 && Math.abs(d.mean - d.median) > 0.25 * d.sd) {
    bits.push(`the mean (${d.mean.toFixed(2)}) and the median (${d.median.toFixed(2)}) are apart, so the average is being pulled by the tail`)
  }
  return bits.join('; ')
}

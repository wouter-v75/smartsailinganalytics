import { describe, it, expect } from 'vitest'
import { findSegments } from '../wind/segment'
import {
  estimateTwd, rollingTwd, scoreTwd, bestTwd, tackBalanceMinutes,
  asymmetryDeg, combineEstimates, GATE,
} from '../wind/estimate'
import { circularMean, circularR, angleDiff, circularSd, circularMeanWeighted } from '../wind/circular'
import { buildTrack, beat } from './support/syntheticTrack'

const segsFor = (...args: Parameters<typeof beat>) => findSegments(beat(...args))

describe('circular helpers', () => {
  it('averages across the 0/360 wrap', () => {
    expect(circularMean([350, 10])).toBeCloseTo(0, 6)
    expect(circularMean([359, 1, 0])).toBeCloseTo(0, 5)
    expect(circularMean([])).toBeNaN()
  })

  it('measures agreement', () => {
    expect(circularR([10, 10, 10])).toBeCloseTo(1, 6)
    expect(circularR([0, 180])).toBeCloseTo(0, 6)
    expect(circularR([])).toBe(0)
  })

  it('signs the difference correctly across the wrap', () => {
    expect(angleDiff(10, 350)).toBeCloseTo(20, 6)
    expect(angleDiff(350, 10)).toBeCloseTo(-20, 6)
    expect(angleDiff(180, 0)).toBeCloseTo(-180, 6)   // antipode lands on -180
  })

  it('turns agreement into a spread in degrees', () => {
    expect(circularSd([10, 10, 10])).toBeLessThan(1e-5)
    expect(circularSd([0, 10])).toBeGreaterThan(0)
    expect(circularSd([])).toBe(Infinity)
  })

  it('weights the mean', () => {
    expect(circularMeanWeighted([0, 90], [1, 0])).toBeCloseTo(0, 5)
    expect(circularMeanWeighted([0, 90], [1, 1])).toBeCloseTo(45, 5)
  })
})

describe('estimateTwd recovers a known wind', () => {
  it.each([0, 45, 137, 265, 359])('recovers TWD %i from a clean beat', (twd) => {
    // The prior is deliberately 30° wrong: the estimator must find the true
    // wind from the track, not echo what it was told.
    const est = estimateTwd(segsFor(twd, { legs: 6, legSeconds: 120 }), {
      priorTwd: twd + 30,
    })!
    expect(est).not.toBeNull()
    expect(Math.abs(angleDiff(est.twd, twd))).toBeLessThan(3)
    expect(est.resolvedBy).toBe('prior')
  })

  it('reports ground wind, never true wind', () => {
    // Until the L4 current solve exists, a COG-derived answer is ground-
    // referenced. Labelling it TWD without saying so is the §11 mislabelling.
    expect(estimateTwd(segsFor(265), { priorTwd: 270 })!.reference).toBe('ground')
  })

  it('recovers the tack angle it was given', () => {
    const est = estimateTwd(segsFor(270, { tackAngle: 42, legs: 6 }), { priorTwd: 260 })!
    expect(est.upwindTwa).toBeCloseTo(42, 0)
  })

  it('resolves the mirror from the score alone when the day has runs', () => {
    // Beats at ±42° and runs at ±150°: the mirror puts the runs at ±30°, inside
    // the no-go zone, so the no-go penalty settles it without a prior. This is
    // the common case and needs no help.
    const rows = buildTrack({
      twd: 200,
      legs: [
        { twa: -42, seconds: 200, sog: 5 }, { twa: 42, seconds: 200, sog: 5 },
        { twa: 150, seconds: 200, sog: 7.5 }, { twa: -150, seconds: 200, sog: 7.5 },
        { twa: -42, seconds: 200, sog: 5 },
      ],
    })
    const est = estimateTwd(findSegments(rows))!
    expect(est).not.toBeNull()
    expect(est.resolvedBy).toBe('score')
    expect(est.ambiguous).toBe(false)
    expect(Math.abs(angleDiff(est.twd, 200))).toBeLessThan(5)
  })

  it('falls back to boat speed when the angles really are mirror-symmetric', () => {
    // Close reaches at ±42° and broad reaches at ±138°: mirroring maps the set
    // onto itself, so the score ties exactly and nothing lands in the no-go
    // zone. Only "downwind is faster" can break it. The leg durations differ so
    // that ONLY the ±180° pair of axes ties — see the next test for why.
    const rows = buildTrack({
      twd: 200,
      legs: [
        { twa: -42, seconds: 200, sog: 5 }, { twa: 42, seconds: 200, sog: 5 },
        { twa: 138, seconds: 420, sog: 7.5 }, { twa: -138, seconds: 420, sog: 7.5 },
      ],
    })
    const est = estimateTwd(findSegments(rows))!
    expect(est.resolvedBy).toBe('speed')
    expect(Math.abs(angleDiff(est.twd, 200))).toBeLessThan(6)
  })

  it('refuses a FOUR-way symmetric track, not just a two-way one', () => {
    // Equal time at ±42° and ±138° is symmetric about 200°, 20°, 110° AND 290°
    // — reflecting about 110° maps the set to ±48°/±132°, which is an equally
    // plausible beat-and-run. The mirror test only compares θ and θ+180, so the
    // extra pair cannot be resolved by speed either. Refusing is correct.
    const rows = buildTrack({
      twd: 200,
      legs: [
        { twa: -42, seconds: 200, sog: 5 }, { twa: 42, seconds: 200, sog: 5 },
        { twa: 138, seconds: 200, sog: 7.5 }, { twa: -138, seconds: 200, sog: 7.5 },
      ],
    })
    const segs = findSegments(rows)
    expect(estimateTwd(segs)).toBeNull()
    expect(bestTwd(segs)!.ambiguous).toBe(true)
    // …and a prior rescues it, because it confines the search to one axis.
    const withPrior = estimateTwd(segs, { priorTwd: 210 })!
    expect(Math.abs(angleDiff(withPrior.twd, 200))).toBeLessThan(6)
  })

  it('refuses a beat-only track with no prior, because it IS ambiguous', () => {
    // Segments at ±42° from 270° sit at ±138° from 90° — a legal pair of broad
    // reaches, with no downwind group to compare speed against. Nothing in the
    // geometry can separate them, so answering would be a coin flip dressed as
    // a measurement.
    expect(estimateTwd(segsFor(270, { legs: 6 }))).toBeNull()
    const b = bestTwd(segsFor(270, { legs: 6 }))!
    expect(b.ambiguous).toBe(true)
    expect(b.resolvedBy).toBe('none')
  })

  it('handles a beat plus runs', () => {
    const rows = buildTrack({
      twd: 200,
      legs: [
        { twa: -42, seconds: 150 }, { twa: 42, seconds: 150 },
        { twa: -42, seconds: 150 }, { twa: 150, seconds: 180 },
        { twa: -150, seconds: 180 }, { twa: 42, seconds: 150 },
      ],
    })
    const est = estimateTwd(findSegments(rows), { priorTwd: 210 })!
    expect(Math.abs(angleDiff(est.twd, 200))).toBeLessThan(4)
    expect(est.downwindTwa).toBeGreaterThan(140)
  })
})

describe('the quality gate', () => {
  it('refuses a one-tack speed test — there is no opposite tack to bisect', () => {
    // This is the real failure mode: the windows that broke the naive rolling
    // fit on real data were speed-test runs held on a single tack.
    const rows = buildTrack({
      twd: 270, turnSeconds: 0,
      legs: [{ twa: 42, seconds: 600 }],
    })
    expect(estimateTwd(findSegments(rows))).toBeNull()
  })

  it('refuses when there is too little steady sailing', () => {
    expect(estimateTwd(segsFor(270, { legs: 2, legSeconds: 30 }))).toBeNull()
  })

  it('refuses an empty segment list', () => {
    expect(estimateTwd([])).toBeNull()
  })

  it('reports how balanced the tacks were when it does answer', () => {
    const est = estimateTwd(segsFor(270, { legs: 6, legSeconds: 120 }), { priorTwd: 270 })!
    expect(est.tackBalanceMin).toBeGreaterThanOrEqual(GATE.minTackBalanceMin)
    expect(est.segments).toBe(6)
  })

  it('can be forced past the gate for exploration', () => {
    const rows = buildTrack({ twd: 270, turnSeconds: 0, legs: [{ twa: 42, seconds: 600 }] })
    const forced = estimateTwd(findSegments(rows), {
      minTackBalanceMin: 0, minScore: -1, priorTwd: 270,
    })
    expect(forced).not.toBeNull()   // it answers, but the answer is not trustworthy
  })
})

describe('scoring internals', () => {
  const segs = segsFor(270, { legs: 6, legSeconds: 120 })

  it('scores the true wind above a wrong one', () => {
    expect(scoreTwd(segs, 270)).toBeGreaterThan(scoreTwd(segs, 240))
  })

  it('CANNOT separate a candidate from its 180° mirror — this is why priors exist', () => {
    // The discovery that reshaped this module: the symmetry score is blind to
    // the mirror, so the no-go penalty alone never resolves it.
    expect(scoreTwd(segs, 90)).toBeCloseTo(scoreTwd(segs, 270), 6)
  })

  it('returns -1 with nothing to score', () => {
    expect(scoreTwd([], 270)).toBe(-1)
  })

  it('a prior constrains the search, not just the final tie-break', () => {
    // A thin window can otherwise prefer an unrelated axis. On real data that
    // was the difference between a 119° outlier and a 10° worst case.
    const b = bestTwd(segs, { priorTwd: 275 })!
    expect(Math.abs(angleDiff(b.twd, 275))).toBeLessThanOrEqual(90)
    expect(b.resolvedBy).toBe('prior')
  })

  it('measures tack balance in minutes of the thinner tack', () => {
    expect(tackBalanceMinutes(segs, 270)).toBeGreaterThan(5)
    const oneTack = findSegments(buildTrack({
      twd: 270, turnSeconds: 0, legs: [{ twa: 42, seconds: 600 }],
    }))
    expect(tackBalanceMinutes(oneTack, 270)).toBe(0)
  })

  it('finds no asymmetry in a symmetric beat, and some in a skewed one', () => {
    expect(Math.abs(asymmetryDeg(segs, 270)!)).toBeLessThan(2)
    // A track whose two tacks sit at 35° and 50° implies the axis is 7.5° off.
    const skew = findSegments(buildTrack({
      twd: 270,
      legs: [{ twa: 35, seconds: 150 }, { twa: -50, seconds: 150 }, { twa: 35, seconds: 150 }],
    }))
    expect(asymmetryDeg(skew, 270)!).toBeCloseTo(-7.5, 0)
  })

  it('returns null asymmetry when a tack is missing', () => {
    const oneTack = findSegments(buildTrack({
      twd: 270, turnSeconds: 0, legs: [{ twa: 42, seconds: 600 }],
    }))
    expect(asymmetryDeg(oneTack, 270)).toBeNull()
  })

  it('bestTwd refines the coarse grid with the asymmetry correction', () => {
    const skew = findSegments(buildTrack({
      twd: 250,
      legs: [{ twa: 40, seconds: 200 }, { twa: -44, seconds: 200 }, { twa: 40, seconds: 200 }],
    }))
    const b = bestTwd(skew, { priorTwd: 250 })!
    expect(Math.abs(angleDiff(b.twd, 250))).toBeLessThan(4)
  })
})

describe('rollingTwd', () => {
  it('answers where the geometry supports it and explains itself where it does not', () => {
    // 20 min of beating, then 20 min of one-tack speed testing.
    const beating = buildTrack({
      twd: 270,
      legs: Array.from({ length: 10 }, (_, i) => ({ twa: i % 2 ? 42 : -42, seconds: 120 })),
    })
    const lastUtc = beating[beating.length - 1].utc
    const oneTack = buildTrack({
      twd: 270, turnSeconds: 0, startUtc: lastUtc + 60_000,
      legs: [{ twa: 42, seconds: 1800 }],
    })
    const pts = rollingTwd(findSegments([...beating, ...oneTack]), {
      stepSec: 600, priorTwd: 265,
    })

    const answered = pts.filter((p) => p.estimate)
    const refused = pts.filter((p) => !p.estimate)
    expect(answered.length).toBeGreaterThan(0)
    expect(refused.length).toBeGreaterThan(0)
    for (const a of answered) expect(Math.abs(angleDiff(a.estimate!.twd, 270))).toBeLessThan(6)
    expect(refused.some((r) => /one tack only/.test(r.reason || ''))).toBe(true)
  })

  it('returns nothing for no segments', () => {
    expect(rollingTwd([])).toEqual([])
  })
})

describe('combineEstimates', () => {
  it('pools boats and reports the spread as the uncertainty', () => {
    // Boats sailing together must agree; disagreement IS the error.
    const c = combineEstimates([{ twd: 265 }, { twd: 264 }, { twd: 266 }])!
    expect(c.twd).toBeCloseTo(265, 1)
    expect(c.sdDeg).toBeLessThan(2)
    expect(c.n).toBe(3)
  })

  it('weights by confidence and wraps correctly', () => {
    const c = combineEstimates([{ twd: 359, weight: 1 }, { twd: 1, weight: 1 }])!
    expect(c.twd).toBeCloseTo(0, 1)
  })

  it('flags wide disagreement with a large spread', () => {
    expect(combineEstimates([{ twd: 260 }, { twd: 20 }])!.sdDeg).toBeGreaterThan(40)
  })

  it('returns null with nothing to combine', () => {
    expect(combineEstimates([])).toBeNull()
  })
})

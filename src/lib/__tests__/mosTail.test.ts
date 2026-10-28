// The tail bar: what an rmse-optimal slope does to the strong wind.
//
// Found fitting Long Beach, then run against the three Mediterranean specs
// that had shipped seven months earlier, and it took three of their
// corrections off. The arithmetic is small; what it is worth testing is the
// judgement around it — that a shrinkage is diagnosed by its FIXED POINT and
// not by its slope, that a record with too little strong wind says so instead
// of passing or failing on four cases, and that the bars are read off the
// distribution rather than chosen.

import { describe, expect, it } from 'vitest'
import {
  tailStats, tailKeep, tailPasses, tailVerdict, tailJudgeable, pickTailBars,
  shrinkageFixedPoint, shrinkageAt,
  TAIL_WARN_KEEP, TAIL_MIN_ABOVE,
  type TailBars, type MosModelSpec,
} from '../mosFit'
import { specFor } from '../../components/weather/mos'

const BARS: TailBars = { threshold: 18, topBin: 24 }

/** n cases of observed `obs`, with raw and corrected forecasts. */
function series(cases: Array<[number, number, number]>) {
  return {
    obs: cases.map((c) => c[0]),
    raw: cases.map((c) => c[1]),
    cor: cases.map((c) => c[2]),
  }
}

describe('tailStats', () => {
  it('counts the strong-wind cases each side CALLED, not its rmse', () => {
    // Four cases over 18 kn. Raw calls all four, the correction two — and the
    // correction is CLOSER to the 25 kn case than raw was, which is exactly
    // the trade a shrinkage makes and exactly what rmse rewards.
    const s = series([
      [20, 19, 17], [22, 23, 18], [19, 18, 16], [25, 26, 19], [10, 9, 11],
    ])
    const t = tailStats(s.obs, s.raw, s.cor, { threshold: 18, topBin: 22 })
    expect(t.nAbove).toBe(4)
    expect(t.warnRaw).toBe(4)
    expect(t.warnCor).toBe(2)
    expect(t.topN).toBe(2)                       // 22 and 25
    expect(t.topRaw).toBeCloseTo(1, 10)          // (+1, +1)/2
    expect(t.topCor).toBeCloseTo(-5, 10)         // (-4, -6)/2
  })

  it('is empty rather than NaN-ridden when nothing reaches the bars', () => {
    const t = tailStats([5, 6], [5, 6], [7, 8], BARS)
    expect(t.nAbove).toBe(0)
    expect(t.warnRaw).toBe(0)
    expect(Number.isNaN(t.topRaw)).toBe(true)
    expect(Number.isNaN(tailKeep(t))).toBe(true)
  })

  it('counts a case at the threshold exactly as above it', () => {
    const t = tailStats([18], [18], [17.999], BARS)
    expect(t.nAbove).toBe(1)
    expect(t.warnRaw).toBe(1)
    expect(t.warnCor).toBe(0)
  })
})

describe('the bar', () => {
  const many = (n: number, obs: number, raw: number, cor: number) =>
    series(Array.from({ length: n }, () => [obs, raw, cor] as [number, number, number]))

  it('fails a form that loses the strong-wind hits', () => {
    const s = many(40, 20, 20, 16)
    const t = tailStats(s.obs, s.raw, s.cor, BARS)
    expect(tailKeep(t)).toBe(0)
    expect(tailPasses(t, BARS)).toBe(false)
    expect(tailVerdict(t, BARS)).toContain('FAILS')
    expect(tailVerdict(t, BARS)).toContain('0/40')
  })

  it('passes a form that keeps them', () => {
    const s = many(40, 20, 20, 19)
    const t = tailStats(s.obs, s.raw, s.cor, BARS)
    expect(tailKeep(t)).toBe(1)
    expect(tailPasses(t, BARS)).toBe(true)
    expect(tailVerdict(t, BARS)).toContain('PASSES')
  })

  it('refuses to judge a record with too little strong wind, and says so', () => {
    // The Sorrento case. Nine cases over the threshold cannot refuse a form,
    // and a bar measured on nine cases pretending otherwise is worse than an
    // honest abstention — so it passes, and the verdict names the reason
    // rather than printing PASSES.
    const s = many(TAIL_MIN_ABOVE - 1, 20, 20, 14)
    const t = tailStats(s.obs, s.raw, s.cor, BARS)
    expect(tailJudgeable(t)).toBe(false)
    expect(tailPasses(t, BARS)).toBe(true)
    expect(tailVerdict(t, BARS)).toContain('too few cases')
    expect(tailVerdict(t, BARS)).not.toContain('PASSES')
  })

  it('abstains too when raw never called the strong wind either', () => {
    // Also Sorrento, where no model forecast 16 kn at all: there is no
    // warning rate to preserve, so there is nothing to refuse a form on.
    const s = many(40, 20, 12, 11)
    const t = tailStats(s.obs, s.raw, s.cor, BARS)
    expect(t.nAbove).toBe(40)
    expect(t.warnRaw).toBe(0)
    expect(tailJudgeable(t)).toBe(false)
    expect(tailVerdict(t, BARS)).toContain('none of which raw caught')
  })

  it('fails a form that wrecks the top bin even while keeping the hits', () => {
    // Over-forecasting the top is a failure too, in the other direction: the
    // hits are all there and the mean error has moved 4 kn.
    const s = many(40, 26, 26, 21.9)
    const t = tailStats(s.obs, s.raw, s.cor, BARS)
    expect(tailKeep(t)).toBe(1)
    expect(t.topN).toBe(40)
    expect(tailPasses(t, BARS)).toBe(false)
  })

  it('honours a caller\'s own thresholds', () => {
    const s = many(40, 20, 20, 18.5)       // keeps 100 % of hits, 1.5 kn low
    const t = tailStats(s.obs, s.raw, s.cor, BARS)
    expect(tailPasses(t, BARS, { topSlack: 1 })).toBe(true)   // topBin 24, no cases
    const tight: TailBars = { threshold: 18, topBin: 20 }
    const t2 = tailStats(s.obs, s.raw, s.cor, tight)
    expect(tailPasses(t2, tight, { topSlack: 1 })).toBe(false)
    expect(tailPasses(t2, tight, { topSlack: 3 })).toBe(true)
  })

  it('puts the 90 % default where nothing lands near it', () => {
    // The constrained forms at Long Beach came in at 0.97-1.29 of raw's
    // warning count and the least-squares forms at 0.00-0.64, so the bar is
    // not tuned — it separates two clusters with a wide gap.
    expect(TAIL_WARN_KEEP).toBe(0.9)
    expect(TAIL_WARN_KEEP).toBeGreaterThan(0.64)
    expect(TAIL_WARN_KEEP).toBeLessThan(0.97)
  })
})

describe('pickTailBars reads the levels off the record', () => {
  const obs = (counts: Record<number, number>) =>
    Object.entries(counts).flatMap(([v, n]) => Array.from({ length: n }, () => Number(v)))

  it('takes the highest step the record can still support', () => {
    // 60 cases at 21 kn, 12 at 25: the warning rate goes at 20 (72 cases) and
    // the top bin at 24 (12), which is the highest step with ten.
    const bars = pickTailBars(obs({ 8: 400, 21: 60, 25: 12 }))!
    expect(bars.threshold).toBe(20)
    expect(bars.topBin).toBe(24)
  })

  it('collapses the two onto one level when the tail is thin', () => {
    // Sorrento: 35 bins over 16 kn and nine over 18. Both statements then
    // describe the same cases, which is still worth having — one counts hits,
    // the other averages the error.
    const bars = pickTailBars(obs({ 9: 400, 17: 26, 18.5: 9 }))!
    expect(bars.threshold).toBe(16)
    expect(bars.topBin).toBe(16)
  })

  it('never puts the top bin below the threshold', () => {
    const bars = pickTailBars(obs({ 9: 400, 13: 30 }))!
    expect(bars.topBin).toBeGreaterThanOrEqual(bars.threshold)
  })

  it('is null for a record with no strong wind at all, rather than a guess', () => {
    expect(pickTailBars(obs({ 6: 500 }))).toBeNull()
    expect(pickTailBars([])).toBeNull()
  })
})

describe('the fixed point, not the slope, is the diagnostic', () => {
  // The part worth not re-deriving. a < 1 rotates the forecast about
  // x* = b/(1-a), so the sign of the change at a threshold T is the sign of
  // T - x*. These two slopes agree to two decimal places and do opposite
  // things where it matters.
  const sorrentoIcon: MosModelSpec = { type: 'sector', a: 0.761, b: 4.879 }
  const portoEcmwf: MosModelSpec = { type: 'sector', a: 0.702, b: 2.734 }

  it('lifts the whole observed range when the fixed point is above it', () => {
    expect(shrinkageFixedPoint(sorrentoIcon)).toBeCloseTo(20.4, 1)
    expect(shrinkageAt(sorrentoIcon, 16)).toBeGreaterThan(0)
    expect(shrinkageAt(sorrentoIcon, 16)).toBeCloseTo(1.055, 2)
  })

  it('cuts hard at the strong end when the fixed point is below it', () => {
    expect(shrinkageFixedPoint(portoEcmwf)).toBeCloseTo(9.2, 1)
    expect(shrinkageAt(portoEcmwf, 20)).toBeCloseTo(-3.226, 2)
  })

  it('is null for a pure offset, which moves everything equally', () => {
    expect(shrinkageFixedPoint({ type: 'bias_scale', a: 1, b: 2 })).toBeNull()
    expect(shrinkageAt({ type: 'bias_scale', a: 1, b: 2 }, 30)).toBeCloseTo(2, 10)
  })

  it('is null, and a no-op, for raw', () => {
    expect(shrinkageFixedPoint({ type: 'raw' })).toBeNull()
    expect(shrinkageAt({ type: 'raw' }, 30)).toBe(0)
  })
})

describe('what the shipped specs now do at their venues', () => {
  // The audit's result, pinned. A spec that reappears with a slope whose fixed
  // point sits below the venue's strong wind is the thing this whole section
  // exists to catch, and a test is the only place that catch survives.
  const CASES: Array<[string, string, number, 'lifts' | 'raw']> = [
    // venue, model, the venue's own top-bin level, what the spec must do there
    ['porto-cervo', 'meteofrance_arpege_europe', 22, 'lifts'],
    ['porto-cervo', 'icon_eu', 22, 'lifts'],
    ['porto-cervo', 'ecmwf_ifs025', 22, 'raw'],      // was sector a 0.70, -3.2 kn at 22
    ['st-tropez', 'icon_eu', 20, 'lifts'],
    ['st-tropez', 'ecmwf_ifs025', 20, 'lifts'],
    ['st-tropez', 'meteofrance_arome_france_hd', 20, 'raw'],
  ]

  for (const [venue, model, topBin, expected] of CASES) {
    it(`${venue} ${model} ${expected === 'raw' ? 'is raw' : 'does not cut the top'}`, () => {
      const m = specFor(venue).models[model]
      expect(m, `${venue}/${model} missing from the spec`).toBeTruthy()
      if (expected === 'raw') {
        expect(m.type).toBe('raw')
        return
      }
      // Not "the slope is near 1" — that is the wrong test, as Sorrento's
      // icon_eu shows. What must hold is that the slope and bias together do
      // not take wind OFF the venue's strong end.
      expect(shrinkageAt(m, topBin)).toBeGreaterThan(-1)
    })
  }

  it('records the tail measurement beside every decision', () => {
    // So the next person does not have to re-run the fit to find out whether
    // the tail was looked at. Sorrento's two surviving slopes are the
    // abstention case and must carry it too.
    for (const venue of ['sorrento', 'porto-cervo', 'st-tropez']) {
      const spec = specFor(venue)
      expect(spec.tail_bars?.threshold_kn, venue).toBeGreaterThan(0)
      expect(spec.tail_bars?.warn_keep, venue).toBe(TAIL_WARN_KEEP)
      for (const [name, m] of Object.entries<Record<string, any>>(spec.models)) {
        if (m.note === 'insufficient regattas for CV') continue
        expect(m.tail, `${venue}/${name}`).toBeTruthy()
        expect(m.tail.threshold_kn, `${venue}/${name}`).toBe(spec.tail_bars.threshold_kn)
      }
    }
  })

  it('and names the masthead the truth was really measured at', () => {
    // The files say 30.0, which is extract_obs.py's default and was never a
    // measurement: Northstar 72's masthead is 32 m and Northstar 76's 35 m.
    expect(specFor('sorrento').truth_masthead_m).toEqual([32])
    expect(specFor('porto-cervo').truth_masthead_m).toEqual([32, 35])
    expect(specFor('st-tropez').truth_masthead_m).toEqual([32, 35])
  })
})

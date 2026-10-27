// The fit has one failure mode worse than being wrong: being right about a
// form the app then applies differently. A spec is a handful of numbers, and
// nothing about the JSON says which arithmetic produced it — so if the fitter
// and applyMOS disagree by a term, the stored coefficients silently do not
// reproduce the fit that justified them, and the CV RMSE in the spec is a
// number about a function nobody runs.
//
// The first block below is therefore the load-bearing one: it drives the app's
// own applyMOS and this module's predictor with the same coefficients and
// asserts they agree to floating point.

import { describe, expect, it } from 'vitest'
import {
  predictSpecModel, assignSector, fitForm, solveOls, score, effectiveN, lag1,
  yearBlocks, withBuffer, dieboldMariano, blockBootstrapCI, crossValidateForms,
  selectForm, paramCount, piRmse, skill, persistenceRmse,
  type Pair, type Band, type MosModelSpec,
} from '../mosFit'
import { applyMOS } from '../../components/weather/mos'

const BANDS: Band[] = [['N-NE', 0, 70], ['SE-S', 80, 200], ['SW-W', 200, 270], ['NW', 270, 360]]

describe('predictSpecModel is applyMOS, term for term', () => {
  const cases: MosModelSpec[] = [
    { type: 'raw' },
    { type: 'bias_scale', a: 0.87, b: 2.59 },
    { type: 'diurnal', a: 0.52, b: 6.24, c0: -0.61, c1: -2.43, c2: -0.0063 },
    { type: 'diurnal', a: 1.04, b: 1.1, c0: 0, c1: 0.8, c2: -0.3 },
    { type: 'sector', a: 1.05, b: 1.84, delta: { 'N-NE': 0, 'SE-S': -1.08, 'SW-W': -0.98, NW: 1.07 }, global: 0.078 },
  ]

  it('agrees for every type, across speed, direction and hour', () => {
    const spec = { bands: BANDS }
    for (const m of cases) {
      for (const ws of [0, 3.2, 11.7, 24, 41.5]) {
        for (const twd of [5, 75, 140, 235, 300, 359]) {
          for (const hour of [0, 6, 11.5, 18, 23]) {
            const mine = predictSpecModel(m, ws, twd, hour, BANDS)
            const theirs = applyMOS({ ...spec, models: { X: m } }, 'X', ws, twd, hour)
            expect(theirs, `${m.type} ws=${ws} twd=${twd} h=${hour}`).not.toBeNull()
            expect(mine).toBeCloseTo(theirs!.ws, 12)
          }
        }
      }
    }
  })

  it('agrees when direction falls in NO band, which is the `global` path', () => {
    // 75 degrees sits in the gap between N-NE (0-70) and SE-S (80-200).
    const m = cases[4]
    expect(assignSector(75, BANDS)).toBe('other')
    const mine = predictSpecModel(m, 10, 75, 12, BANDS)
    const theirs = applyMOS({ bands: BANDS, models: { X: m } }, 'X', 10, 75, 12)
    expect(mine).toBeCloseTo(theirs!.ws, 12)
    // and that path really is `global`, not a silent zero
    expect(mine).toBeCloseTo(1.05 * 10 + 1.84 + 0.078, 10)
  })

  it('agrees when direction or hour is missing', () => {
    for (const m of cases) {
      const a = predictSpecModel(m, 12, null, null, BANDS)
      const b = applyMOS({ bands: BANDS, models: { X: m } }, 'X', 12, null, null)
      expect(a).toBeCloseTo(b!.ws, 12)
    }
  })
})

describe('assignSector matches the spec convention', () => {
  it('handles a band that wraps through north', () => {
    const wrap: Band[] = [['NW-N', 300, 40]]
    expect(assignSector(310, wrap)).toBe('NW-N')
    expect(assignSector(20, wrap)).toBe('NW-N')
    expect(assignSector(180, wrap)).toBe('other')
  })

  it('normalises out-of-range and negative directions', () => {
    expect(assignSector(365, BANDS)).toBe(assignSector(5, BANDS))
    expect(assignSector(-20, BANDS)).toBe(assignSector(340, BANDS))
  })
})

describe('solveOls', () => {
  it('recovers known coefficients exactly on noiseless data', () => {
    const X = [[1, 1], [2, 1], [3, 1], [7, 1]]
    const y = X.map(([x]) => 2.5 * x - 1.25)
    const b = solveOls(X, y)!
    expect(b[0]).toBeCloseTo(2.5, 8)
    expect(b[1]).toBeCloseTo(-1.25, 8)
  })

  it('returns null rather than nonsense on a duplicated column', () => {
    // b and c0 are the same column — the singularity this module exists to
    // avoid by pinning c0 to zero.
    const X = [[1, 1, 1], [2, 1, 1], [3, 1, 1], [4, 1, 1]]
    const y = [1, 2, 3, 4]
    expect(solveOls(X, y, 0)).toBeNull()
  })
})

describe('fitForm', () => {
  // Direction must be INDEPENDENT of speed here. A first attempt used
  // twd = (i*37)%360 beside model = 5+(i%23); both are periodic in i, so the
  // sector dummies were collinear with the model column and the offsets came
  // back 3 % short. That was the fixture's fault, not the fitter's.
  let dseed = 99
  const pseudo = () => { dseed = (dseed * 1103515245 + 12345) & 0x7fffffff; return (dseed / 0x7fffffff) * 360 }
  const mk = (n: number, f: (i: number, twd: number) => Partial<Pair>): Pair[] => {
    dseed = 99
    return Array.from({ length: n }, (_, i) => {
      const twd = pseudo()
      return {
        t: Date.UTC(2024, 0, 1) + i * 3600_000,
        model: 5 + (i % 23),
        obs: 0,
        twd,
        hour: i % 24,
        ...f(i, twd),
      }
    }) as Pair[]
  }

  it('recovers a bias_scale relationship', () => {
    const rows = mk(500, (i) => ({ obs: 1.2 * (5 + (i % 23)) + 0.8 }))
    const m = fitForm('bias_scale', rows, BANDS)!
    expect(m.a).toBeCloseTo(1.2, 6)
    expect(m.b).toBeCloseTo(0.8, 6)
  })

  it('recovers a diurnal harmonic and pins c0 to zero', () => {
    const rows = mk(2000, (i) => {
      const h = i % 24
      const ang = (2 * Math.PI * h) / 24
      return { obs: 1.1 * (5 + (i % 23)) + 0.5 + 1.7 * Math.sin(ang) - 0.9 * Math.cos(ang) }
    })
    const m = fitForm('diurnal', rows, BANDS)!
    expect(m.a).toBeCloseTo(1.1, 5)
    expect(m.b).toBeCloseTo(0.5, 5)
    expect(m.c1).toBeCloseTo(1.7, 5)
    expect(m.c2).toBeCloseTo(-0.9, 5)
    expect(m.c0).toBe(0)
  })

  it('recovers sector offsets, with the reference band at zero', () => {
    const off: Record<string, number> = { 'N-NE': 0.0, 'SE-S': -1.5, 'SW-W': 2.0, NW: 0.5 }
    const rows = mk(8000, (i, twd) => {
      const s = assignSector(twd, BANDS)
      return { obs: 1.0 * (5 + (i % 23)) + 1.0 + (off[s] ?? 0) }
    })
    const m = fitForm('sector', rows, BANDS)!
    const d = m.delta!
    // Offsets are identified only up to a shift absorbed by b, so compare
    // DIFFERENCES, which is what the correction actually applies.
    expect(d['SW-W'] - d['SE-S']).toBeCloseTo(3.5, 4)
    expect(d.NW - d['SE-S']).toBeCloseTo(2.0, 4)
    expect(Math.min(...Object.values(d))).toBeCloseTo(0, 10)
  })

  it('fits the no-band "other" level separately, not as the reference band', () => {
    // The bands below leave a 10-degree gap at 70-80, so ~3% of directions
    // land in no band. applyMOS gives those `global`; an earlier version of
    // the fitter folded them into the reference band and every recovered
    // offset came back ~3% short.
    const off: Record<string, number> = { 'N-NE': 0, 'SE-S': -1.5, 'SW-W': 2.0, NW: 0.5, other: 4.0 }
    const rows = mk(20000, (i, twd) => {
      const s = assignSector(twd, BANDS)
      return { obs: 1.0 * (5 + (i % 23)) + 1.0 + (off[s] ?? 0) }
    })
    const m = fitForm('sector', rows, BANDS)!
    // 'other' carries a deliberately large +4.0; it must land in `global`,
    // separated from the bands by the right amount.
    expect(m.global! - m.delta!['SE-S']).toBeCloseTo(5.5, 3)
    expect(m.delta!['SW-W'] - m.delta!['SE-S']).toBeCloseTo(3.5, 3)
  })

  it('REFUSES a sector fit when a declared band is unpopulated', () => {
    // The whole point: an empty band's offset would otherwise be whatever the
    // ridge term says, and the spec would carry a confident invented number.
    const rows = mk(500, () => ({ obs: 10, twd: 10 }))   // all in N-NE
    expect(fitForm('sector', rows, BANDS)).toBeNull()
  })

  it('refuses a sector fit when no row has a direction at all', () => {
    const rows = mk(500, () => ({ obs: 10, twd: null }))
    expect(fitForm('sector', rows, BANDS)).toBeNull()
  })

  it('returns the raw form without needing data', () => {
    expect(fitForm('raw', [], BANDS)).toEqual({ type: 'raw' })
  })
})

describe('paramCount respects the four-to-six ceiling', () => {
  it('counts c0 as pinned, not free', () => {
    expect(paramCount({ type: 'raw' }, BANDS)).toBe(0)
    expect(paramCount({ type: 'bias_scale' }, BANDS)).toBe(2)
    expect(paramCount({ type: 'diurnal' }, BANDS)).toBe(4)
    expect(paramCount({ type: 'sector' }, BANDS)).toBe(5)   // a, b, 3 free offsets
  })

  it('keeps a four-band sector inside the ceiling the report sets', () => {
    expect(paramCount({ type: 'sector' }, BANDS)).toBeLessThanOrEqual(6)
  })
})

describe('effective sample size', () => {
  it('reproduces the measured Gullholmen figure', () => {
    // 8,753 hourly rows measured 26 Oct 2026. The reported r1 of 0.883 is
    // rounded; the unrounded value (~0.8834) is what gave 542 at the time, and
    // 0.883 exactly gives 543.9 — worth pinning both so neither number looks
    // like a discrepancy later.
    expect(effectiveN(8753, 0.883)).toBeCloseTo(543.87, 1)
    expect(effectiveN(8753, 0.8834)).toBeCloseTo(542, 0)
    // Either way it is about 6 % of the nominal count.
    expect(effectiveN(8753, 0.883) / 8753).toBeLessThan(0.07)
  })

  it('equals n for white noise and collapses as r1 approaches 1', () => {
    expect(effectiveN(1000, 0)).toBeCloseTo(1000, 6)
    expect(effectiveN(1000, 0.99)).toBeLessThan(10)
  })

  it('never exceeds n, even for a negative autocorrelation', () => {
    expect(effectiveN(1000, -0.5)).toBeLessThanOrEqual(1000)
  })

  it('lag1 measures what it says on a known AR(1)', () => {
    let x = 0
    const s: number[] = []
    let seed = 7
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5 }
    for (let i = 0; i < 20000; i++) { x = 0.8 * x + rnd(); s.push(x) }
    expect(lag1(s)).toBeGreaterThan(0.7)
    expect(lag1(s)).toBeLessThan(0.9)
  })
})

describe('score', () => {
  it('reports bias, mae and rmse with their signs and units', () => {
    const s = score([11, 9, 10], [10, 10, 10])
    expect(s.bias).toBeCloseTo(0, 10)
    expect(s.mae).toBeCloseTo(2 / 3, 10)
    expect(s.rmse).toBeCloseTo(Math.sqrt(2 / 3), 10)
  })

  it('varRatio below 1 reveals a flattened forecast', () => {
    // The double-penalty mechanism the report flags: OLS shrinks variance.
    const obs = [5, 10, 15, 20, 25]
    const flat = [13, 14, 15, 16, 17]
    expect(score(flat, obs).varRatio).toBeLessThan(1)
    expect(score(obs, obs).varRatio).toBeCloseTo(1, 10)
  })

  it('is empty-safe', () => {
    const s = score([], [])
    expect(s.n).toBe(0)
    expect(Number.isNaN(s.rmse)).toBe(true)
  })
})

describe('piRmse and skill', () => {
  it('piRmse is positive when the correction helps', () => {
    expect(piRmse(2.7, 3.0)).toBeCloseTo(10, 10)
    expect(piRmse(3.3, 3.0)).toBeCloseTo(-10, 10)
  })
  it('skill is 0 against itself and 1 against a perfect reference gap', () => {
    expect(skill(3, 3)).toBeCloseTo(0, 10)
    expect(skill(0, 3)).toBeCloseTo(1, 10)
  })
})

describe('persistenceRmse', () => {
  const row = (hour: number, obs: number): Pair =>
    ({ t: Date.UTC(2024, 0, 1) + hour * 3600_000, model: 0, obs, twd: null, hour: hour % 24 })

  it('scores the previous hour as the forecast', () => {
    const rows = [row(0, 10), row(1, 12), row(2, 12)]
    // errors: 10-12 = -2, 12-12 = 0
    expect(persistenceRmse(rows)).toBeCloseTo(Math.sqrt(2), 10)
  })

  it('does NOT score across a gap', () => {
    // A gap must not be counted as persistence, or a station outage flatters
    // or punishes the benchmark arbitrarily.
    const rows = [row(0, 10), row(50, 30)]
    expect(Number.isNaN(persistenceRmse(rows))).toBe(true)
  })
})

describe('yearBlocks', () => {
  const rowsIn = (year: number, n: number): Pair[] =>
    Array.from({ length: n }, (_, i) => ({
      t: Date.UTC(year, 0, 1) + i * 3600_000, model: 1, obs: 1, twd: null, hour: i % 24,
    }))

  it('makes one block per year', () => {
    const rows = [...rowsIn(2023, 3000), ...rowsIn(2024, 3000), ...rowsIn(2025, 3000)]
    expect(yearBlocks(rows).length).toBe(3)
  })

  it('merges a short stub forward, so Dec 2022 joins 2023', () => {
    // The real archive starts 1 Dec 2022 — about 740 hours, which is not a
    // year and must not be scored as one.
    const rows = [...rowsIn(2022, 740), ...rowsIn(2023, 8700), ...rowsIn(2024, 8700)]
    const b = yearBlocks(rows, 2000)
    expect(b.length).toBe(2)
    expect(b[0].length).toBe(740 + 8700)
  })

  it('merges a short trailing stub backwards rather than dropping it', () => {
    const rows = [...rowsIn(2024, 8700), ...rowsIn(2025, 500)]
    const b = yearBlocks(rows, 2000)
    expect(b.length).toBe(1)
    expect(b[0].length).toBe(9200)
  })

  it('loses no rows', () => {
    const rows = [...rowsIn(2022, 740), ...rowsIn(2023, 8700), ...rowsIn(2024, 8700), ...rowsIn(2025, 300)]
    expect(yearBlocks(rows, 2000).flat().length).toBe(rows.length)
  })
})

describe('withBuffer', () => {
  const at = (h: number): Pair => ({ t: Date.UTC(2024, 0, 1) + h * 3600_000, model: 1, obs: 1, twd: null, hour: h % 24 })

  it('removes training rows within the buffer of any test row', () => {
    const train = [at(0), at(10), at(120), at(150 + 47), at(150 + 49), at(400)]
    const test = [at(150)]
    const kept = withBuffer(train, test, 48 * 3600_000)
    // 120 is 30 h before, and 197 is 47 h after — both inside 48 h, so both go.
    // 199 is 49 h after, so it stays. This is the boundary worth pinning.
    expect(kept.map((r) => r.t)).toEqual([at(0).t, at(10).t, at(199).t, at(400).t])
  })

  it('is exact at the buffer boundary', () => {
    // 50 h from a 48 h buffer is kept — an earlier version of this test
    // assumed otherwise and the code was right.
    expect(withBuffer([at(100), at(200)], [at(150)], 48 * 3600_000).length).toBe(2)
    expect(withBuffer([at(102), at(198)], [at(150)], 48 * 3600_000).length).toBe(0)
  })

  it('keeps everything when there is no test set', () => {
    const train = [at(0), at(1)]
    expect(withBuffer(train, [], 48 * 3600_000).length).toBe(2)
  })

  it('a zero buffer still removes the exact-coincident row', () => {
    expect(withBuffer([at(5)], [at(5)], 0).length).toBe(0)
  })
})

describe('dieboldMariano', () => {
  it('finds no difference when the two losses are identical', () => {
    const d = new Array(500).fill(0)
    expect(dieboldMariano(d, 10).meanDiff).toBe(0)
  })

  it('widens the standard error for autocorrelated differentials', () => {
    // The whole reason the HAC correction is here: the same mean difference
    // must look less significant once the series is dependent.
    let x = 0; let seed = 11
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5 }
    const d: number[] = []
    for (let i = 0; i < 5000; i++) { x = 0.9 * x + rnd(); d.push(x + 0.05) }
    const naive = dieboldMariano(d, 0)
    const hac = dieboldMariano(d, 48)
    expect(hac.se).toBeGreaterThan(naive.se)
    expect(Math.abs(hac.stat)).toBeLessThan(Math.abs(naive.stat))
  })

  it('refuses a sample too small to say anything', () => {
    expect(Number.isNaN(dieboldMariano([1, 2, 3], 2).stat)).toBe(true)
  })
})

describe('blockBootstrapCI', () => {
  it('brackets the mean and is reproducible', () => {
    const d = Array.from({ length: 2000 }, (_, i) => Math.sin(i / 7) + 0.3)
    const a = blockBootstrapCI(d, 24, 500)
    const b = blockBootstrapCI(d, 24, 500)
    expect(a).toEqual(b)                       // fixed seed
    expect(a.lo).toBeLessThan(0.3)
    expect(a.hi).toBeGreaterThan(0.3)
  })

  it('declines when the series is too short for the block length', () => {
    expect(Number.isNaN(blockBootstrapCI([1, 2, 3], 24).lo)).toBe(true)
  })
})

describe('crossValidateForms and selectForm', () => {
  // A synthetic venue: a genuine 1.15 slope and +0.6 offset, a real diurnal
  // signal, no sector signal, plus noise.
  const synth = (n: number, withDiurnal: boolean): Pair[] => {
    let seed = 3
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5 }
    return Array.from({ length: n }, (_, i) => {
      const t = Date.UTC(2023, 0, 1) + i * 3600_000
      const hour = new Date(t).getUTCHours()
      const model = 4 + 12 * Math.abs(Math.sin(i / 51)) + rnd()
      const ang = (2 * Math.PI * hour) / 24
      const obs = 1.15 * model + 0.6 + (withDiurnal ? 1.4 * Math.sin(ang) : 0) + rnd() * 2
      return { t, model, obs, twd: (i * 53) % 360, hour }
    })
  }

  it('prefers bias_scale over raw when there is a real slope', () => {
    const { results } = crossValidateForms(synth(26000, false), BANDS)
    const raw = results.find((r) => r.type === 'raw')!
    const bs = results.find((r) => r.type === 'bias_scale')!
    expect(bs.cv.rmse).toBeLessThan(raw.cv.rmse)
  })

  it('prefers diurnal when a diurnal signal is present', () => {
    const { results } = crossValidateForms(synth(26000, true), BANDS)
    const bs = results.find((r) => r.type === 'bias_scale')!
    const di = results.find((r) => r.type === 'diurnal')!
    expect(di.cv.rmse).toBeLessThan(bs.cv.rmse)
    expect(selectForm(results)!.type).toBe('diurnal')
  })

  it('does NOT prefer sector when there is no sector signal', () => {
    // Five parameters chasing nothing is exactly what the one-standard-error
    // rule is for.
    const { results } = crossValidateForms(synth(26000, false), BANDS)
    expect(selectForm(results)!.type).toBe('bias_scale')
  })

  it('uses leave-one-year-out blocks, so the count follows the calendar', () => {
    const { blocks } = crossValidateForms(synth(26000, false), BANDS)
    // 26,000 hours from 1 Jan 2023 spans 2023, 2024 and into 2025.
    expect(blocks).toBeGreaterThanOrEqual(3)
  })

  it('selectForm honours the parameter ceiling', () => {
    const { results } = crossValidateForms(synth(26000, true), BANDS)
    expect(selectForm(results, 2)!.params).toBeLessThanOrEqual(2)
  })

  it('selectForm returns null when every form was refused', () => {
    const refused: FormResultLike[] = [{ type: 'sector', params: 5, refused: 'no bands', cv: score([], []), spec: { type: 'sector' } }]
    expect(selectForm(refused as never)).toBeNull()
  })

  it('reports the refusal rather than silently dropping the form', () => {
    // All directions in one band -> sector must come back refused, with a reason.
    const rows = synth(26000, false).map((r) => ({ ...r, twd: 10 }))
    const { results } = crossValidateForms(rows, BANDS)
    const sec = results.find((r) => r.type === 'sector')!
    expect(sec.refused).toBeTruthy()
  })
})

type FormResultLike = { type: string; params: number; refused?: string; cv: ReturnType<typeof score>; spec: unknown }

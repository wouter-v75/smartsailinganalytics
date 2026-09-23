import { describe, it, expect } from 'vitest'
import { rankDrivers, quantileBands, etaSquared, pearson, CONFOUND_R, TIE_MARGIN } from '../drivers'

const row = (values: Record<string, number>, target: number) => ({ values, target })

describe('quantileBands', () => {
  it('splits by count, not by width, so one outlier is not a band', () => {
    const pts = [...Array.from({ length: 29 }, (_, i) => ({ x: 20 + i * 0.01, y: 1 })), { x: 90, y: 1 }]
    const bands = quantileBands(pts, 3, 5)
    expect(bands).toHaveLength(3)
    expect(bands.every(b => b.n >= 5)).toBe(true)
  })

  it('gives up rather than reporting bands nobody should read', () => {
    expect(quantileBands([{ x: 1, y: 1 }, { x: 2, y: 2 }], 3, 5)).toEqual([])
  })
})

describe('etaSquared', () => {
  it('is 0 when the bands say nothing', () => {
    const bands = [{ lo: 0, hi: 1, n: 10, mean: 5 }, { lo: 1, hi: 2, n: 10, mean: 5 }]
    expect(etaSquared(bands, Array.from({ length: 20 }, (_, i) => (i % 2 ? 4 : 6)))).toBeCloseTo(0, 6)
  })

  it('is 1 when the bands say everything', () => {
    const bands = [{ lo: 0, hi: 1, n: 2, mean: 4 }, { lo: 1, hi: 2, n: 2, mean: 6 }]
    expect(etaSquared(bands, [4, 4, 6, 6])).toBeCloseTo(1, 6)
  })
})

describe('rankDrivers', () => {
  // heel has an OPTIMUM at 22°: slow below it and slow above it. A correlation
  // coefficient reports ~0 for that shape, which is exactly why the ranking is
  // banded — a linear statistic would put the most important thing on the boat last.
  // SYMMETRIC about the peak on purpose: an asymmetric hump leaves real linear
  // correlation behind and muddies the very thing this is demonstrating.
  const humped = Array.from({ length: 60 }, (_, i) => {
    const heel = 16 + (i % 13)                      // 16 … 28, peak in the middle
    const vmg = 100 - Math.abs(heel - 22) * 0.8     // peak at 22
    return row({ heel, trim: (i * 7) % 11, tws: 13 }, vmg)
  })

  it('finds a channel with an optimum that a correlation would miss', () => {
    const { ranked } = rankDrivers({ rows: humped, candidates: ['heel', 'trim'] })
    expect(ranked[0].key).toBe('heel')
    expect(ranked[0].eta2).toBeGreaterThan(0.3)
    // The claim, stated in comparable units: the banded view explains several
    // times more of the variance than the straight line does.
    expect(ranked[0].eta2).toBeGreaterThan(ranked[0].r ** 2 * 3)
  })

  it('says where the optimum is, not just that one exists', () => {
    const { ranked } = rankDrivers({ rows: humped, candidates: ['heel'] })
    const best = ranked[0].best
    expect(best.lo).toBeLessThanOrEqual(22)
    expect(best.hi).toBeGreaterThanOrEqual(21)
    expect(ranked[0].spread).toBeGreaterThan(0)
  })

  it('ranks the channel that matters above the one that does not', () => {
    const rows = Array.from({ length: 60 }, (_, i) => {
      const fsty = 12 + (i % 20) * 0.3
      return row({ fsty, vang: (i * 13) % 17, tws: 13 }, 90 + fsty)
    })
    const { ranked } = rankDrivers({ rows, candidates: ['fsty', 'vang'] })
    expect(ranked[0].key).toBe('fsty')
    expect(ranked[0].eta2).toBeGreaterThan(ranked[1].eta2)
  })

  it('always carries the association-not-cause caveat', () => {
    const { caveats } = rankDrivers({ rows: humped, candidates: ['heel'] })
    expect(caveats.join(' ')).toContain('association, not cause')
  })

  // The failure that would make this feature worse than useless: presenting a
  // channel that just tracks the breeze as the thing to go and adjust.
  it('flags a channel that is really just reading the wind', () => {
    const rows = Array.from({ length: 60 }, (_, i) => {
      const tws = 10 + (i % 15) * 0.5
      return row({ fsty: tws * 1.4, heel: (i * 7) % 13, tws }, 90 + tws)
    })
    const { ranked, caveats } = rankDrivers({ rows, candidates: ['fsty', 'heel'] })
    expect(ranked.find(d => d.key === 'fsty')!.rWithConditions).toBeGreaterThan(CONFOUND_R)
    expect(caveats.join(' ')).toContain('may just be the breeze')
  })

  it('refuses to crown a winner when the top two cannot be separated', () => {
    const rows = Array.from({ length: 60 }, (_, i) => {
      const a = i % 10
      return row({ alpha: a, beta: a + 0.0001, tws: 13 }, 90 + a)
    })
    const { caveats } = rankDrivers({ rows, candidates: ['alpha', 'beta'] })
    expect(caveats.join(' ')).toMatch(new RegExp(`within ${TIE_MARGIN}`))
  })

  it('owns up to having tested a lot of channels', () => {
    const rows = Array.from({ length: 80 }, (_, i) =>
      row({ a: i % 7, b: i % 5, c: i % 11, d: i % 3, e: i % 13, f: i % 9, tws: 13 }, 90 + (i % 7)))
    const { caveats } = rankDrivers({ rows, candidates: ['a', 'b', 'c', 'd', 'e', 'f'] })
    expect(caveats.join(' ')).toContain('partly luck')
  })

  it('says how little sailing the top answer rests on', () => {
    const rows = Array.from({ length: 18 }, (_, i) => row({ heel: 16 + (i % 9), tws: 13 }, 100 - Math.abs(16 + (i % 9) - 20)))
    const { caveats } = rankDrivers({ rows, candidates: ['heel'], minPerBand: 5 })
    expect(caveats.join(' ')).toMatch(/smallest band holds \d+ phases/)
  })

  it('reports nothing rather than something when there is not enough to rank', () => {
    const { ranked, caveats } = rankDrivers({ rows: [row({ heel: 20, tws: 13 }, 95)], candidates: ['heel'] })
    expect(ranked).toEqual([])
    expect(caveats[0]).toContain('enough phases')
  })

  it('skips a channel the boat does not log', () => {
    const { ranked } = rankDrivers({ rows: humped, candidates: ['heel', 'bobstay'] })
    expect(ranked.map(d => d.key)).toEqual(['heel'])
  })
})

describe('pearson', () => {
  it('is 1 on a rising line and -1 on a falling one', () => {
    const up = Array.from({ length: 10 }, (_, i) => ({ x: i, y: 2 * i + 1 }))
    expect(pearson(up)).toBeCloseTo(1, 6)
    expect(pearson(up.map(p => ({ x: p.x, y: -p.y })))).toBeCloseTo(-1, 6)
  })
  it('is 0 when x never moves', () => {
    expect(pearson([{ x: 5, y: 1 }, { x: 5, y: 2 }, { x: 5, y: 3 }])).toBe(0)
  })
})

// ── the tool around the maths ────────────────────────────────────────────────
import { buildDrivers } from '../askData'
import type { PhaseStat } from '../../phaseStats'
import type { RankDriversArgs } from '../askTools'

let pseq = 0
const phase = (mean: Record<string, number>): PhaseStat & { date: string } => {
  const utc = 1_000_000 + pseq++ * 30_000
  return {
    utc, endUtc: utc + 30_000, mode: 'up', tack: pseq % 2 ? 'port' : 'stbd',
    sails: [], sailCombo: 'J4_A 2026', race: null, n: 5, max: {}, mean, date: '2026-09-11',
  } as PhaseStat & { date: string }
}
const dArgs = (o: Partial<RankDriversArgs> = {}): RankDriversArgs =>
  ({ target: 'vmgPct', bands: 3, minPerBand: 5, ...o })

// heel peaks at 22°, forestay does nothing, in a 12–14 kn slice.
const slice = Array.from({ length: 60 }, (_, i) => {
  const heel = 16 + (i % 13)
  return phase({ heel, fsty: 12 + ((i * 7) % 9) * 0.2, tws: 12 + (i % 3), vmgPct: 100 - Math.abs(heel - 22) * 0.8, bsp: 10 })
})

describe('buildDrivers', () => {
  it('names the winner, its size, and where the optimum sits', () => {
    const r = buildDrivers(slice, dArgs(), '2026-09-11', '2026-09-11')
    expect(r.summary).toContain('|HEEL|')
    // The claim is that the fastest band CONTAINS the real optimum (22°), not
    // that the band edges land on particular numbers — those move with the
    // quantiles and asserting them would be testing the fixture, not the tool.
    const fastest = /fastest at ([\d.]+)–([\d.]+)/.exec(r.summary)!
    expect(Number(fastest[1])).toBeLessThanOrEqual(22)
    expect(Number(fastest[2])).toBeGreaterThanOrEqual(22)
    expect(r.summary).toContain('YOU MUST RELAY THESE CAVEATS')
    expect(r.summary).toContain('association, not cause')
  })

  // Ranking BSP against VMG% discovers that going fast makes you go fast.
  it('never ranks the target against itself under another name', () => {
    const r = buildDrivers(slice, dArgs(), 'a', 'b')
    const channels = r.tables[0].rows.map(row => String(row[0]))
    expect(channels).not.toContain('BSP')
    expect(channels).not.toContain('VMG%')
    expect(channels).not.toContain('TWS')
  })

  it('gives a ranking table and the winner band by band', () => {
    const r = buildDrivers(slice, dArgs(), 'a', 'b')
    expect(r.tables).toHaveLength(2)
    expect(r.tables[0].columns.map(c => c.key)).toContain('share')
    expect(r.tables[1].title).toContain('|HEEL|')
    expect(r.tables[1].rows.length).toBeGreaterThanOrEqual(2)
    expect(r.charts![0].kind).toBe('bar')
    expect(r.charts![0].series[0].points.length).toBe(r.tables[1].rows.length)
  })

  it('refuses when the slice is too thin to say anything', () => {
    const r = buildDrivers(slice.slice(0, 6), dArgs(), 'a', 'b')
    expect(r.charts).toBeUndefined()
    expect(r.unavailable).toMatch(/too few/)
  })

  it('refuses when every candidate is the target restated', () => {
    const r = buildDrivers(slice, dArgs({ candidates: ['bsp', 'sog'] }), 'a', 'b')
    expect(r.unavailable).toContain('same quantity under another name')
  })
})

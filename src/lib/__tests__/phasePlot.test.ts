import { describe, it, expect } from 'vitest'
import { phasePoints, linearTrend, tackTrends, plotDomain, polarTargetLine, twsBands, polarCurve, niceTicks, tickDecimals } from '../phasePlot'
import { polarInterp, polarVMGTarget } from '../polarCalc'
import { polarFromData } from '../polarFile'
import targetsV14 from '../../data/targets-v1.4.json'
import type { PhaseStat } from '../phaseStats'

const phase = (utc: number, tack: 'port' | 'stbd', tws: number | null, bsp: number | null): PhaseStat => ({
  utc, endUtc: utc + 30_000, mode: 'up', tack, sails: [], sailCombo: 'J4_A 2026', race: 1, n: 5,
  mean: { tws, bsp }, max: {},
})

describe('phasePoints', () => {
  it('keeps phases with both values and carries tack, time and sails', () => {
    const pts = phasePoints([phase(1, 'port', 20, 11), phase(2, 'stbd', null, 11), phase(3, 'stbd', 22, 12)], 'tws', 'bsp')
    expect(pts).toEqual([
      { x: 20, y: 11, tack: 'port', utc: 1, endUtc: 30_001, sails: 'J4_A 2026', n: 5 },
      { x: 22, y: 12, tack: 'stbd', utc: 3, endUtc: 30_003, sails: 'J4_A 2026', n: 5 },
    ])
    expect(phasePoints(null, 'tws', 'bsp')).toEqual([])
  })
})

describe('trends', () => {
  it('fits a line over the points’ own x-extent', () => {
    const t = linearTrend([{ x: 18, y: 10 }, { x: 20, y: 11 }, { x: 24, y: 13 }])!
    expect(t.slope).toBeCloseTo(0.5)
    expect(t.intercept).toBeCloseTo(1)
    expect(t.r2).toBeCloseTo(1)
    expect([t.x0, t.x1]).toEqual([18, 24])
  })

  it('needs 3 points with some x spread', () => {
    expect(linearTrend([{ x: 1, y: 1 }, { x: 2, y: 2 }])).toBeNull()
    expect(linearTrend([{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }])).toBeNull()
  })

  it('fits each tack separately', () => {
    const pts = phasePoints([
      phase(1, 'port', 18, 10), phase(2, 'port', 20, 11), phase(3, 'port', 22, 12),
      phase(4, 'stbd', 18, 12), phase(5, 'stbd', 20, 12),
    ], 'tws', 'bsp')
    const t = tackTrends(pts)
    expect(t.port?.slope).toBeCloseTo(0.5)
    expect(t.stbd).toBeNull()
  })
})

describe('plotDomain', () => {
  it('pads the range and includes reference values', () => {
    expect(plotDomain([10, 20])).toEqual([9.4, 20.6])
    const [lo, hi] = plotDomain([95, 98], [100])
    expect(lo).toBeLessThan(95)
    expect(hi).toBeGreaterThan(100)
  })

  it('opens a window around a flat or empty series', () => {
    expect(plotDomain([12, 12])).toEqual([11, 13])
    expect(plotDomain([NaN])).toEqual([0, 1])
  })
})

describe('axis ticks', () => {
  it('picks round steps inside the range', () => {
    // the ranges seen on 11 Sep: TWS 17.0–29.2, BSP 10.5–13.3, speed-vs-TWA 21–189°
    expect(niceTicks(17.0, 29.2, 5)).toEqual([17.5, 20, 22.5, 25, 27.5])
    expect(niceTicks(10.5, 13.3, 4)).toEqual([11, 12, 13])
    expect(niceTicks(21, 189, 5)).toEqual([50, 100, 150])
    expect(niceTicks(94.2, 101.4, 4)).toEqual([96, 98, 100])
  })

  it('survives degenerate ranges and float steps', () => {
    expect(niceTicks(5, 5)).toEqual([5])
    expect(niceTicks(NaN, 1)).toEqual([])
    expect(niceTicks(0.1, 0.7, 3)).toEqual([0.2, 0.4, 0.6])
  })

  it('shows as many decimals as the steps need', () => {
    expect(tickDecimals([17.5, 20, 22.5])).toBe(1)
    expect(tickDecimals([11, 12, 13])).toBe(0)
    expect(tickDecimals([0.25, 0.5, 0.75])).toBe(2)
  })
})

describe('twsBands', () => {
  const at = (tws: number[]) => tws.map((t, i) => phase(i, i % 2 ? 'port' : 'stbd', t, 11))

  it('centres 2 kn bands on even wind speeds, lower bound inclusive', () => {
    const b = twsBands(at([18.9, 19, 20.99, 21, 22.4, 23, 25]), 2, 1)
    expect(b.map(x => [x.centre, x.lo, x.hi, x.phases.length])).toEqual([
      [18, 17, 19, 1], [20, 19, 21, 2], [22, 21, 23, 2], [24, 23, 25, 1], [26, 25, 27, 1],
    ])
  })

  it('drops thin bands and phases without TWS', () => {
    // 19, 20 → 20 kn · 21, 22, 22.5 → 22 kn · 25 → 26 kn (alone, dropped) · null → skipped
    const b = twsBands([...at([19, 20, 21, 22, 22.5, 25]), phase(9, 'port', null, 11)], 2, 2)
    expect(b.map(x => [x.centre, x.phases.length])).toEqual([[20, 2], [22, 3]])
  })
})

describe('polarCurve', () => {
  const polar = polarFromData(targetsV14)   // TWS 4–24 kn, TWA 30–150°

  it('follows the polar along the angles it covers at that wind speed', () => {
    const c = polarCurve(polar, 20, 10)!
    expect(c[0].x).toBe(30)
    expect(c[c.length - 1].x).toBe(150)
    for (const p of c) expect(p.y).toBeCloseTo(polarInterp(polar, 20, p.x)!, 6)
  })

  it('draws nothing beyond the polar’s wind range or without a polar', () => {
    expect(polarCurve(polar, 26)).toBeNull()
    expect(polarCurve(polar, 3)).toBeNull()
    expect(polarCurve(null, 20)).toBeNull()
  })
})

describe('polarTargetLine', () => {
  const polar = polarFromData(targetsV14)

  it('gives the best-VMG BSP and angle across the TWS range', () => {
    const bsp = polarTargetLine(polar, 'up', 'bsp', 10, 20, 10)!
    expect(bsp).toHaveLength(11)
    for (const p of bsp) expect(p.y).toBeCloseTo(polarInterp(polar, p.x, polarVMGTarget(polar, p.x).up)!, 6)
    const twa = polarTargetLine(polar, 'down', 'twa', 10, 20, 4)!
    for (const p of twa) expect(p.y).toBeCloseTo(polarVMGTarget(polar, p.x).down, 6)
  })

  it('draws nothing where a target line makes no sense', () => {
    expect(polarTargetLine(null, 'up', 'bsp', 10, 20)).toBeNull()
    expect(polarTargetLine(polar, 'reach', 'bsp', 10, 20)).toBeNull()
    expect(polarTargetLine(polar, 'up', 'heel', 10, 20)).toBeNull()
    expect(polarTargetLine(polar, 'up', 'bsp', 20, 20)).toBeNull()
  })
})

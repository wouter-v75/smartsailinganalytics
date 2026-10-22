import { describe, it, expect } from 'vitest'
import { niceKnMax, traceMaxKn, wrapSegments, xOf, yOf, hourTicks, type Box } from '../obsTrace'
import type { ObsPoint } from '../windObs'

const pt = (t: string, twsKn: number, twdDeg: number | null = null, gustKn: number | null = null): ObsPoint =>
  ({ t, twsKn, twdDeg, gustKn })

describe('niceKnMax', () => {
  it('rounds up to 5 with headroom', () => {
    expect(niceKnMax(12)).toBe(15)
    expect(niceKnMax(15)).toBe(20)      // 15*1.1 = 16.5 -> 20, so the peak is not on the ceiling
    expect(niceKnMax(31)).toBe(35)
  })
  it('never squashes a light day into a flat line', () => {
    expect(niceKnMax(2)).toBe(10)
    expect(niceKnMax(0)).toBe(10)
    expect(niceKnMax(NaN)).toBe(10)
  })
})

describe('traceMaxKn', () => {
  it('fits the GUSTS, not just the mean', () => {
    const pts = [pt('2026-10-22T08:00:00Z', 10, 250, 22), pt('2026-10-22T08:10:00Z', 12, 250, null)]
    expect(traceMaxKn(pts)).toBe(22)
  })
  it('is zero for nothing', () => {
    expect(traceMaxKn([])).toBe(0)
  })
})

describe('wrapSegments', () => {
  it('does NOT draw a line across the dial when the wind veers through north', () => {
    // 350 -> 10 is a 20 degree veer. Joined naively it plunges the full height
    // of the chart and reads as a 340 degree backing wind.
    const pts = [
      pt('2026-10-22T08:00:00Z', 10, 340),
      pt('2026-10-22T08:10:00Z', 10, 350),
      pt('2026-10-22T08:20:00Z', 10, 10),
      pt('2026-10-22T08:30:00Z', 10, 20),
    ]
    const segs = wrapSegments(pts)
    expect(segs).toHaveLength(2)
    expect(segs[0].map((p) => p.deg)).toEqual([340, 350])
    expect(segs[1].map((p) => p.deg)).toEqual([10, 20])
  })

  it('keeps a big but real shift in one piece', () => {
    // 180 degrees exactly is not a wrap — it is a genuine reversal, and cutting
    // it would hide the most interesting thing on the chart.
    const pts = [pt('2026-10-22T08:00:00Z', 10, 90), pt('2026-10-22T08:10:00Z', 10, 260)]
    expect(wrapSegments(pts)).toHaveLength(1)
  })

  it('breaks the line at a calm, rather than inventing a direction through it', () => {
    const pts = [
      pt('2026-10-22T08:00:00Z', 10, 250),
      pt('2026-10-22T08:10:00Z', 0, null),
      pt('2026-10-22T08:20:00Z', 8, 100),
    ]
    const segs = wrapSegments(pts)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toHaveLength(1)
    expect(segs[1]).toHaveLength(1)
  })

  it('returns nothing for a trace with no directions at all', () => {
    expect(wrapSegments([pt('2026-10-22T08:00:00Z', 0, null)])).toHaveLength(0)
    expect(wrapSegments([])).toHaveLength(0)
  })

  it('skips an unparseable stamp', () => {
    expect(wrapSegments([pt('nope', 10, 250)])).toHaveLength(0)
  })
})

describe('xOf / yOf', () => {
  const b: Box = { w: 300, h: 100, left: 30, right: 10, top: 8, bottom: 18 }

  it('maps the window across the plot area', () => {
    expect(xOf(0, 0, 100, b)).toBe(30)
    expect(xOf(100, 0, 100, b)).toBe(290)       // w - right
    expect(xOf(50, 0, 100, b)).toBe(160)        // left + half of the 260 inner
  })

  it('clamps rather than drawing outside the box', () => {
    expect(xOf(-50, 0, 100, b)).toBe(30)
    expect(xOf(500, 0, 100, b)).toBe(290)
    expect(yOf(-5, 20, b)).toBe(yOf(0, 20, b))
    expect(yOf(999, 20, b)).toBe(yOf(20, 20, b))
  })

  it('puts zero at the bottom and the max at the top', () => {
    expect(yOf(0, 20, b)).toBe(82)              // 100 - 18
    expect(yOf(20, 20, b)).toBe(8)
  })

  it('survives a degenerate window or axis', () => {
    expect(xOf(5, 10, 10, b)).toBe(30)
    expect(yOf(5, 0, b)).toBe(82)
  })
})

describe('hourTicks', () => {
  it('ticks on the hour across the window', () => {
    const t0 = Date.parse('2026-10-22T06:20:00Z')
    const t1 = Date.parse('2026-10-22T09:05:00Z')
    const ticks = hourTicks(t0, t1)
    expect(ticks.length).toBeGreaterThanOrEqual(2)
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(t0)
      expect(t).toBeLessThanOrEqual(t1)
      expect(new Date(t).getMinutes()).toBe(0)
    }
  })
  it('is empty when the window is shorter than the gap to the next hour', () => {
    const t0 = Date.parse('2026-10-22T06:20:00Z')
    expect(hourTicks(t0, t0 + 10 * 60_000)).toHaveLength(0)
  })
})

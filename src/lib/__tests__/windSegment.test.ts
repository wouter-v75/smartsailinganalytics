import { describe, it, expect } from 'vitest'
import {
  findSegments, resampleTo1Hz, steadySeconds, segmentsIn, DEFAULTS,
} from '../wind/segment'
import { buildTrack, beat } from './support/syntheticTrack'

describe('resampleTo1Hz', () => {
  it('collapses a 10 Hz log to one sample a second', () => {
    const rows = buildTrack({
      twd: 270, rateHz: 10, turnSeconds: 0,
      legs: [{ twa: 42, seconds: 30 }],
    })
    expect(rows).toHaveLength(300)
    expect(resampleTo1Hz(rows)).toHaveLength(30)
  })

  it('leaves a 1 Hz log alone', () => {
    const rows = buildTrack({ twd: 270, rateHz: 1, turnSeconds: 0, legs: [{ twa: 42, seconds: 30 }] })
    expect(resampleTo1Hz(rows)).toHaveLength(30)
  })

  it('makes 2 Hz and 10 Hz logs directly comparable', () => {
    // The real session had one device at 2 Hz and another at 10 Hz. Without
    // this, a fixed window would mean a different duration on each.
    const a = buildTrack({ twd: 270, rateHz: 2, turnSeconds: 0, legs: [{ twa: 42, seconds: 60 }] })
    const b = buildTrack({ twd: 270, rateHz: 10, turnSeconds: 0, legs: [{ twa: 42, seconds: 60 }] })
    expect(resampleTo1Hz(a)).toHaveLength(resampleTo1Hz(b).length)
  })

  it('sorts and drops junk timestamps', () => {
    const rows = [
      { utc: 3000, cog: 1 }, { utc: 1000, cog: 2 }, { utc: NaN, cog: 3 }, { utc: 2000, cog: 4 },
    ]
    expect(resampleTo1Hz(rows).map((r) => r.utc)).toEqual([1000, 2000, 3000])
  })
})

describe('findSegments', () => {
  it('finds one segment per straight leg and none in the turns', () => {
    const segs = findSegments(beat(270, { legs: 4, legSeconds: 120 }))
    expect(segs).toHaveLength(4)
    for (const s of segs) expect(s.dur).toBeGreaterThanOrEqual(110)
  })

  it('recovers each leg’s bearing', () => {
    const segs = findSegments(beat(270, { legs: 2, legSeconds: 120, tackAngle: 42 }))
    const bearings = segs.map((s) => Math.round(s.bearing)).sort((a, b) => a - b)
    expect(bearings).toEqual([228, 312])    // 270 ± 42
  })

  it('never lets a segment span a manoeuvre', () => {
    const segs = findSegments(beat(270, { legs: 6, legSeconds: 100 }))
    const spread = segs.map((s) => s.steadiness)
    expect(Math.min(...spread)).toBeGreaterThan(DEFAULTS.minSteadiness)
  })

  it('rejects stretches slower than the minimum', () => {
    const rows = buildTrack({
      twd: 270, turnSeconds: 0,
      legs: [{ twa: 42, seconds: 120, sog: 0.5 }],   // drifting
    })
    expect(findSegments(rows)).toHaveLength(0)
  })

  it('rejects a straight stretch shorter than minSeconds', () => {
    // 8 s of sailing bounded by lying still: too short to be evidence of anything.
    const still = (t: number) => ({ utc: t, sog: 0, cog: 312, hdg: 312, heel: 0 })
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => still(0 + i * 1000)),
      ...buildTrack({ twd: 270, turnSeconds: 0, legs: [{ twa: 42, seconds: 8 }], startUtc: 20_000 }),
      ...Array.from({ length: 20 }, (_, i) => still(28_000 + i * 1000)),
    ]
    expect(findSegments(rows)).toHaveLength(0)
  })

  it('KNOWN LIMIT: a very slow turn can still look straight in pieces', () => {
    // Comparing each sample to the segment's running mean catches a normal tack
    // (5–10 s through ~85°). A deliberately languid 30 s turn drifts under the
    // per-sample threshold for long enough to yield short "straight" pieces.
    // Real manoeuvres are far faster and lose speed, so this is recorded rather
    // than defended against — but a future arc-detection pass should kill it.
    const rows = buildTrack({
      twd: 270, turnSeconds: 30, legs: [{ twa: 42, seconds: 8 }, { twa: -42, seconds: 8 }],
    })
    const segs = findSegments(rows)
    expect(segs.length).toBeGreaterThan(0)
    // They are at least short, so they carry little weight in a duration-weighted fit.
    for (const seg of segs) expect(seg.dur).toBeLessThan(25)
  })

  it('drops samples with implausible heel without losing the segment', () => {
    // One badly-mounted device logged heel spanning -173deg..+133deg.
    const rows = buildTrack({ twd: 270, turnSeconds: 0, legs: [{ twa: 42, seconds: 120 }] })
    rows[60].heel = -173.5
    const segs = findSegments(rows)
    // The bad sample breaks the run in two; both halves still qualify.
    expect(segs.length).toBeGreaterThanOrEqual(1)
    expect(steadySeconds(segs)).toBeGreaterThan(100)
  })

  it('breaks a segment across a data gap', () => {
    const rows = buildTrack({ twd: 270, turnSeconds: 0, legs: [{ twa: 42, seconds: 120 }] })
    const shifted = rows.slice(60).map((r) => ({ ...r, utc: r.utc + 30_000 }))   // 30 s hole
    const segs = findSegments([...rows.slice(0, 60), ...shifted])
    expect(segs).toHaveLength(2)
  })

  it('can segment on heading instead of course', () => {
    const rows = buildTrack({ twd: 270, turnSeconds: 0, legs: [{ twa: 42, seconds: 120 }], leewayDeg: 5 })
    const byCog = findSegments(rows, { channel: 'cog' })[0]
    const byHdg = findSegments(rows, { channel: 'hdg' })[0]
    expect(Math.abs(byCog.bearing - byHdg.bearing)).toBeCloseTo(5, 0)
  })

  it('carries heel and heading through for the calibration solve', () => {
    const segs = findSegments(beat(270, { legs: 2, legSeconds: 120, heelDeg: 18, leewayDeg: 4 }))
    expect(segs[0].hdg).not.toBeNull()
    expect(Math.abs(segs[0].heel!)).toBeCloseTo(18, 0)
  })

  it('returns nothing for an empty or still track', () => {
    expect(findSegments([])).toEqual([])
    expect(findSegments([{ utc: 1000, sog: 0, cog: 10 }])).toEqual([])
  })
})

describe('steadySeconds and segmentsIn', () => {
  const segs = findSegments(beat(270, { legs: 4, legSeconds: 120 }))

  it('totals the steady time', () => {
    // 4 legs x 120 s, plus a second or two of each turn before the running-mean
    // check trips — so a little over the nominal 480 s, never under.
    expect(steadySeconds(segs)).toBeGreaterThan(450)
    expect(steadySeconds(segs)).toBeLessThanOrEqual(520)
  })

  it('selects segments overlapping a window', () => {
    const t0 = segs[0].startUtc
    expect(segmentsIn(segs, t0, t0 + 1000)).toHaveLength(1)
    expect(segmentsIn(segs, t0, t0 + 10 * 60_000).length).toBe(segs.length)
    expect(segmentsIn(segs, t0 - 60_000, t0 - 1)).toHaveLength(0)
  })
})

// The builder decides what is allowed to become performance data, so these tests are
// mostly about what it must REFUSE. A phase wrongly accepted is a number in the season
// reference that nobody can trace back.
import { describe, it, expect } from 'vitest'
import { buildPhases, SSA_MODE } from '../buildPhases'
import { withSettings } from '../phaseSettings'
import type { LogRow } from '../phaseStats'

const T0 = Date.UTC(2026, 8, 11, 10, 0, 0)

// One row a second of steady upwind sailing, with per-second overrides.
function rows(seconds: number, at: (s: number) => Partial<LogRow> = () => ({}), t0 = T0): LogRow[] {
  return Array.from({ length: seconds }, (_, s) => ({
    utc: t0 + s * 1000,
    bsp: 9, tws: 12, twa: 42, awa: 28, hdg: 40, heel: 20,
    ...at(s),
  }))
}

const S = withSettings()                       // the published defaults
const dayXml = (extra: Record<string, unknown> = {}) => ({
  dayStartUtc: T0, dayStopUtc: T0 + 3600_000, tackJibes: [], markRoundings: [], sailsUpEvents: [], ...extra,
})

const steady = (r: ReturnType<typeof buildPhases>) => r.phases.filter(p => p.kind === 'steady')

describe('tiling', () => {
  it('cuts a clean stretch into whole phases and drops the remainder', () => {
    // 100 s of clean sailing at 30 s phases = three phases, 10 s left over.
    const r = buildPhases(rows(100), dayXml({ dayStopUtc: T0 + 100_000 }), S)
    expect(steady(r)).toHaveLength(3)
    expect(steady(r)[0]).toMatchObject({ utc: T0, endUtc: T0 + 30_000, mode: SSA_MODE, src: 'ssa' })
    expect(steady(r)[2].endUtc).toBe(T0 + 90_000)
  })

  it('narrows to a track selection', () => {
    const r = buildPhases(rows(300), dayXml(), S, { from: T0 + 60_000, to: T0 + 150_000 })
    expect(steady(r)).toHaveLength(3)
    expect(steady(r)[0].utc).toBe(T0 + 60_000)
  })

  it('tags every phase with the run it came from', () => {
    const r = buildPhases(rows(100), dayXml(), S, { runId: 'run-7' })
    expect(steady(r).every(p => p.runId === 'run-7')).toBe(true)
  })
})

describe('manoeuvre guard', () => {
  it('keeps a phase out of the wake of a tack', () => {
    // Tack at +150 s; the guard is one phase length either side, so 120–180 s is gone.
    const xml = dayXml({ tackJibes: [{ utc: T0 + 150_000, isTack: true }], dayStopUtc: T0 + 300_000 })
    const r = buildPhases(rows(300), xml, S)
    const touching = steady(r).filter(p => p.endUtc > T0 + 120_000 && p.utc < T0 + 180_000)
    expect(touching).toHaveLength(0)
    expect(steady(r).length).toBeGreaterThan(0)
  })

  it('merges back-to-back manoeuvres rather than fitting a phase between them', () => {
    // Two gybes 40 s apart: their guards overlap, and nothing usable is left between.
    const xml = dayXml({
      tackJibes: [{ utc: T0 + 100_000, isTack: false }, { utc: T0 + 140_000, isTack: false }],
      dayStopUtc: T0 + 300_000,
    })
    const r = buildPhases(rows(300), xml, S)
    const between = steady(r).filter(p => p.utc >= T0 + 70_000 && p.endUtc <= T0 + 170_000)
    expect(between).toHaveLength(0)
  })

  it('guards a mark rounding and a sail change too', () => {
    const xml = dayXml({
      markRoundings: [{ utc: T0 + 60_000 }], sailsUpEvents: [{ utc: T0 + 200_000 }], dayStopUtc: T0 + 300_000,
    })
    const r = buildPhases(rows(300), xml, S)
    for (const t of [T0 + 60_000, T0 + 200_000]) {
      expect(steady(r).some(p => p.utc <= t && p.endUtc >= t)).toBe(false)
    }
  })
})

describe('the gate', () => {
  const only = (r: ReturnType<typeof buildPhases>) => r.rejected.map(x => x.reason).join(' | ')

  it('accepts steady sailing', () => {
    const r = buildPhases(rows(60), dayXml({ dayStopUtc: T0 + 60_000 }), S)
    expect(steady(r)).toHaveLength(2)
    expect(r.rejected).toHaveLength(0)
  })

  it('rejects a phase built from too few of the rows the log should hold', () => {
    // A 1 Hz log that lost half of one block's rows, spread thinly rather than in one
    // hole — the gap check cannot see it, the coverage check must.
    const patchy = rows(60).filter(x => { const s = (x.utc - T0) / 1000; return s < 30 || s % 3 === 0 })
    const r = buildPhases(patchy, dayXml({ dayStopUtc: T0 + 60_000 }), S)
    expect(steady(r)).toHaveLength(1)
    expect(only(r)).toMatch(/too few rows/)
  })

  it('refuses the coarse cloud copy of a log outright', () => {
    // A row every 6 s: below the published floor for this work, and every block is holes.
    const sparse = rows(10).map((r, i) => ({ ...r, utc: T0 + i * 6000 }))
    const r = buildPhases(sparse, dayXml({ dayStopUtc: T0 + 60_000 }), S)
    expect(steady(r)).toHaveLength(0)
  })

  it('rejects a phase with a hole in the log', () => {
    const withGap = rows(60).filter(x => { const s = (x.utc - T0) / 1000; return s < 10 || s > 20 })
    const r = buildPhases(withGap, dayXml({ dayStopUtc: T0 + 30_000 }), S)
    expect(only(r)).toMatch(/gap in the log/)
  })

  it('rejects drifting away from the point of sail it started on', () => {
    // AWA walks 36° across the block: the boat is not doing the same thing any more.
    const r = buildPhases(rows(30, s => ({ awa: 28 + s * 1.2 })), dayXml({ dayStopUtc: T0 + 30_000 }), S)
    expect(steady(r)).toHaveLength(0)
    expect(only(r)).toMatch(/AWA drifted/)
  })

  it('rejects a phase where the breeze is building through it', () => {
    const r = buildPhases(rows(30, s => ({ tws: 10 + s * 0.2 })), dayXml({ dayStopUtc: T0 + 30_000 }), S)
    expect(only(r)).toMatch(/TWS drifted/)
  })

  it('rejects a phase where the boat is still accelerating', () => {
    const r = buildPhases(rows(30, s => ({ bsp: 7 + s * 0.1 })), dayXml({ dayStopUtc: T0 + 30_000 }), S)
    expect(only(r)).toMatch(/BSP drifted/)
  })

  it('tolerates noise around a steady mean — that is what averaging is for', () => {
    // ±8° of AWA slop in a seaway, no drift: the masthead swings, the sailing does not.
    const r = buildPhases(rows(60, s => ({ awa: 28 + (s % 2 ? 8 : -8) })), dayXml({ dayStopUtc: T0 + 60_000 }), S)
    expect(steady(r)).toHaveLength(2)
  })

  it('rejects a swing wider than the guard rail', () => {
    const r = buildPhases(rows(30, s => ({ tws: 12 + (s % 2 ? 6 : -6) })), dayXml({ dayStopUtc: T0 + 30_000 }), S)
    expect(only(r)).toMatch(/TWS swung/)
  })

  it('rejects a sustained turn but not one slew off a wave', () => {
    const turning = buildPhases(rows(30, s => ({ hdg: 40 + s * 8 })), dayXml({ dayStopUtc: T0 + 30_000 }), S)
    expect(only(turning)).toMatch(/turning/)
    const slewed = buildPhases(rows(60, s => ({ hdg: s === 20 ? 55 : 40 })), dayXml({ dayStopUtc: T0 + 60_000 }), S)
    expect(steady(slewed)).toHaveLength(2)
  })

  it('rejects a tack the event file never mentioned', () => {
    const r = buildPhases(rows(30, s => ({ twa: s < 15 ? 42 : -42 })), dayXml({ dayStopUtc: T0 + 30_000 }), S)
    expect(only(r)).toMatch(/tack changed inside the phase/)
  })

  it('rejects parked, drifting and head-to-wind phases', () => {
    const slow = buildPhases(rows(30, () => ({ bsp: 1 })), dayXml({ dayStopUtc: T0 + 30_000 }), S)
    expect(only(slow)).toMatch(/too slow/)
    const light = buildPhases(rows(30, () => ({ tws: 1.5 })), dayXml({ dayStopUtc: T0 + 30_000 }), S)
    expect(only(light)).toMatch(/too light/)
    const pinched = buildPhases(rows(30, () => ({ twa: 8, awa: 6 })), dayXml({ dayStopUtc: T0 + 30_000 }), S)
    expect(only(pinched)).toMatch(/head to wind/)
  })

  it('rejects a phase whose channels are missing rather than averaging nothing', () => {
    const r = buildPhases(rows(30, () => ({ tws: null, twa: null })), dayXml({ dayStopUtc: T0 + 30_000 }), S)
    expect(only(r)).toMatch(/channel missing/)
  })

  it('counts the reasons so a failing sensor shows up as a histogram', () => {
    const r = buildPhases(rows(120, () => ({ bsp: 1 })), dayXml({ dayStopUtc: T0 + 120_000 }), S)
    expect(r.reasons[0].n).toBe(4)
    expect(r.reasons[0].reason).toBe('too slow')
  })
})

describe('quality score', () => {
  it('is higher for the calmer of two accepted phases', () => {
    const calm = steady(buildPhases(rows(30), dayXml({ dayStopUtc: T0 + 30_000 }), S))[0]
    const lumpy = steady(buildPhases(
      rows(30, s => ({ awa: 28 + (s % 2 ? 9 : -9), bsp: 9 + (s % 2 ? 0.8 : -0.8) })),
      dayXml({ dayStopUtc: T0 + 30_000 }), S,
    ))[0]
    expect(calm.quality).toBeGreaterThan(lumpy.quality)
    expect(lumpy.quality).toBeGreaterThan(0)
  })
})

describe('manoeuvre phases', () => {
  const xml = dayXml({
    tackJibes: [{ utc: T0 + 150_000, isTack: true }, { utc: T0 + 250_000, isTack: false }],
    dayStopUtc: T0 + 300_000,
  })

  it('keeps tacks and gybes as phases of their own, for calibration', () => {
    const r = buildPhases(rows(300), xml, S)
    const man = r.phases.filter(p => p.kind !== 'steady')
    expect(man.map(p => p.kind)).toEqual(['tack', 'gybe'])
    expect(man[0].utc).toBe(T0 + 150_000 - 10_000)
    expect(man[0].endUtc).toBe(T0 + 150_000 + 10_000)
  })

  it('can be turned off', () => {
    const r = buildPhases(rows(300), xml, withSettings({ manoeuvrePhases: false }))
    expect(r.phases.every(p => p.kind === 'steady')).toBe(true)
  })

  it('leaves the phases in time order whichever kind they are', () => {
    const r = buildPhases(rows(300), xml, S)
    const utcs = r.phases.map(p => p.utc)
    expect([...utcs].sort((a, b) => a - b)).toEqual(utcs)
  })
})

describe('nothing to build', () => {
  it('is empty for an empty log', () => {
    expect(buildPhases([], dayXml(), S).phases).toHaveLength(0)
    expect(buildPhases(null, dayXml(), S).reasons).toHaveLength(0)
  })

  it('is empty when the selection is inside out', () => {
    expect(buildPhases(rows(60), dayXml(), S, { from: T0 + 50_000, to: T0 }).phases).toHaveLength(0)
  })
})

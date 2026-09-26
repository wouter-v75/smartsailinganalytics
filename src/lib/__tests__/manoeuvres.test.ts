import { describe, it, expect } from 'vitest'
import { analyseManoeuvres, detectFromLog, manoeuvreAverages, manoeuvreNote, isJudged } from '../manoeuvres'
import type { LogRow } from '../phaseStats'

const T0 = Date.UTC(2026, 8, 11, 10, 0, 0)

// A scripted tack at T0, 1 Hz: stbd (TWA +40, HDG 250) → port (TWA −40, HDG 330).
// The bow turns at 10°/s for 8 s; BSP dips 12 → 9 kn at +8 s and recovers linearly to 12 at +30 s.
function tackRows(t0 = T0, from = -120, to = 180, extra: Record<string, number> = {}): LogRow[] {
  const out: LogRow[] = []
  for (let s = from; s < to; s++) {
    const rel = s
    const bsp = rel < 0 ? 12 : rel <= 8 ? 12 - (3 / 8) * rel : rel <= 30 ? 9 + (3 / 22) * (rel - 8) : 12
    const hdg = rel < 0 ? 250 : rel <= 8 ? 250 + 10 * rel : 330
    out.push({ utc: t0 + s * 1000, bsp, twa: rel < 0 ? 40 : -40, hdg, tws: 20, ...extra })
  }
  return out
}
const xmlWith = (over: Record<string, unknown> = {}) => ({
  tackJibes: [{ utc: T0, isTack: true, isValid: false }],
  raceGuns: [{ utc: T0 - 60_000 }],
  dayStopUtc: T0 + 3_600_000,
  markRoundings: [],
  sailsUpEvents: [{ utc: T0 - 600_000, sails: ['MAIN_B 2026', 'J4_A 2026'] }],
  ...over,
})

describe('analyseManoeuvres — one scripted tack', () => {
  const [m] = analyseManoeuvres(tackRows(), xmlWith())

  it('identifies the manoeuvre and its context', () => {
    expect([m.kind, m.source, m.context, m.race, m.from, m.to, m.sails]).toEqual(['tack', 'event', 'race', 1, 'stbd', 'port', 'J4_A 2026'])
    expect([m.atMark, m.intoMark, m.shortHitch, m.logGap]).toEqual([false, false, false, false])
    expect(isJudged(m)).toBe(true)
  })

  it('measures speed before, at +20 s and the recovery to 95 %', () => {
    expect(m.bspBefore).toBeCloseTo(12)
    expect(m.bspAfter).toBeCloseTo((10.227 + 10.364 + 10.5 + 10.636 + 10.773 + 10.909) / 6, 2)
    expect(m.timeTo95).toBe(26)          // 9 + 3/22·(t−8) ≥ 11.4 first at t = 26 s
  })

  it('measures the turn, rotation rate and the distance lost against the wind', () => {
    expect(m.turnAngle).toBeCloseTo(80)
    expect(m.maxRotation).toBeCloseTo(10)
    // Σ(12 − BSP)·dt = 45 kn·s over the dip → × cos 40° × 0.5144 m/s per kn
    expect(m.distLost!).toBeCloseTo(45 * Math.cos((40 * Math.PI) / 180) * 0.5144, 1)
    expect(m.target).toBe(70)
  })
})

describe('analyseManoeuvres — what gets judged', () => {
  it('treats a manoeuvre just before a mark rounding as the rounding', () => {
    const [m] = analyseManoeuvres(tackRows(), xmlWith({ markRoundings: [{ utc: T0 + 20_000 }] }))
    expect(m.atMark).toBe(true)
    expect(isJudged(m)).toBe(false)
    expect(manoeuvreNote(m)).toBe('at mark')
  })

  it('flags "into mark" and leaves the distance lost out when a rounding is inside the window', () => {
    const [m] = analyseManoeuvres(tackRows(), xmlWith({ markRoundings: [{ utc: T0 + 45_000 }] }))
    expect([m.atMark, m.intoMark, m.distLost]).toEqual([false, true, null])
    expect(m.timeTo95).toBe(26)
  })

  it('leaves the distance lost out of a short hitch', () => {
    const list = analyseManoeuvres(tackRows(), xmlWith({ tackJibes: [{ utc: T0 - 40_000, isTack: true }, { utc: T0, isTack: true }] }))
    expect(list[1].shortHitch).toBe(true)
    expect(list[1].distLost).toBeNull()
    expect(manoeuvreNote(list[1])).toBe('short hitch')
  })

  it('places manoeuvres before a gun, in the pre-start of the next race and after the day stop', () => {
    expect(analyseManoeuvres(tackRows(), xmlWith({ raceGuns: [{ utc: T0 + 300_000 }] }))[0].context).toBe('pre-start')
    expect(analyseManoeuvres(tackRows(), xmlWith({ raceGuns: [{ utc: T0 - 3_600_000 }, { utc: T0 + 600_000 }] }))[0].context).toBe('pre-start')
    expect(analyseManoeuvres(tackRows(), xmlWith({ dayStopUtc: T0 - 60_000 }))[0].context).toBe('after')
    expect(analyseManoeuvres(tackRows(), xmlWith({ raceGuns: [] }))[0].context).toBe('training')
  })

  it('times the recovery from the dip in the first 30 s, not a later lull', () => {
    // a lull at +70 s dips lower than the tack itself; recovery is still 26 s
    const rows = tackRows().map(r => (r.utc >= T0 + 68_000 && r.utc <= T0 + 72_000 ? { ...r, bsp: 7 } : r))
    expect(analyseManoeuvres(rows, xmlWith())[0].timeTo95).toBe(26)
  })

  it('gives no recovery time when speed never dipped below 95 % of "before"', () => {
    // e.g. a short hitch whose "before" window caught the previous tack's slow recovery
    const rows = tackRows().map(r => (r.utc < T0 ? { ...r, bsp: 9.5 } : r.utc < T0 + 60_000 ? { ...r, bsp: 11 } : r))
    expect(analyseManoeuvres(rows, xmlWith())[0].timeTo95).toBeNull()
  })

  it('gives no recovery time when the log breaks off before the boat is back up to speed', () => {
    const rows = tackRows().filter(r => r.utc <= T0 + 12_000 || r.utc >= T0 + 40_000)
    expect(analyseManoeuvres(rows, xmlWith())[0].timeTo95).toBeNull()
  })

  it('flags a log gap and skips the distance lost', () => {
    const rows = tackRows().filter(r => r.utc < T0 + 10_000 || r.utc > T0 + 40_000)
    const [m] = analyseManoeuvres(rows, xmlWith())
    expect(m.logGap).toBe(true)
    expect(m.distLost).toBeNull()
  })
})

describe('log fallback', () => {
  it('finds TWA sign flips when the event file lists no manoeuvres', () => {
    const [m] = analyseManoeuvres(tackRows(), xmlWith({ tackJibes: [] }))
    expect([m.utc, m.kind, m.source]).toEqual([T0, 'tack', 'log'])
  })

  it('ignores flips at low speed and debounces wobbles', () => {
    const slow = tackRows().map(r => ({ ...r, bsp: 3 }))
    expect(detectFromLog(slow)).toEqual([])
    const wobble = tackRows().map(r => (r.utc > T0 + 5000 && r.utc < T0 + 10_000 ? { ...r, twa: 5 } : r))
    expect(detectFromLog(wobble)).toHaveLength(1)
  })
})

describe('manoeuvreAverages', () => {
  it('averages each metric over the values present', () => {
    const [a] = analyseManoeuvres(tackRows(), xmlWith())
    const b = { ...a, distLost: null, timeTo95: 30 }
    const avg = manoeuvreAverages([a, b])
    expect(avg.timeTo95).toBe(28)
    expect(avg.distLost).toBeCloseTo(a.distLost!)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Rate of turn and radius, in BOTH directions.
//
// The reason this test exists: neither turnRate nor turnRadius had ANY coverage.
// The scripted tack above cannot reach them — it carries `twa`, not `awa`, so the
// apparent-wind crossing the window is centred on never happens and both come back
// null. So the rate, the radius, and the direction were all unexercised, and the
// question "is a turn to starboard measured the same as a turn to port" had no
// answer in the suite at all. It matters because the steering analysis turns on
// which rudder was on the INSIDE, which only the direction can say.
//
// A mirrored pair is the only shape of test that catches a sign error here: a
// one-directional fixture passes whichever way round the difference is taken. The
// 360-crossing case is here for the same reason — an unwrapped subtraction reads a
// turn from 340 through north as −320°/s.
// ─────────────────────────────────────────────────────────────────────────────

/** A tack through 80° at 10°/s, with SIGNED awa so the crossing is findable. */
function turnRows(dir: 'stbd' | 'port', t0 = T0): LogRow[] {
  const out: LogRow[] = []
  const sign = dir === 'stbd' ? 1 : -1
  for (let s = -120; s < 180; s++) {
    const bsp = s < 0 ? 12 : s <= 8 ? 12 - (3 / 8) * s : s <= 30 ? 9 + (3 / 22) * (s - 8) : 12
    const swept = s < 0 ? 0 : s <= 8 ? 10 * s : 80
    const hdg = ((250 + sign * swept) % 360 + 360) % 360
    // awa crosses zero at the midpoint of the turn, and carries the bow's side.
    const awa = sign * (s < 0 ? 35 : s <= 8 ? 35 - (70 / 8) * s : -35)
    out.push({ utc: t0 + s * 1000, bsp, awa, twa: awa, hdg, tws: 20 })
  }
  return out
}

describe('turnRate and turnRadius are direction-blind', () => {
  const stbd = analyseManoeuvres(turnRows('stbd'), xmlWith())[0]
  const port = analyseManoeuvres(turnRows('port'), xmlWith())[0]

  it('measures a rate in both directions', () => {
    expect(stbd.turnRate).not.toBeNull()
    expect(port.turnRate).not.toBeNull()
  })

  it('reports the rate as a magnitude, never negative', () => {
    expect(stbd.turnRate!).toBeGreaterThan(0)
    expect(port.turnRate!).toBeGreaterThan(0)
  })

  it('gives the mirrored turns the same rate', () => {
    expect(stbd.turnRate!).toBeCloseTo(port.turnRate!, 6)
  })

  it('records which way the bow went', () => {
    expect(stbd.turnDir).toBe('stbd')
    expect(port.turnDir).toBe('port')
  })

  it('gives a radius in both directions, and the same one', () => {
    expect(stbd.turnRadius).not.toBeNull()
    expect(port.turnRadius).not.toBeNull()
    expect(stbd.turnRadius!).toBeCloseTo(port.turnRadius!, 6)
  })

  it('gets the radius right: R = v / omega', () => {
    // 10°/s is 0.1745 rad/s; the mean BSP over the 6 s window is what it is, so
    // assert the relation rather than a hardcoded metre count.
    const v = stbd.turnSpeed! * 0.5144
    expect(stbd.turnRadius!).toBeCloseTo(v / (stbd.turnRate! * Math.PI / 180), 3)
  })

  it('crosses 360 without inventing a turn', () => {
    // A turn from 340 through north: before-minus-after without wrapping gives
    // −320°/s instead of +10.
    const rows = turnRows('stbd').map(r => ({ ...r, hdg: (((r.hdg as number) + 90) % 360) }))
    const m = analyseManoeuvres(rows, xmlWith())[0]
    expect(m.turnRate!).toBeCloseTo(stbd.turnRate!, 6)
    expect(m.turnDir).toBe('stbd')
  })
})

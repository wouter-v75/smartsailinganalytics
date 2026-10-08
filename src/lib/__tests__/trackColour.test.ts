import { describe, it, expect } from 'vitest'
import { trackPct, toMode, modeLabel, TRACK_COLOUR_MODES, scaleForRows, colourFor, legendStops } from '../trackColour'
import { pctColour } from '../pctScale'
import { preparePolar } from '../polarCalc'

// A small, symmetric, entirely synthetic polar: fastest on a beam reach, slower
// as the angle closes or opens. Enough shape for the optimum VMG angles to land
// somewhere sensible at both ends of the course.
const polar = preparePolar({
  entries: [8, 16].map((tws) => ({
    tws,
    points: [30, 45, 60, 90, 120, 150, 170].map((twa) => ({
      twa,
      bsp: (tws / 2) * Math.sin((twa * Math.PI) / 180) ** 0.7,
    })),
  })),
})

const at = (twa: number, tws = 12) => {
  // The polar's own speed at this angle — a boat sailing exactly to its polar.
  const e = polar.entries
  const lo = e[0], hi = e[1]
  const f = (tws - lo.tws) / (hi.tws - lo.tws)
  return lo.bspAt(twa) + f * (hi.bspAt(twa) - lo.bspAt(twa))
}

describe('the modes are a real choice', () => {
  it('leads with auto plus the three the crew asked for', () => {
    // The channels off the log come after them; these four are the polar questions.
    expect(TRACK_COLOUR_MODES.map((m) => m.key).slice(0, 4)).toEqual(['auto', 'vmg', 'polbsp', 'target'])
    expect(TRACK_COLOUR_MODES.filter((m) => m.kind === 'pct').map((m) => m.key))
      .toEqual(['auto', 'vmg', 'polbsp', 'target'])
  })

  it('every mode has a label and says what it measures', () => {
    for (const m of TRACK_COLOUR_MODES) {
      expect(m.label.length).toBeGreaterThan(0)
      expect(m.hint.length).toBeGreaterThan(10)
    }
  })

  it('reads a stored preference back, and ignores rubbish', () => {
    expect(toMode('vmg')).toBe('vmg')
    expect(toMode('nonsense')).toBe('auto')
    expect(toMode(null)).toBe('auto')
    expect(toMode(7)).toBe('auto')
    expect(modeLabel('target')).toBe('Target %')
  })
})

describe('a boat sailing exactly to its polar', () => {
  it('is 100% on Pol BSP at whatever angle it is steering', () => {
    for (const twa of [40, 65, 90, 135, 160]) {
      const pct = trackPct(polar, { bsp: at(twa), twa, tws: 12 }, 'polbsp')
      expect(pct).toBeCloseTo(100, 0)
    }
  })

  it('scores below 100 on Pol BSP when it is slow', () => {
    const pct = trackPct(polar, { bsp: at(45) * 0.9, twa: 45, tws: 12 }, 'polbsp')!
    expect(pct).toBeGreaterThan(85)
    expect(pct).toBeLessThan(95)
  })
})

describe('VMG % is about progress, not speed', () => {
  it('is 100% at the optimum upwind angle, sailing to the polar', () => {
    const { up } = { up: polarUp(12) }
    expect(trackPct(polar, { bsp: at(up), twa: up, tws: 12 }, 'vmg')).toBeCloseTo(100, 0)
  })

  it('punishes a boat that is quick in the wrong direction', () => {
    // Two degrees low and quick: over 100 on boat speed, under on VMG. That
    // disagreement is the whole reason the modes are separate.
    const twa = polarUp(12) + 14
    const bsp = at(twa)
    expect(trackPct(polar, { bsp, twa, tws: 12 }, 'polbsp')).toBeCloseTo(100, 0)
    expect(trackPct(polar, { bsp, twa, tws: 12 }, 'vmg')!).toBeLessThan(99)
  })

  it('works on the run as well as the beat', () => {
    const down = polarDown(12)
    expect(trackPct(polar, { bsp: at(down), twa: down, tws: 12 }, 'vmg')).toBeCloseTo(100, 0)
    // And with a negative TWA — the log records which tack, and a percentage
    // that flipped sign with it would paint one gybe red and the other green.
    expect(trackPct(polar, { bsp: at(down), twa: -down, tws: 12 }, 'vmg')).toBeCloseTo(100, 0)
  })
})

describe('Target % is the number on the instruments', () => {
  it('is 100% at target speed, even when the angle is not the target angle', () => {
    // A helm sailing six degrees LOW but only making target boat speed reads
    // 100% here — the instruments say the number is right — and under 100% on
    // Pol BSP, because at that wider angle the polar expects more. Which is
    // exactly the argument the debrief is trying to have, and the reason these
    // are two modes rather than one.
    const up = polarUp(12)
    const targetBsp = at(up)
    expect(trackPct(polar, { bsp: targetBsp, twa: up + 6, tws: 12 }, 'target')).toBeCloseTo(100, 0)
    expect(trackPct(polar, { bsp: targetBsp, twa: up + 6, tws: 12 }, 'polbsp')!).toBeLessThan(100)
  })

  it('uses the downwind target below 90°, not the upwind one', () => {
    const upTarget = trackPct(polar, { bsp: 6, twa: 45, tws: 12 }, 'target')!
    const downTarget = trackPct(polar, { bsp: 6, twa: 140, tws: 12 }, 'target')!
    expect(upTarget).not.toBeCloseTo(downTarget, 1)
  })
})

describe('what cannot be known is not coloured', () => {
  it('is null without a polar', () => {
    expect(trackPct(null, { bsp: 8, twa: 45, tws: 12 }, 'vmg')).toBeNull()
  })

  it('is null for a row missing a reading — green would be inventing one', () => {
    expect(trackPct(polar, { bsp: 8, twa: 45, tws: null }, 'vmg')).toBeNull()
    expect(trackPct(polar, { bsp: null, twa: 45, tws: 12 }, 'polbsp')).toBeNull()
    expect(trackPct(polar, { bsp: 8, twa: undefined, tws: 12 }, 'target')).toBeNull()
    expect(trackPct(polar, null, 'auto')).toBeNull()
  })

  it('is null when the boat is not sailing', () => {
    for (const mode of ['auto', 'vmg', 'polbsp', 'target'] as const) {
      expect(trackPct(polar, { bsp: 0.1, twa: 45, tws: 12 }, mode)).toBeNull()
    }
  })

  it('never returns NaN, which would paint an undefined colour', () => {
    for (const mode of ['auto', 'vmg', 'polbsp', 'target'] as const) {
      for (const row of [{ bsp: 8, twa: 0, tws: 12 }, { bsp: 8, twa: 180, tws: 12 }, { bsp: 40, twa: 90, tws: 0.1 }]) {
        const out = trackPct(polar, row, mode)
        expect(out === null || Number.isFinite(out)).toBe(true)
      }
    }
  })

  it('stays inside the range the colour scale is built for', () => {
    const out = trackPct(polar, { bsp: 99, twa: 45, tws: 6 }, 'polbsp')!
    expect(out).toBeLessThanOrEqual(150)
    expect(out).toBeGreaterThanOrEqual(0)
  })
})

describe('auto is still what it was', () => {
  it('measures VMG near a VMG angle', () => {
    const up = polarUp(12)
    expect(trackPct(polar, { bsp: at(up), twa: up, tws: 12 }, 'auto')).toBeCloseTo(100, 0)
  })

  it('measures boat speed on a reach', () => {
    expect(trackPct(polar, { bsp: at(90), twa: 90, tws: 12 }, 'auto')).toBeCloseTo(100, 0)
  })
})

// The optimum angles this synthetic polar actually has, interpolated the way
// the library does, so the tests assert against the polar rather than a guess.
function polarUp(tws: number): number {
  const e = polar.entries
  const f = (tws - e[0].tws) / (e[1].tws - e[0].tws)
  return e[0].upTwa + f * (e[1].upTwa - e[0].upTwa)
}
function polarDown(tws: number): number {
  const e = polar.entries
  const f = (tws - e[0].tws) / (e[1].tws - e[0].tws)
  return e[0].downTwa + f * (e[1].downTwa - e[0].downTwa)
}

describe('a % of target is absolute, a channel is fitted to the day', () => {
  // The track used to fit its ramp to whatever range the day covered, for every
  // mode. On a percentage that made red mean "the fastest you went today" on one
  // track and "a hundred per cent" on the next — while red on every TABLE in the
  // Analysis tab meant slow. One colour now means one thing across the tab.
  const rows = Array.from({ length: 60 }, (_, i) => ({
    utc: i * 1000, bsp: 8 + (i % 7) * 0.3, twa: 42, tws: 12, awa: 28, heel: 18,
  })) as never

  it('pins a percentage scale to the stops, not to the rows', () => {
    const s = scaleForRows(null, rows, 'vmg')
    // null polar still yields a scale for a pct mode: the stops do not depend on
    // the data at all, which is the point.
    expect(s?.absolute).toBe(true)
    expect(s?.lo).toBe(85)
    expect(s?.hi).toBe(110)
  })

  it('gives the same percentage the same colour on any day', () => {
    const quiet = scaleForRows(null, rows, 'target')
    const wild = scaleForRows(null, rows.slice(0, 5), 'target')
    expect(colourFor(100, quiet)).toBe(colourFor(100, wild))
    expect(colourFor(88, quiet)).toBe(colourFor(88, wild))
  })

  it('agrees with the table scale exactly', () => {
    const s = scaleForRows(null, rows, 'polbsp')
    for (const v of [80, 85, 90, 95, 100, 105, 110, 130]) {
      expect(colourFor(v, s), `${v}`).toBe(pctColour(v))
    }
  })

  it('labels the legend with the numbers that mean something', () => {
    // 85, 95, 100-ish, 105 — not five evenly-spaced samples of a fitted range,
    // which is how a legend came to read "4% 41% 77% 114% 150%".
    const labels = legendStops(scaleForRows(null, rows, 'vmg')).map(l => l.label)
    expect(labels).toContain('85%')
    expect(labels).toContain('95%')
    expect(labels).toContain('105%')
    expect(labels).not.toContain('41%')
  })

  it('leaves a CHANNEL fitted to the day, where that is the right answer', () => {
    // A whole afternoon of boat speed inside one colour tells you nothing.
    const s = scaleForRows(null, rows, 'bsp')
    expect(s?.absolute).toBeFalsy()
    expect(s!.lo).toBeGreaterThan(7)
    expect(s!.hi).toBeLessThan(11)
  })
})

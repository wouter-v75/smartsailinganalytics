// Colouring the track by a raw channel, not just by the polar. The point is RANGE:
// three colours told you whether a beat was good; a scale spent on the day's own
// spread tells you which part of it was better, which is the question a debrief asks.
import { describe, it, expect } from 'vitest'
import {
  TRACK_COLOUR_MODES, modeDef, needsPolar, trackValue, scaleForRows, colourFor,
  legendStops, rampColor, cyclicColor, sailModeOf, SAIL_MODE_COLOR, NO_DATA,
} from '../trackColour'

const row = (over: Record<string, number | null> = {}) => ({
  bsp: 9, twa: 42, tws: 12, awa: 28, aws: 18, twd: 210, heel: 20, trim: -0.8, forestay: 16, ...over,
})

describe('the modes on offer', () => {
  it('covers the channels a debrief asks about', () => {
    const keys = TRACK_COLOUR_MODES.map(m => m.key)
    for (const k of ['sailmode', 'bsp', 'awa', 'aws', 'twa', 'twd', 'tws', 'heel', 'trim', 'forestay']) {
      expect(keys).toContain(k)
    }
  })

  it('keeps the polar modes it started with', () => {
    for (const k of ['auto', 'vmg', 'polbsp', 'target']) expect(needsPolar(k as never)).toBe(true)
  })

  it('lets a channel be coloured with no polar loaded at all', () => {
    expect(needsPolar('tws')).toBe(false)
    expect(trackValue(null, row(), 'tws')).toBe(12)
  })
})

describe('trackValue', () => {
  it('reads the channel a mode names', () => {
    expect(trackValue(null, row(), 'heel')).toBe(20)
    expect(trackValue(null, row({ forestay: 21 }), 'forestay')).toBe(21)
  })

  it('treats port and starboard as one angle', () => {
    expect(trackValue(null, row({ twa: -42 }), 'twa')).toBe(42)
    expect(trackValue(null, row({ awa: -28 }), 'awa')).toBe(28)
  })

  it('keeps a direction as it is — it is not a magnitude', () => {
    expect(modeDef('twd').cyclic).toBe(true)
    expect(trackValue(null, row({ twd: 350 }), 'twd')).toBe(350)
  })

  it('reads the point of sail from the wind angle', () => {
    expect(sailModeOf(42)).toBe('up')
    expect(sailModeOf(-150)).toBe('down')
    expect(sailModeOf(95)).toBe('reach')
    expect(sailModeOf(null)).toBeNull()
  })

  it('is null for a row missing the channel, never a made-up zero', () => {
    expect(trackValue(null, row({ heel: null }), 'heel')).toBeNull()
    expect(trackValue(null, null, 'bsp')).toBeNull()
  })
})

describe('the scale comes from the day', () => {
  const rows = Array.from({ length: 100 }, (_, i) => row({ tws: 8 + i * 0.1 }))

  it('spends the ramp on the range actually sailed', () => {
    const scale = scaleForRows(null, rows, 'tws')!
    expect(scale.lo).toBeGreaterThanOrEqual(8)
    expect(scale.hi).toBeLessThanOrEqual(18)
    expect(scale.hi - scale.lo).toBeGreaterThan(5)
  })

  it('is not flattened by one rogue reading', () => {
    const withSpike = [...rows, row({ tws: 400 })]
    const scale = scaleForRows(null, withSpike, 'tws')!
    expect(scale.hi).toBeLessThan(30)
  })

  it('gives a direction the whole compass, not the day’s corner of it', () => {
    const scale = scaleForRows(null, [row({ twd: 200 }), row({ twd: 205 })], 'twd')!
    expect([scale.lo, scale.hi]).toEqual([0, 360])
  })

  it('has nothing to say about a channel the log does not carry', () => {
    expect(scaleForRows(null, [row({ heel: null }), row({ heel: null })], 'heel')).toBeNull()
  })
})

describe('colours', () => {
  it('uses the whole ramp, not three steps', () => {
    const shades = new Set([0, 0.2, 0.4, 0.6, 0.8, 1].map(rampColor))
    expect(shades.size).toBe(6)
    expect(rampColor(0)).not.toBe(rampColor(1))
  })

  it('wraps at north, so 359° and 1° look alike', () => {
    expect(cyclicColor(359)).toBe(cyclicColor(-1))
    expect(cyclicColor(0)).not.toBe(cyclicColor(180))
  })

  it('paints each point of sail its own colour', () => {
    const scale = scaleForRows(null, [row(), row({ twa: 150 })], 'sailmode')!
    expect(colourFor(trackValue(null, row(), 'sailmode'), scale)).toBe(SAIL_MODE_COLOR.up)
    expect(colourFor(trackValue(null, row({ twa: 150 }), 'sailmode'), scale)).toBe(SAIL_MODE_COLOR.down)
  })

  it('leaves a row with no reading in the no-data blue', () => {
    const scale = scaleForRows(null, [row(), row({ tws: 20 })], 'tws')
    expect(colourFor(null, scale)).toBe(NO_DATA)
    expect(colourFor(12, null)).toBe(NO_DATA)
  })

  it('clamps beyond the ends rather than running out of colour', () => {
    const scale = scaleForRows(null, [row({ tws: 10 }), row({ tws: 20 })], 'tws')!
    expect(colourFor(-50, scale)).toBe(rampColor(0))
    expect(colourFor(500, scale)).toBe(rampColor(1))
  })
})

describe('the legend', () => {
  it('names the ends and the middle of a channel scale', () => {
    const scale = scaleForRows(null, Array.from({ length: 50 }, (_, i) => row({ tws: 10 + i * 0.2 })), 'tws')!
    const stops = legendStops(scale)
    expect(stops).toHaveLength(5)
    expect(stops[0].label).toMatch(/kn$/)
    expect(stops[0].color).not.toBe(stops[4].color)
  })

  it('lists the points of sail by name', () => {
    const stops = legendStops(scaleForRows(null, [row()], 'sailmode'))
    expect(stops.map(s => s.label)).toEqual(['Upwind', 'Reaching', 'Downwind'])
  })

  it('shows the compass for a direction', () => {
    expect(legendStops(scaleForRows(null, [row()], 'twd')).map(s => s.label)).toEqual(['0°', '90°', '180°', '270°'])
  })

  it('is empty when there is nothing to colour', () => {
    expect(legendStops(null)).toEqual([])
  })
})

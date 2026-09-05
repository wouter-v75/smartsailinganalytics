import { describe, it, expect } from 'vitest'
import { flipSide, favouredSide, vmgSides, enrichCourse } from '../courseSides'
import { preparePolar } from '../../../lib/polarCalc'

// Built through the REAL preparePolar, so the entries carry the same
// upTwa/downTwa/upVMG/downVMG/bspAt that loadPolarFromLS would hand the deck.
// Boatspeed rises monotonically with TWS, so more pressure is faster on both legs.
function polarFixture() {
  const TWAS = [40, 45, 50, 60, 75, 90, 110, 120, 135, 150, 165, 180]
  const entries = [4, 6, 8, 10, 12, 14, 16, 18, 20, 25].map((tws) => ({
    tws,
    points: TWAS.map((twa) => ({ twa, bsp: 0.55 * tws * Math.sin((twa * Math.PI) / 180) ** 0.55 })),
  }))
  return preparePolar({ entries })
}

// More wind on the RIGHT looking upwind, no bend.
const pressureRight = { twd: 200, centreKt: 14, twsRight: 15.5, twsLeft: 12.5, twsLeftRight: 3.0, bendDeg: 0, bend: 'straight' }
// More wind on the LEFT looking upwind, no bend.
const pressureLeft = { ...pressureRight, twsRight: 12.5, twsLeft: 15.5, twsLeftRight: -3.0 }

// Kept as the one written record of the inversion, should the convention be
// revisited — it is no longer applied to either leg.
describe('flipSide', () => {
  it('swaps handedness and leaves Neutral/null alone', () => {
    expect(flipSide('R')).toBe('L')
    expect(flipSide('L')).toBe('R')
    expect(flipSide('Neutral')).toBe('Neutral')
    expect(flipSide(null)).toBe(null)
  })
})

describe('both legs are named in ONE frame — looking upwind', () => {
  const polar = polarFixture()

  it('upwind keeps the upwind frame: more wind right looking upwind -> R upwind', () => {
    const v = vmgSides(pressureRight, polar)!
    expect(v.up.side).toBe('R')
  })

  it('downwind does NOT flip: the same water keeps the same name on both legs', () => {
    // The crew asked for one frame across the course. Naming each leg as you face
    // it is truer to the view over the bow, but it makes the same patch of water
    // swap sides between beat and run — which costs more in a conversation than the
    // realism is worth.
    const v = vmgSides(pressureRight, polar)!
    expect(v.up.side).toBe('R')
    expect(v.dn.side).toBe('R')
  })

  it('and mirrors the other way round', () => {
    const v = vmgSides(pressureLeft, polar)!
    expect(v.up.side).toBe('L')
    expect(v.dn.side).toBe('L')
  })

  it('the downwind GAIN is untouched by the naming — only the label was ever at stake', () => {
    const v = vmgSides(pressureRight, polar)!
    expect(v.dn.gain).toBeGreaterThan(0)
  })

  it('flips the label only — the magnitude of the gain is untouched', () => {
    const v = vmgSides(pressureRight, polar)!
    expect(v.dn.gain).toBeGreaterThan(0)
    // gains come from each leg's own polar targets, so they differ between legs,
    // but neither is negated or zeroed by the relabelling
    expect(v.up.gain).toBeGreaterThan(0)
    expect(Number.isFinite(v.dn.gain)).toBe(true)
  })

  it('a bend-driven call keeps its name on the run, like a pressure-driven one', () => {
    // right bend looking upwind, no pressure split
    const bendRight = { twd: 200, centreKt: 14, twsRight: 14, twsLeft: 14, twsLeftRight: 0, bendDeg: 12, bend: 'right' }
    const v = vmgSides(bendRight, polar)!
    expect(v.up.side).toBe('R')
    expect(v.dn.side).toBe('R')
  })

  it('Neutral stays Neutral on both legs', () => {
    const even = { twd: 200, centreKt: 14, twsRight: 14, twsLeft: 14, twsLeftRight: 0, bendDeg: 0, bend: 'straight' }
    const v = vmgSides(even, polar)!
    expect(v.up.side).toBe('Neutral')
    expect(v.dn.side).toBe('Neutral')
  })
})

describe('upwind-framed signals are left alone', () => {
  it('favouredSide (the heuristic) stays in the upwind frame', () => {
    expect(favouredSide(pressureRight)).toBe('R')
    expect(favouredSide(pressureLeft)).toBe('L')
  })

  it('enrichCourse reports EVERY side looking upwind, and says so in the payload', () => {
    const e = enrichCourse(pressureRight, polarFixture())!
    expect(e.pressureSide).toBe('right')
    expect(e.fav).toBe('R')
    expect(e.favUp).toBe('R')
    expect(e.favDn).toBe('R')                 // same frame as favUp, same water
    expect(e.sideFrame.favUp).toBe('looking upwind')
    expect(e.sideFrame.favDn).toBe('looking upwind')
    // Nothing in the payload may claim a downwind frame, or the brief will mix them.
    expect(Object.values(e.sideFrame)).not.toContain('looking downwind')
  })

  it('survives with no polar: favUp/favDn are null, upwind signals still reported', () => {
    const e = enrichCourse(pressureRight, null)!
    expect(e.favUp).toBeNull()
    expect(e.favDn).toBeNull()
    expect(e.pressureSide).toBe('right')
    expect(e.fav).toBe('R')
  })
})

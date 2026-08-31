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

describe('flipSide', () => {
  it('swaps handedness and leaves Neutral/null alone', () => {
    expect(flipSide('R')).toBe('L')
    expect(flipSide('L')).toBe('R')
    expect(flipSide('Neutral')).toBe('Neutral')
    expect(flipSide(null)).toBe(null)
  })
})

describe('favoured side is named in the frame the crew is facing', () => {
  const polar = polarFixture()

  it('upwind keeps the upwind frame: more wind right looking upwind -> R upwind', () => {
    const v = vmgSides(pressureRight, polar)!
    expect(v.up.side).toBe('R')
  })

  it('downwind flips: the SAME water is L when you look downwind', () => {
    const v = vmgSides(pressureRight, polar)!
    expect(v.up.side).toBe('R')
    expect(v.dn.side).toBe('L')       // this is the behaviour that was wrong before
  })

  it('and mirrors the other way round', () => {
    const v = vmgSides(pressureLeft, polar)!
    expect(v.up.side).toBe('L')
    expect(v.dn.side).toBe('R')
  })

  it('flips the label only — the magnitude of the gain is untouched', () => {
    const v = vmgSides(pressureRight, polar)!
    expect(v.dn.gain).toBeGreaterThan(0)
    // gains come from each leg's own polar targets, so they differ between legs,
    // but neither is negated or zeroed by the relabelling
    expect(v.up.gain).toBeGreaterThan(0)
    expect(Number.isFinite(v.dn.gain)).toBe(true)
  })

  it('a bend-driven call flips for the run too', () => {
    // right bend looking upwind, no pressure split
    const bendRight = { twd: 200, centreKt: 14, twsRight: 14, twsLeft: 14, twsLeftRight: 0, bendDeg: 12, bend: 'right' }
    const v = vmgSides(bendRight, polar)!
    expect(v.up.side).toBe('R')
    expect(v.dn.side).toBe('L')
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

  it('enrichCourse reports pressureSide upwind and favDn downwind, and says which is which', () => {
    const e = enrichCourse(pressureRight, polarFixture())!
    expect(e.pressureSide).toBe('right')      // looking upwind
    expect(e.fav).toBe('R')                   // looking upwind
    expect(e.favUp).toBe('R')                 // looking upwind
    expect(e.favDn).toBe('L')                 // looking downwind — same water
    expect(e.sideFrame.favUp).toBe('looking upwind')
    expect(e.sideFrame.favDn).toBe('looking downwind')
  })

  it('survives with no polar: favUp/favDn are null, upwind signals still reported', () => {
    const e = enrichCourse(pressureRight, null)!
    expect(e.favUp).toBeNull()
    expect(e.favDn).toBeNull()
    expect(e.pressureSide).toBe('right')
    expect(e.fav).toBe('R')
  })
})

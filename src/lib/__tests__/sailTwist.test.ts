import { describe, it, expect } from 'vitest'
import {
  STATION_FRACTION, widthAt, chordAngle, stationAngles, twistBetween,
  type SailWidths,
  fitLuffSag,
} from '../sailTwist'

/** Northstar III, off the certificate: E, MHW, MTW, MUW / HLP, HHW, HTW, HUW. */
const MAIN: SailWidths = { foot: 10.33, half: 7.04, threeQuarter: 4.93, upper: 3.63 }
const JIB: SailWidths = { foot: 8.96, half: 4.90, threeQuarter: 2.66, upper: 1.48 }

describe('STATION_FRACTION', () => {
  it('knows where a stripe is because the tag says so', () => {
    expect(STATION_FRACTION.stripe25).toBe(0.25)
    expect(STATION_FRACTION.stripe50).toBe(0.5)
    expect(STATION_FRACTION.stripe75).toBe(0.75)
  })

  it('does NOT invent a fraction for a spreader', () => {
    // Where spreader 2 sits depends on the rig. Until somebody measures it there
    // is no honest fraction, so twist is declined rather than guessed.
    expect(STATION_FRACTION.spr1).toBeNull()
    expect(STATION_FRACTION.spr2).toBeNull()
    expect(STATION_FRACTION.spr3).toBeNull()
  })
})

describe('widthAt', () => {
  it('hits the certificate stations exactly, and says so', () => {
    expect(widthAt(MAIN, 0.5)).toMatchObject({ m: 7.04, source: 'certificate' })
    expect(widthAt(MAIN, 0.75)).toMatchObject({ m: 4.93, source: 'certificate' })
    expect(widthAt(MAIN, 0.875)).toMatchObject({ m: 3.63, source: 'certificate' })
    expect(widthAt(JIB, 0.5)).toMatchObject({ m: 4.90, source: 'certificate' })
  })

  it('interpolates the 25 % stripe, because no certificate carries one', () => {
    // Widths stop at 1/2. The 25 % station sits between the foot and the half
    // width and has to be interpolated — the one station that is not measured.
    const m = widthAt(MAIN, 0.25)!
    expect(m.source).toBe('interpolated')
    expect(m.m).toBeCloseTo((10.33 + 7.04) / 2, 6)
    expect(m.note).toMatch(/interpolated between 0 % and 50 %/)
  })

  it('charges more for the MAIN’s interpolation than the JIB’s, because it is worse', () => {
    // A mainsail's planform bends hard near the foot; a headsail's barely does.
    // Fitting the three upper stations and asking for the foot — where the
    // answer is known — the jib comes back 0.7 % out and the main 10 %.
    const mainSigma = widthAt(MAIN, 0.25)!.sigmaM
    const jibSigma = widthAt(JIB, 0.25)!.sigmaM
    expect(mainSigma).toBeGreaterThan(jibSigma)
    expect(mainSigma).toBeGreaterThan(0.05)
  })

  it('refuses to extrapolate past the top station', () => {
    expect(widthAt(MAIN, 0.95)).toBeNull()
  })

  it('needs two stations before it will say anything', () => {
    expect(widthAt({ foot: 10, half: null, threeQuarter: null, upper: null }, 0.25)).toBeNull()
    expect(widthAt({ foot: null, half: null, threeQuarter: null, upper: null }, 0.5)).toBeNull()
  })

  it('copes with the headsail that has a foot and nothing else measured', () => {
    const w: SailWidths = { foot: 8.96, half: 4.90, threeQuarter: null, upper: null }
    expect(widthAt(w, 0.25)!.source).toBe('interpolated')
    expect(widthAt(w, 0.5)!.source).toBe('certificate')
    expect(widthAt(w, 0.75)).toBeNull()
  })
})

describe('chordAngle', () => {
  it('turns a leech offset and a width into an angle', () => {
    const w = widthAt(JIB, 0.5)!
    const a = chordAngle(1271, 23, w)!
    expect(a.deg).toBeCloseTo(Math.asin(1271 / 4900) * 180 / Math.PI, 6)
    expect(a.deg).toBeGreaterThan(14)
    expect(a.deg).toBeLessThan(16)
  })

  it('keeps the sign, so a main above the centreline stays negative', () => {
    const w = widthAt(MAIN, 0.5)!
    expect(chordAngle(-687, 58, w)!.deg).toBeLessThan(0)
    expect(chordAngle(687, 58, w)!.deg).toBeGreaterThan(0)
  })

  it('carries about a fifth of a degree from a 25 mm click', () => {
    const a = chordAngle(1500, 25, widthAt(MAIN, 0.5)!)!
    expect(a.sigmaDeg).toBeGreaterThan(0.1)
    expect(a.sigmaDeg).toBeLessThan(0.45)
  })

  it('refuses a leech further out than the sail is wide', () => {
    // Not a measurement: a mismarked point, or the wrong sail's edge.
    expect(chordAngle(9_000, 20, widthAt(MAIN, 0.5)!)).toBeNull()
    expect(chordAngle(-9_000, 20, widthAt(MAIN, 0.5)!)).toBeNull()
  })
})

describe('fitLuffSag — most of the luff is hidden from astern', () => {
  it('fits the whole profile from ONE visible point', () => {
    // The forestay is pinned at the tack and the masthead, both on the
    // centreplane, so sag is zero at 0 and 1. One interior measurement is
    // therefore the whole curve.
    const f = fitLuffSag([{ fraction: 0.25, mm: 225 }])!
    expect(f).toBeTruthy()
    expect(f(0.25)).toBeCloseTo(225, 6)
    expect(f(0.5)).toBeCloseTo(300, 6)      // peak = 225 / (4·0.25·0.75)
    expect(f(0.75)).toBeCloseTo(225, 6)
  })

  it('pins both ends at zero', () => {
    const f = fitLuffSag([{ fraction: 0.5, mm: 300 }])!
    expect(f(0)).toBeCloseTo(0, 9)
    expect(f(1)).toBeCloseTo(0, 9)
  })

  it('uses two visible points as two, not one', () => {
    // Least squares, so a second station improves the fit rather than replacing
    // the first. Perfectly parabolic input comes back exactly.
    const f = fitLuffSag([{ fraction: 0.25, mm: 225 }, { fraction: 0.5, mm: 300 }])!
    expect(f(0.5)).toBeCloseTo(300, 6)
    // Inconsistent input lands between them rather than on either.
    const g = fitLuffSag([{ fraction: 0.25, mm: 225 }, { fraction: 0.5, mm: 200 }])!
    expect(g(0.5)).toBeGreaterThan(200)
    expect(g(0.5)).toBeLessThan(300)
  })

  it('keeps the sign, so sag to windward would come back negative', () => {
    expect(fitLuffSag([{ fraction: 0.5, mm: -300 }])!(0.5)).toBeCloseTo(-300, 6)
  })

  it('declines when there is nothing interior to fit', () => {
    expect(fitLuffSag([])).toBeNull()
    // the ends carry no information: they are zero by construction
    expect(fitLuffSag([{ fraction: 0, mm: 0 }, { fraction: 1, mm: 0 }])).toBeNull()
  })

  it('the profile SHAPE barely matters next to measuring it at all', () => {
    // Same measured point at 25 %, parabola vs half-sine. The two disagree by
    // far less than the error of assuming no sag — which is the whole reason a
    // crude pinned parabola is good enough.
    const measured = 200
    const parab = fitLuffSag([{ fraction: 0.25, mm: measured }])!
    const sinePeak = measured / Math.sin(Math.PI * 0.25)
    const sine = (f: number) => sinePeak * Math.sin(Math.PI * f)
    expect(Math.abs(parab(0.5) - sine(0.5))).toBeLessThan(0.12 * Math.abs(parab(0.5)))
    // …while assuming zero is 100 % out.
    expect(Math.abs(parab(0.5))).toBeGreaterThan(200)
  })
})

describe('twist', () => {
  /** The 13:49:33 frame's own jib numbers. */
  const JIB_LEECH = [
    { tag: 'stripe25' as const, mm: 1003, sigmaMm: 21 },
    { tag: 'stripe50' as const, mm: 1271, sigmaMm: 23 },
  ]

  it('reproduces the 4 Sept frame: the jib opens 6.7° between 25 % and 50 %', () => {
    const ang = stationAngles('jib', JIB, JIB_LEECH)
    expect(ang.map((a) => a.tag)).toEqual(['stripe25', 'stripe50'])
    expect(ang[0].angle.deg).toBeCloseTo(8.32, 1)
    expect(ang[1].angle.deg).toBeCloseTo(15.04, 1)

    const t = twistBetween(ang)
    expect(t).toHaveLength(1)
    expect(t[0].twistDeg).toBeCloseTo(6.72, 1)
    // ~0.3°, which is the territory the lidar reports in.
    expect(t[0].sigmaDeg).toBeLessThan(0.5)
    expect(t[0].interpolated).toBe(true)       // the 25 % width was interpolated
  })

  it('declines a station measured at a spreader rather than guessing its height', () => {
    // The 4 Sept frame's only MAIN measurement was at spreader 1, which has no
    // canonical fraction — so there is no main twist from that frame, and the
    // tool says nothing rather than something.
    expect(stationAngles('main', MAIN, [{ tag: 'spr1', mm: -687, sigmaMm: 58 }])).toEqual([])
  })

  it('sorts by height and pairs adjacent stations, lowest first', () => {
    const ang = stationAngles('main', MAIN, [
      { tag: 'stripe75', mm: 2_200, sigmaMm: 30 },
      { tag: 'stripe25', mm: 1_200, sigmaMm: 30 },
      { tag: 'stripe50', mm: 1_800, sigmaMm: 30 },
    ])
    expect(ang.map((a) => a.tag)).toEqual(['stripe25', 'stripe50', 'stripe75'])
    const t = twistBetween(ang)
    expect(t.map((x) => [x.from, x.to])).toEqual([
      ['stripe25', 'stripe50'], ['stripe50', 'stripe75'],
    ])
    // Each step opens further: the offsets grow AND the widths shrink, so the
    // angle grows twice over. That is what twist looks like.
    expect(t.every((x) => x.twistDeg > 0)).toBe(true)
  })

  it('reads twist the same way on either tack', () => {
    // The measurements are leeward-positive, so a mirrored set — the same trim
    // on the other tack — gives the same twist, not its negative.
    const stbd = twistBetween(stationAngles('jib', JIB, JIB_LEECH))
    const port = twistBetween(stationAngles('jib', JIB,
      JIB_LEECH.map((l) => ({ ...l, mm: -l.mm }))))
    expect(port[0].twistDeg).toBeCloseTo(stbd[0].twistDeg, 9)
  })

  it('gives nothing, rather than nonsense, with one station', () => {
    expect(twistBetween(stationAngles('jib', JIB, [JIB_LEECH[0]]))).toEqual([])
    expect(twistBetween([])).toEqual([])
  })
})

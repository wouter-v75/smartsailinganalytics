// src/lib/__tests__/sailTrimLidar.test.ts
import { describe, it, expect } from 'vitest'
import {
  photoInstantMs, phaseAt, angleRows, twistRows, agrees, LIDAR_SIGMA_DEG,
  lidarCell, phaseHasLidar, lidarAppliesTo, LIDAR_CHANNEL,
} from '../sailTrimLidar'
import type { PhaseStat } from '../phaseStats'
import type { SailTrimAnnotation } from '../sailTrimOverlay'

const phase = (utc: number, mean: Record<string, number>): PhaseStat => ({
  utc, endUtc: utc + 30_000, mode: 'up', tack: 'stbd', sails: [], sailCombo: 'J1',
  race: 1, n: 30, mean, max: {},
})

const annotation = (over: Partial<SailTrimAnnotation> = {}): SailTrimAnnotation => ({
  version: 'v', imageSize: { w: 6000, h: 4000 }, defn: 'boat',
  axis: { low: { x: 0, y: 0 }, high: { x: 0, y: 1 } },
  targets: [], psiDeg: 0, psiMeasured: true, heelDeg: 22, measuredAt: 1,
  ...over,
})

const chord = (sail: 'main' | 'jib', tag: string, angleDeg: number, angleSigmaDeg = 0.3) => ({
  sail, tag, fraction: 0.5, chordMm: 1000, widthM: 7.04,
  widthSource: 'certificate' as const, angleDeg, angleSigmaDeg, luffMm: null,
})

describe('photoInstantMs — the clocks trap', () => {
  it('reads a zoned stamp as written', () => {
    expect(photoInstantMs('2026-09-26T10:36:42Z')).toBe(Date.parse('2026-09-26T10:36:42Z'))
  })

  it('treats a stamp with NO zone as UTC, not as venue-local', () => {
    // Date.parse would call this local time, shifting the whole day by the venue
    // offset and matching every photo to a phase two hours away.
    expect(photoInstantMs('2026-09-26 10:36:42')).toBe(Date.parse('2026-09-26T10:36:42Z'))
    expect(photoInstantMs('2026-09-26T10:36:42')).toBe(Date.parse('2026-09-26T10:36:42Z'))
  })

  it('leaves an explicit offset alone', () => {
    expect(photoInstantMs('2026-09-26T12:36:42+02:00')).toBe(Date.parse('2026-09-26T10:36:42Z'))
  })

  it('passes epoch milliseconds through, and refuses nonsense', () => {
    expect(photoInstantMs(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(photoInstantMs(null)).toBeNull()
    expect(photoInstantMs('')).toBeNull()
    expect(photoInstantMs('not a date')).toBeNull()
  })
})

describe('phaseAt', () => {
  const ps = [phase(1_000_000, { mnTw25: 1 }), phase(1_100_000, { mnTw25: 2 }), phase(1_200_000, { mnTw25: 3 })]

  it('finds the phase the shutter fired inside, with no gap', () => {
    const m = phaseAt(ps, 1_100_015)!
    expect(m.gapMs).toBe(0)
    expect(m.phase.mean.mnTw25).toBe(2)
  })

  it('takes the boundaries as inside', () => {
    expect(phaseAt(ps, 1_100_000)!.gapMs).toBe(0)
    expect(phaseAt(ps, 1_130_000)!.gapMs).toBe(0)
  })

  it('returns the nearest phase AND the gap, so the caller can refuse it', () => {
    // A photo minutes from the nearest phase is a different piece of sailing:
    // the sheet and traveller have moved, so a disagreement would be trim.
    const m = phaseAt(ps, 1_500_000)!
    expect(m.phase.mean.mnTw25).toBe(3)
    expect(m.gapMs).toBe(1_500_000 - 1_230_000)
  })

  it('has nothing to say about an empty day', () => {
    expect(phaseAt([], 1_000_000)).toBeNull()
  })
})

describe('angleRows — the absolute comparison', () => {
  const a = annotation({ chords: [chord('main', 'stripe25', 3.2), chord('main', 'stripe75', 9.9)] })

  it('puts each stripe beside the lidar twist at the same height', () => {
    const rows = angleRows(a, phase(0, { mnTw25: 3.0, mnTw75: 9.4 }))
    expect(rows.map((r) => [r.height, r.lidarDeg, Number(r.diffDeg!.toFixed(2))]))
      .toEqual([[25, 3.0, 0.2], [75, 9.4, 0.5]])
  })

  it('says nothing rather than zero when the lidar has no channel there', () => {
    const rows = angleRows(a, phase(0, { mnTw25: 3.0 }))
    expect(rows[1].lidarDeg).toBeNull()
    expect(rows[1].diffDeg).toBeNull()
  })

  it('skips a station the lidar does not report — 87 % has no channel', () => {
    const rows = angleRows(annotation({ chords: [chord('main', 'stripe87', 12)] }), phase(0, {}))
    expect(rows).toHaveLength(0)
  })
})

describe('twistRows — the comparison that survives not knowing the convention', () => {
  const a = annotation({
    twist: [{ sail: 'main', from: 'stripe25', to: 'stripe75', twistDeg: 6.72, sigmaDeg: 0.34, interpolated: false }],
  })

  it('differences the lidar heights, so a shared zero cancels', () => {
    const rows = twistRows(a, phase(0, { mnTw25: 3.0, mnTw75: 9.4 }))
    expect(rows[0].lidarDeg).toBeCloseTo(6.4, 10)
    expect(rows[0].diffDeg).toBeCloseTo(0.32, 10)
  })

  it('is unmoved by an offset applied to BOTH heights — the whole point', () => {
    // If KND counts its zero from the boom and SailTrim from the centreplane,
    // every absolute reading shifts and the difference does not.
    const plain = twistRows(a, phase(0, { mnTw25: 3.0, mnTw75: 9.4 }))[0]
    const shifted = twistRows(a, phase(0, { mnTw25: 8.0, mnTw75: 14.4 }))[0]
    expect(shifted.lidarDeg).toBeCloseTo(plain.lidarDeg!, 10)
    expect(shifted.diffDeg).toBeCloseTo(plain.diffDeg!, 10)
  })

  it('needs both heights before it will say anything', () => {
    expect(twistRows(a, phase(0, { mnTw25: 3.0 }))[0].lidarDeg).toBeNull()
    expect(twistRows(a, null)[0].lidarDeg).toBeNull()
  })

  it('carries the interpolated flag, since an interpolated width is a guess', () => {
    const interp = annotation({
      twist: [{ sail: 'jib', from: 'stripe25', to: 'stripe50', twistDeg: 4, sigmaDeg: 0.5, interpolated: true }],
    })
    expect(twistRows(interp, phase(0, { jibTw25: 1, jibTw50: 5 }))[0].interpolated).toBe(true)
  })
})

describe('agrees', () => {
  it('calls the 27 Sep pair consistent: 6.72 ±0.34 against 5.69', () => {
    // 1.03 apart, against 2σ of hypot(0.34, 0.8) = 1.74.
    expect(agrees(0.34, 6.72 - 5.69)).toBe(true)
  })

  it('calls a frank disagreement a disagreement', () => {
    expect(agrees(0.34, 4.0)).toBe(false)
  })

  it('says nothing when there is no lidar to compare with', () => {
    expect(agrees(0.34, null)).toBeNull()
  })

  it('states the lidar sigma it is standing in with, because it is a stand-in', () => {
    expect(LIDAR_SIGMA_DEG).toBe(0.8)
  })
})


describe('the card columns', () => {
  const p = phase(0, { mnTw50: 9.4, mnCa50: 11.2, mnDr50: 47.5, jibTw50: 6.1 })

  it('puts DEPTH beside Ca, never Dr', () => {
    // The card's "Draft" column is camberPct — the sail's DEPTH as a percent of
    // chord, which KND calls CA. Its DR is WHERE that depth peaks, measured from
    // the luff, and the two differ by roughly a factor of five: 11.2 % against
    // 47.5 % here. Beside camberPct, Dr would read as a catastrophe and mean
    // nothing at all.
    expect(LIDAR_CHANNEL.depth).toBe('Ca')
    expect(lidarCell(p, 'main', 'stripe50', 'depth')).toBe(11.2)
    expect(lidarCell(p, 'main', 'stripe50', 'peak')).toBe(47.5)
  })

  it('reads twist per sail and stripe', () => {
    expect(lidarCell(p, 'main', 'stripe50', 'twist')).toBe(9.4)
    expect(lidarCell(p, 'jib', 'stripe50', 'twist')).toBe(6.1)
  })

  it('has nothing for a stripe or a sail the lidar does not cover', () => {
    expect(lidarCell(p, 'main', 'stripe87', 'twist')).toBeNull()
    expect(lidarCell(p, 'main', 'clew', 'twist')).toBeNull()
    expect(lidarCell(p, 'spinnaker', 'stripe50', 'twist')).toBeNull()
    expect(lidarCell(null, 'main', 'stripe50', 'twist')).toBeNull()
  })
})

describe('phaseHasLidar — no columns rather than a column of dashes', () => {
  it('is true for a phase carrying any sail-shape channel', () => {
    expect(phaseHasLidar(phase(0, { mnTw25: 3 }))).toBe(true)
    expect(phaseHasLidar(phase(0, { jibCa75: 9 }))).toBe(true)
  })

  it('is false for a boat with no lidar, whatever else it logged', () => {
    // A rival, or our own boat on a day the unit was off. Columns of dashes
    // read as a missing measurement; no columns read as no equipment.
    expect(phaseHasLidar(phase(0, { tws: 12.4, bsp: 9.1, heel: 22 }))).toBe(false)
    expect(phaseHasLidar(phase(0, {}))).toBe(false)
    expect(phaseHasLidar(null)).toBe(false)
  })

  it('is not fooled by a target channel or a stray name', () => {
    expect(phaseHasLidar(phase(0, { mnTw: 3 }))).toBe(false)
    expect(phaseHasLidar(phase(0, { somethingTw25: 3 }))).toBe(false)
  })
})

describe('lidarAppliesTo — our lidar describes OUR rig', () => {
  it('matches our own boat, ignoring case and stray spaces', () => {
    expect(lidarAppliesTo('Northstar 76', 'northstar 76')).toBe(true)
    expect(lidarAppliesTo(' Northstar 76 ', 'Northstar 76')).toBe(true)
  })

  it('refuses a rival — that would be two boats in one table', () => {
    expect(lidarAppliesTo('Capricorno', 'Northstar 76')).toBe(false)
  })

  it('refuses when either side is unknown, rather than assuming', () => {
    expect(lidarAppliesTo(null, 'Northstar 76')).toBe(false)
    expect(lidarAppliesTo('Northstar 76', null)).toBe(false)
    expect(lidarAppliesTo('', '')).toBe(false)
  })
})

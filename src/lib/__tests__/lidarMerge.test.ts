import { describe, it, expect } from 'vitest'
import { carryLidar, mergeStoredLidar, addLidar } from '../lidarMerge'
import type { StoredPhase } from '../seasonCurves'
import type { PhaseStat } from '../phaseStats'

const sp = (u: number, v: Record<string, number>, x: Record<string, number> = {}): StoredPhase =>
  ({ u, e: u + 30, m: 'up', t: 'stbd', s: 'J4', r: 1, n: 30, v, x }) as StoredPhase
const st = (utc: number, mean: Record<string, number>): PhaseStat =>
  ({ utc, endUtc: utc + 30, mode: 'up', tack: 'stbd', sails: [], sailCombo: 'J4', race: 1, n: 30, mean, max: {} })

describe('carryLidar', () => {
  it('keeps the lidar of replaced phases when the new ones have none', () => {
    const old = [sp(0, { bsp: 10, mnCa25: 8, tMnCa25: 5 }, { mnCa25: 9 }), sp(30, { bsp: 10 })]
    const out = carryLidar([sp(0, { bsp: 11 }), sp(30, { bsp: 12 }), sp(60, { bsp: 13 })], old)
    expect(out[0].v).toEqual({ bsp: 11, mnCa25: 8, tMnCa25: 5 })
    expect(out[0].x).toEqual({ mnCa25: 9 })
    expect(out[1].v).toEqual({ bsp: 12 })
    expect(out[2].v).toEqual({ bsp: 13 })
  })

  it('leaves phases that bring their own lidar alone', () => {
    const out = carryLidar([sp(0, { mnCa25: 7 })], [sp(0, { mnCa25: 8, jibCa25: 11 })])
    expect(out[0].v).toEqual({ mnCa25: 7 })
  })
})

describe('mergeStoredLidar', () => {
  it('adds stored lidar to phases computed from a log without it', () => {
    const out = mergeStoredLidar([st(0, { bsp: 10 }), st(30, { bsp: 11 })], [sp(30, { bsp: 9, jibDr50: 42 })])
    expect(out[0].mean).toEqual({ bsp: 10 })
    expect(out[1].mean).toEqual({ bsp: 11, jibDr50: 42 })
  })

  it('does nothing when the computed stats already carry lidar', () => {
    const stats = [st(0, { mnCa25: 7 })]
    expect(mergeStoredLidar(stats, [sp(0, { mnCa25: 8 })])).toBe(stats)
  })
})

describe('addLidar', () => {
  it('puts a start-window log’s lidar into the day’s phases it overlaps, replacing older lidar', () => {
    const day = [sp(0, { bsp: 10, mnCa25: 1 }), sp(30, { bsp: 11 }), sp(60, { bsp: 12 })]
    const { phases, merged } = addLidar(day, [sp(30, { bsp: 99, mnCa25: 8, tMnCa25: 5 }), sp(0, { bsp: 98, jibCa25: 12 }), sp(90, { mnCa25: 3 })])
    expect(merged).toBe(2)
    expect(phases[0].v).toEqual({ bsp: 10, jibCa25: 12 })        // day values kept, lidar replaced
    expect(phases[1].v).toEqual({ bsp: 11, mnCa25: 8, tMnCa25: 5 })
    expect(phases[2].v).toEqual({ bsp: 12 })
  })
})

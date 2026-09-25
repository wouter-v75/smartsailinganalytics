import { describe, it, expect } from 'vitest'
import { groupBursts } from '../burstGroup'

const at = (s: number) => ({ id: `t${s}`, t: s * 1000 })
const T = (x: { t: number }) => x.t
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

describe('groupBursts', () => {
  it('keeps frames more than the gap apart as separate bursts', () => {
    const g = groupBursts([at(0), at(20), at(40)], T, 10_000)
    expect(g).toHaveLength(3)
    expect(g.every((b) => b.frames.length === 1)).toBe(true)
    expect(ids(g.map((b) => b.lead))).toEqual(['t0', 't20', 't40'])
  })

  it('collapses a burst to its MIDDLE frame', () => {
    const g = groupBursts([at(0), at(1), at(2), at(3), at(4)], T, 10_000)
    expect(g).toHaveLength(1)
    expect(g[0].frames).toHaveLength(5)
    expect(g[0].lead.id).toBe('t2')
    expect(g[0].leadIndex).toBe(2)
    expect(g[0].t0).toBe(0)
    expect(g[0].t1).toBe(4000)
  })

  it('picks a definite middle for an even count', () => {
    const g = groupBursts([at(0), at(1), at(2), at(3)], T, 10_000)
    expect(g[0].lead.id).toBe('t1')
    expect(g[0].frames[g[0].leadIndex].id).toBe('t1')
  })

  it('chains: a steady sequence is ONE burst however far it runs', () => {
    // Nine seconds between every frame, forty frames — six minutes of continuous
    // shooting. Fixed windows would chop this into arbitrary pieces.
    const seq = Array.from({ length: 40 }, (_, i) => at(i * 9))
    const g = groupBursts(seq, T, 10_000)
    expect(g).toHaveLength(1)
    expect(g[0].frames).toHaveLength(40)
  })

  it('breaks the moment a gap exceeds the threshold', () => {
    const g = groupBursts([at(0), at(5), at(10), at(21), at(25)], T, 10_000)
    expect(g).toHaveLength(2)
    expect(ids(g[0].frames)).toEqual(['t0', 't5', 't10'])
    expect(ids(g[1].frames)).toEqual(['t21', 't25'])
  })

  it('treats a gap of exactly the threshold as the same burst', () => {
    expect(groupBursts([at(0), at(10)], T, 10_000)).toHaveLength(1)
    expect(groupBursts([at(0), at(11)], T, 10_000)).toHaveLength(2)
  })

  it('sorts first, so an unordered list groups the same way', () => {
    const g = groupBursts([at(4), at(0), at(2), at(40), at(1), at(3)], T, 10_000)
    expect(g).toHaveLength(2)
    expect(ids(g[0].frames)).toEqual(['t0', 't1', 't2', 't3', 't4'])
    expect(g[0].lead.id).toBe('t2')
  })

  it('drops items with no usable time rather than grouping them at zero', () => {
    const g = groupBursts(
      [at(0), { id: 'bad', t: NaN }, at(40)] as { id: string; t: number }[], T, 10_000)
    expect(g).toHaveLength(2)
    expect(ids(g.flatMap((b) => b.frames))).toEqual(['t0', 't40'])
  })

  it('returns nothing for nothing', () => {
    expect(groupBursts([], T, 10_000)).toEqual([])
  })

  it('reproduces 2026-09-04: 61 photographs, 21 bursts, the two big ones intact', () => {
    // The real shape, from the database: singles scattered through the morning,
    // then 17 frames in five seconds and 24 in three.
    const singles = [9 * 3600 + 34 * 60 + 21, 9 * 3600 + 42 * 60 + 40, 9 * 3600 + 42 * 60 + 52]
      .map((s) => at(s))
    const burstA = Array.from({ length: 17 }, (_, i) => at(11 * 3600 + 49 * 60 + 31 + Math.floor(i / 3.4)))
    const burstB = Array.from({ length: 24 }, (_, i) => at(11 * 3600 + 50 * 60 + 16 + Math.floor(i / 8)))
    const g = groupBursts([...singles, ...burstA, ...burstB], T, 10_000)
    expect(g).toHaveLength(5)                       // 3 singles + 2 bursts
    const big = g.filter((b) => b.frames.length > 1)
    expect(big.map((b) => b.frames.length)).toEqual([17, 24])
    // Each burst is represented by a frame from its own middle, not an end.
    for (const b of big) {
      expect(b.leadIndex).toBeGreaterThan(0)
      expect(b.leadIndex).toBeLessThan(b.frames.length - 1)
    }
  })
})

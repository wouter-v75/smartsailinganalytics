// src/components/boat/__tests__/LidarPhaseCard.test.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The two pieces of judgement in the card: WHICH phases a button stands for,
// and how a set of them is averaged. The rest is a table.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { meanOf, phasesFor, byMode, MODES } from '../LidarPhaseCard'
import { twsBand } from '@/lib/sailMedia'
import type { PhaseStat } from '@/lib/phaseStats'

const phase = (tws: number | null, mean: Record<string, number> = {}, mode: PhaseStat['mode'] = 'up'): PhaseStat => ({
  utc: 0, endUtc: 30_000, mode, tack: 'stbd', sails: [], sailCombo: 'J2',
  race: 1, n: 30, mean: { ...(tws == null ? {} : { tws }), ...mean }, max: {},
})

describe('meanOf', () => {
  it('averages what is there', () => {
    expect(meanOf([9, 10, 11])).toBe(10)
  })

  it('ignores gaps rather than counting them as zero', () => {
    // A phase whose channel dropped out must not drag the average down; it is
    // a missing sample, not a measurement of nothing.
    expect(meanOf([10, null, undefined, 12])).toBe(11)
  })

  it('says nothing when there is nothing', () => {
    expect(meanOf([])).toBeNull()
    expect(meanOf([null, undefined])).toBeNull()
    expect(meanOf([NaN])).toBeNull()
  })
})

describe('phasesFor — what one button stands for', () => {
  const band12 = twsBand(12).key
  const band18 = twsBand(18).key

  it('takes the phases in that band carrying that sail', () => {
    const all = [
      phase(12, { jibTw50: 6.1 }),
      phase(12, { jibTw50: 6.4 }),
      phase(18, { jibTw50: 9.0 }),          // wrong band
      phase(12, { mnTw50: 9.9 }),           // wrong sail
      phase(12, {}),                        // no lidar at all
    ]
    expect(phasesFor(all, 'jib', band12)).toHaveLength(2)
    expect(phasesFor(all, 'jib', band18)).toHaveLength(1)
    expect(phasesFor(all, 'mn', band12)).toHaveLength(1)
  })

  it('accepts a phase carrying any of camber, draft or twist', () => {
    // A head that reported camber but not twist still measured the sail.
    expect(phasesFor([phase(12, { jibCa25: 11 })], 'jib', band12)).toHaveLength(1)
    expect(phasesFor([phase(12, { jibDr75: 46 })], 'jib', band12)).toHaveLength(1)
  })

  it('keeps the unknown-wind band separate rather than folding it into a real one', () => {
    const all = [phase(null, { jibTw50: 6.1 }), phase(12, { jibTw50: 6.4 })]
    expect(phasesFor(all, 'jib', twsBand(null).key)).toHaveLength(1)
    expect(phasesFor(all, 'jib', band12)).toHaveLength(1)
  })

  it('is not fooled by a TARGET channel with no measurement behind it', () => {
    // tJibTw50 is what the trimmer was aiming at, not what the sail did.
    expect(phasesFor([phase(12, { tJibTw50: 6.0 })], 'jib', band12)).toHaveLength(0)
  })
})


describe('byMode — one average across a day is three sails averaged together', () => {
  it('splits upwind, reaching and downwind, in that order', () => {
    const all = [
      phase(12, { jibTw50: 6 }, 'down'),
      phase(12, { jibTw50: 5 }, 'up'),
      phase(12, { jibTw50: 8 }, 'reach'),
      phase(12, { jibTw50: 7 }, 'up'),
    ]
    const out = byMode(all)
    expect(out.map((g) => g.mode)).toEqual(['up', 'reach', 'down'])
    expect(out[0].phases).toHaveLength(2)
  })

  it('leaves out a leg nobody sailed rather than showing it empty', () => {
    // Three dashes read as an instrument that failed; an absent heading reads
    // as a leg that did not happen, which is what it is.
    const out = byMode([phase(12, { jibTw50: 6 }, 'up')])
    expect(out.map((g) => g.mode)).toEqual(['up'])
  })

  it('averages within a mode, not across them', () => {
    // The whole point: 5 and 7 upwind is 6, and the 20 downwind must not touch it.
    const all = [
      phase(12, { jibTw50: 5 }, 'up'),
      phase(12, { jibTw50: 7 }, 'up'),
      phase(12, { jibTw50: 20 }, 'down'),
    ]
    const up = byMode(all).find((g) => g.mode === 'up')!
    expect(meanOf(up.phases.map((p) => p.mean.jibTw50))).toBe(6)
  })

  it('covers every mode the phase stats can produce', () => {
    // A mode missing here would silently drop its phases out of the card.
    expect(MODES.map((m) => m.mode).sort()).toEqual(['down', 'reach', 'up'])
  })

  it('has nothing to say about an empty set', () => {
    expect(byMode([])).toEqual([])
  })
})

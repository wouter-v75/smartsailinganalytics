// src/components/boat/__tests__/LidarPhaseCard.test.tsx
// ─────────────────────────────────────────────────────────────────────────────
// The two pieces of judgement in the card: WHICH phases a button stands for,
// and how a set of them is averaged. The rest is a table.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { meanOf, phasesFor } from '../LidarPhaseCard'
import { twsBand } from '@/lib/sailMedia'
import type { PhaseStat } from '@/lib/phaseStats'

const phase = (tws: number | null, mean: Record<string, number> = {}): PhaseStat => ({
  utc: 0, endUtc: 30_000, mode: 'up', tack: 'stbd', sails: [], sailCombo: 'J2',
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

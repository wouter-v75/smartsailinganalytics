import { describe, it, expect } from 'vitest'
import { battenCardFor, type SailContext } from '../sailChangeDetail.helpers'
import { normaliseBattenCard, type SailBattenCard } from '@/lib/battens'
import type { SailState } from '@/lib/tagging/sailState'

// Which main's card the batten tab shows.
//
// This is the decision the per-sail change created, and it is the one that can
// be quietly wrong: a card that describes the OTHER main still renders as a
// confident "→ stiff +2", and nothing on screen looks broken.

const card = (tension: string, turns: number) =>
  normaliseBattenCard({ count: 3, rows: [{ '10-15': { tension, turns } }, {}, {}] })

const RACE = card('stiff', 2)
const DELIVERY = card('soft', -1)

const ctx = (over: Partial<SailContext> = {}): SailContext => ({
  inventory: [
    { id: 'm1', name: 'Main 2026' },
    { id: 'm2', name: 'Delivery main' },
    { id: 'j1', name: 'J2' },
  ],
  mainsailIds: ['m1', 'm2'],
  onBoard: [],
  battenCards: [],
  loading: false,
  ...over,
})

const up = (...ids: string[]): SailState => ({
  up: ids.map((id) => ({ id, name: id })),
  battens: [],
})

const cards = (...list: SailBattenCard[]) => list

describe('battenCardFor', () => {
  it('shows the card of the main that is up', () => {
    const c = ctx({ battenCards: cards(
      { sailId: 'm1', card: RACE, updatedAt: null },
      { sailId: 'm2', card: DELIVERY, updatedAt: null },
    ) })
    expect(battenCardFor(c, up('m1', 'j1')).card?.rows[0]['10-15'].tension).toBe('stiff')
    expect(battenCardFor(c, up('m2', 'j1')).card?.rows[0]['10-15'].tension).toBe('soft')
  })

  it('names the sail, so the crew can see whose card it is', () => {
    const c = ctx({ battenCards: cards({ sailId: 'm2', card: DELIVERY, updatedAt: null }) })
    expect(battenCardFor(c, up('m2')).sailName).toBe('m2')
  })

  it('ignores the headsails — only a main has battens on this card', () => {
    const c = ctx({ battenCards: cards({ sailId: 'm1', card: RACE, updatedAt: null }) })
    // J2 is up and no main is; the boat has exactly one card, so that is the
    // only possible answer.
    expect(battenCardFor(c, up('j1')).card).toBe(RACE)
  })

  it('falls back to the boat’s only card when nothing is up yet', () => {
    const c = ctx({ battenCards: cards({ sailId: 'm1', card: RACE, updatedAt: null }) })
    const out = battenCardFor(c, up())
    expect(out.card).toBe(RACE)
    expect(out.sailName).toBe('Main 2026')
  })

  it('shows NOTHING rather than a guess when two mains have cards and neither is up', () => {
    // The important one. A plausible-looking wrong number is worse than none:
    // it reads as an answer and gets wound onto the sail.
    const c = ctx({ battenCards: cards(
      { sailId: 'm1', card: RACE, updatedAt: null },
      { sailId: 'm2', card: DELIVERY, updatedAt: null },
    ) })
    expect(battenCardFor(c, up('j1')).card).toBeNull()
    expect(battenCardFor(c, up()).card).toBeNull()
  })

  it('does not offer the unassigned card to a main that has none', () => {
    // It would attach a three-season delivery main's numbers to a brand-new
    // sail. Adopting it is a decision, and it is made in Boat → Battens.
    const c = ctx({ battenCards: cards({ sailId: null, card: DELIVERY, updatedAt: null }) })
    expect(battenCardFor(c, up('m1')).card).toBeNull()
  })

  it('prefers the up main’s own card over the boat’s only other one', () => {
    const c = ctx({ battenCards: cards(
      { sailId: 'm2', card: DELIVERY, updatedAt: null },
    ) })
    // m1 is up and has no card; m2's is the boat's only one, so it is shown —
    // but named as m2's, never as m1's.
    const out = battenCardFor(c, up('m1'))
    expect(out.card).toBe(DELIVERY)
    expect(out.sailName).toBe('Delivery main')
  })

  it('has nothing to show for a boat with no cards at all', () => {
    expect(battenCardFor(ctx(), up('m1')).card).toBeNull()
  })

  it('ignores a sail that is up by name only — a card needs an inventory id', () => {
    const c = ctx({ battenCards: cards({ sailId: 'm1', card: RACE, updatedAt: null }) })
    const typed: SailState = { up: [{ name: 'Some main' }], battens: [] }
    // No id to match on, so it lands on the single-card fallback rather than
    // guessing that a typed name is m1.
    expect(battenCardFor(c, typed).card).toBe(RACE)
    expect(battenCardFor(c, typed).sailName).toBe('Main 2026')
  })
})

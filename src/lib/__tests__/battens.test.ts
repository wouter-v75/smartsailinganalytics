import { describe, it, expect } from 'vitest'
import {
  WIND_BANDS, TENSIONS, DEFAULT_BATTEN_COUNT, MAX_BATTEN_COUNT,
  defaultBattenCard, normaliseBattenCard, setBattenCount,
  bandForTws, cardSetting, formatSetting, isBlankSetting, cardIsEmpty,
  cardForSail, unassignedCard, type SailBattenCard,
} from '../battens'

describe('the bands', () => {
  it('are the six the card uses, in order', () => {
    expect(WIND_BANDS.map((b) => b.label)).toEqual(['0–5', '5–10', '10–15', '15–20', '20–25', '25+'])
  })

  it('leave no gap and no overlap', () => {
    for (let i = 1; i < WIND_BANDS.length; i++) {
      expect(WIND_BANDS[i].minKn).toBe(WIND_BANDS[i - 1].maxKn)
    }
    expect(WIND_BANDS[WIND_BANDS.length - 1].maxKn).toBeNull()
  })
})

describe('bandForTws', () => {
  it('puts a boundary reading in the band it opens', () => {
    expect(bandForTws(5)?.key).toBe('5-10')
    expect(bandForTws(4.99)?.key).toBe('0-5')
    expect(bandForTws(25)?.key).toBe('25+')
  })

  it('has somewhere to put a gale', () => {
    expect(bandForTws(48)?.key).toBe('25+')
  })

  it('returns nothing when there is no wind reading, rather than guessing 0–5', () => {
    for (const bad of [null, undefined, NaN, -1, 'twelve' as unknown as number]) {
      expect(bandForTws(bad)).toBeNull()
    }
  })
})

describe('defaultBattenCard', () => {
  it('is three battens unless told otherwise', () => {
    expect(defaultBattenCard().count).toBe(DEFAULT_BATTEN_COUNT)
    expect(defaultBattenCard().rows).toHaveLength(3)
  })

  it('clamps a silly count rather than making 900 rows', () => {
    expect(defaultBattenCard(999).count).toBe(MAX_BATTEN_COUNT)
    expect(defaultBattenCard(0).count).toBe(DEFAULT_BATTEN_COUNT)
    expect(defaultBattenCard(-4).count).toBe(1)
  })
})

describe('normaliseBattenCard', () => {
  it('reads a stored card back', () => {
    const card = normaliseBattenCard({
      count: 2,
      rows: [{ '0-5': { tension: 'soft', turns: 5 } }, { '25+': { tension: 'stiff', turns: -2 } }],
    })
    expect(card.count).toBe(2)
    expect(card.rows[0]['0-5']).toEqual({ tension: 'soft', turns: 5 })
    expect(card.rows[1]['25+']).toEqual({ tension: 'stiff', turns: -2 })
  })

  it('keeps negative turns — winding a batten OFF is a real setting', () => {
    const card = normaliseBattenCard({ count: 1, rows: [{ '10-15': { tension: 'medium', turns: -3 } }] })
    expect(card.rows[0]['10-15'].turns).toBe(-3)
  })

  it('never drops a batten because the stored count went stale', () => {
    const card = normaliseBattenCard({
      count: 3,
      rows: [{}, {}, {}, { '0-5': { tension: 'soft', turns: 1 } }],
    })
    expect(card.count).toBe(4)
    expect(card.rows[3]['0-5']).toEqual({ tension: 'soft', turns: 1 })
  })

  it('throws away a stiffness it does not recognise but keeps the turns', () => {
    const card = normaliseBattenCard({ count: 1, rows: [{ '0-5': { tension: 'springy', turns: 4 } }] })
    expect(card.rows[0]['0-5']).toEqual({ tension: null, turns: 4 })
  })

  it('drops a band key that is not one of ours', () => {
    const card = normaliseBattenCard({ count: 1, rows: [{ '30-40': { tension: 'soft', turns: 1 } }] })
    expect(card.rows[0]).toEqual({})
  })

  it('treats an empty cell as absent rather than as "medium 0"', () => {
    const card = normaliseBattenCard({ count: 1, rows: [{ '0-5': { tension: null, turns: 0 } }] })
    expect(card.rows[0]['0-5']).toBeUndefined()
  })

  it('gives a blank card for nothing at all, rather than throwing', () => {
    for (const junk of [null, undefined, {}, [], 'nope', 7]) {
      const card = normaliseBattenCard(junk)
      expect(card.count).toBeGreaterThanOrEqual(1)
      expect(card.rows).toHaveLength(card.count)
    }
  })
})

describe('setBattenCount', () => {
  const card = normaliseBattenCard({
    count: 3,
    rows: [
      { '0-5': { tension: 'soft', turns: 1 } },
      { '0-5': { tension: 'medium', turns: 2 } },
      { '0-5': { tension: 'stiff', turns: 3 } },
    ],
  })

  it('keeps the battens that survive a shrink', () => {
    const smaller = setBattenCount(card, 2)
    expect(smaller.rows).toHaveLength(2)
    expect(smaller.rows[1]['0-5'].tension).toBe('medium')
  })

  it('adds blank rows on a grow, leaving the old ones alone', () => {
    const bigger = setBattenCount(card, 5)
    expect(bigger.rows).toHaveLength(5)
    expect(bigger.rows[2]['0-5'].tension).toBe('stiff')
    expect(bigger.rows[4]).toEqual({})
  })

  it('clamps rather than accepting nonsense', () => {
    expect(setBattenCount(card, 0).count).toBe(1)
    expect(setBattenCount(card, 500).count).toBe(MAX_BATTEN_COUNT)
  })
})

describe('cardSetting', () => {
  const card = normaliseBattenCard({
    count: 3,
    rows: [
      { '0-5': { tension: 'soft', turns: 5 }, '15-20': { tension: 'stiff', turns: -1 } },
      {},
      { '25+': { tension: 'stiff', turns: 2 } },
    ],
  })

  it('reads the cell for that batten in that breeze', () => {
    expect(cardSetting(card, 1, 3)).toEqual({ tension: 'soft', turns: 5 })
    expect(cardSetting(card, 1, 17)).toEqual({ tension: 'stiff', turns: -1 })
    expect(cardSetting(card, 3, 30)).toEqual({ tension: 'stiff', turns: 2 })
  })

  it('counts battens from the TOP, one-based', () => {
    // Batten 2 is blank; asking for it must not fall through to batten 1.
    expect(cardSetting(card, 2, 3)).toBeNull()
  })

  it('is null for a blank cell, a missing batten, or no wind reading', () => {
    expect(cardSetting(card, 1, 12)).toBeNull()
    expect(cardSetting(card, 9, 3)).toBeNull()
    expect(cardSetting(card, 1, null)).toBeNull()
  })
})

describe('formatSetting', () => {
  it('reads the way a crew says it', () => {
    expect(formatSetting({ tension: 'soft', turns: 5 })).toBe('soft +5')
    expect(formatSetting({ tension: 'stiff', turns: -2 })).toBe('stiff −2')
    expect(formatSetting({ tension: 'medium', turns: 0 })).toBe('medium')
    expect(formatSetting({ tension: null, turns: 3 })).toBe('+3')
  })

  it('uses a real minus sign, so it lines up under a plus', () => {
    expect(formatSetting({ tension: 'soft', turns: -2 })).toContain('−')
    expect(formatSetting({ tension: 'soft', turns: -2 })).not.toContain('-')
  })

  it('says nothing rather than "null 0"', () => {
    expect(formatSetting(null)).toBe('—')
    expect(formatSetting({ tension: null, turns: 0 })).toBe('—')
  })
})

describe('isBlankSetting / cardIsEmpty', () => {
  it('knows a blank cell', () => {
    expect(isBlankSetting(null)).toBe(true)
    expect(isBlankSetting({ tension: null, turns: 0 })).toBe(true)
    expect(isBlankSetting({ tension: null, turns: -1 })).toBe(false)
    expect(isBlankSetting({ tension: 'soft', turns: 0 })).toBe(false)
  })

  it('knows a card nobody has filled in', () => {
    expect(cardIsEmpty(defaultBattenCard())).toBe(true)
    expect(cardIsEmpty(normaliseBattenCard({ count: 1, rows: [{ '0-5': { tension: 'soft', turns: 0 } }] })))
      .toBe(false)
  })
})

describe('the stiffnesses', () => {
  it('are the three the brief named', () => {
    expect(TENSIONS).toEqual(['soft', 'medium', 'stiff'])
  })
})

describe('cards per mainsail', () => {
  const raceMain = normaliseBattenCard({ count: 3, rows: [{ '0-5': { tension: 'stiff', turns: 2 } }, {}, {}] })
  const deliveryMain = normaliseBattenCard({ count: 3, rows: [{ '0-5': { tension: 'soft', turns: -1 } }, {}, {}] })
  const legacy = normaliseBattenCard({ count: 3, rows: [{ '0-5': { tension: 'medium', turns: 9 } }, {}, {}] })

  const cards: SailBattenCard[] = [
    { sailId: 'm1', card: raceMain, updatedAt: null },
    { sailId: 'm2', card: deliveryMain, updatedAt: null },
    { sailId: null, card: legacy, updatedAt: null },
  ]

  it('gives each main its own card', () => {
    expect(cardForSail(cards, 'm1')?.rows[0]['0-5'].tension).toBe('stiff')
    expect(cardForSail(cards, 'm2')?.rows[0]['0-5'].tension).toBe('soft')
  })

  it('never falls back to the unassigned card for a main that has none', () => {
    // Falling back would attach a three-season delivery main's numbers to a
    // brand-new sail, which reads as a real answer and is not one.
    expect(cardForSail(cards, 'm3')).toBeNull()
  })

  it('does not treat the unassigned card as belonging to any sail', () => {
    expect(cardForSail(cards, null)).toBeNull()
    expect(cardForSail(cards, undefined)).toBeNull()
  })

  it('finds the unassigned card so it can be offered', () => {
    expect(unassignedCard(cards)?.rows[0]['0-5'].turns).toBe(9)
  })

  it('has no unassigned card once every card belongs to a sail', () => {
    expect(unassignedCard(cards.filter((c) => c.sailId))).toBeNull()
  })

  it('survives an empty or missing list', () => {
    expect(cardForSail([], 'm1')).toBeNull()
    expect(cardForSail(null, 'm1')).toBeNull()
    expect(unassignedCard(undefined)).toBeNull()
  })
})

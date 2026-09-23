import { describe, it, expect } from 'vitest'
import { sailKey, sailTokens, matchesSail, vocabularyBlock, CHANNEL_PHRASES, NOT_MEASURED } from '../vocabulary'
import { filterPhases } from '../askData'
import type { PhaseStat } from '../../phaseStats'

// ─────────────────────────────────────────────────────────────────────────────
// "show me all sailscan data of the J2 B 2026 for this season" found nothing.
// There were two, on 2026-07-29 and 2026-09-02, well inside the range asked for.
// The sail is stored "J2_B 2026" and the match was a literal substring, so an
// underscore lost them. The inventory is not even consistent with itself —
// "J2_A_2026" all underscores, "J2_B 2026" underscore then space.
// ─────────────────────────────────────────────────────────────────────────────

describe('sail names', () => {
  it('matches across the separators the inventory actually uses', () => {
    expect(matchesSail('J2_B 2026', 'J2 B 2026')).toBe(true)
    expect(matchesSail('J2_A_2026', 'J2 A 2026')).toBe(true)
    expect(matchesSail('J2_B 2026', 'J2_B_2026')).toBe(true)
    expect(matchesSail('J2_B 2026', 'j2-b-2026')).toBe(true)
  })

  it('still matches a fragment, which is how people actually type', () => {
    expect(matchesSail('MAIN_B 2026/J4_A 2026', 'J4')).toBe(true)
    expect(matchesSail('J1.5_B 2026', 'j1.5')).toBe(true)
  })

  it('does not match a different sail', () => {
    expect(matchesSail('J2_B 2026', 'J2 A 2026')).toBe(false)
    expect(matchesSail('J4_A_2026', 'A4')).toBe(false)
    expect(matchesSail('MAIN_A_2026', 'J2')).toBe(false)
  })

  it('treats an empty query as no filter, not as a filter matching nothing', () => {
    expect(matchesSail('J2_B 2026', '')).toBe(true)
    expect(matchesSail(null, '')).toBe(true)
    expect(matchesSail(null, 'J2')).toBe(false)
  })

  it('splits into parts rather than squashing them together', () => {
    expect(sailTokens('J2_B 2026')).toEqual(['j2', 'b', '2026'])
    expect(sailTokens('J2 B 2026')).toEqual(['j2', 'b', '2026'])
    expect(sailKey('A1.5_A_2026')).toBe('a1 5 a 2026')
  })

  // Squashing the separators away makes "J4_A 2026" into "j4a2026", which
  // CONTAINS "a2" — so the A2 query came back with the J4. Caught by the existing
  // filterPhases test, which is the only reason it is not shipped.
  it('does not let a name run into the next part of another one', () => {
    expect(matchesSail('J4_A 2026', 'A2')).toBe(false)
    expect(matchesSail('MAIN_A_2026', 'A2')).toBe(false)
    expect(matchesSail('A2_A_2026', 'A2')).toBe(true)
  })

  it('does not let J1 reach into J1.5', () => {
    expect(matchesSail('J1.5_B 2026', 'J1_A')).toBe(false)
    expect(matchesSail('J1.5_B 2026', 'J1.5')).toBe(true)
  })
})

describe('the phase filter uses the same match', () => {
  const phase = (sailCombo: string): PhaseStat => ({
    utc: 1, endUtc: 2, mode: 'up', tack: 'port', sails: [], sailCombo, race: null, n: 5,
    mean: { tws: 14 }, max: {},
  } as PhaseStat)

  it('finds the combination however the separators fall', () => {
    const stats = [phase('MAIN_B 2026/J2_B 2026'), phase('MAIN_A_2026/A2_A_2026')]
    expect(filterPhases(stats, { sailCombo: 'J2 B 2026' })).toHaveLength(1)
    expect(filterPhases(stats, { sailCombo: 'a2' })).toHaveLength(1)
  })
})

describe('vocabularyBlock', () => {
  const block = () => vocabularyBlock(['J2_B 2026', 'MAIN_A_2026'], 'Northstar 76')

  it('tells the model what the crew mean by the words they use', () => {
    const b = block()
    expect(b).toContain('pointing')
    expect(b).toContain('twa')
    expect(b).toContain('kicker')
    expect(b).toContain('vang')
  })

  it('names what is NOT measured, so it is refused rather than substituted', () => {
    const b = block()
    expect(b).toContain('leeway')
    expect(b).toContain('sea state')
    expect(b).toContain('not logged')
  })

  it('carries the Dutch the crew actually speak, from the one glossary', () => {
    const b = block()
    expect(b).toContain('overstag')
    expect(b).toContain('grootzeil')
  })

  it('lists the boat’s sails exactly as stored', () => {
    const b = block()
    expect(b).toContain('J2_B 2026')
    expect(b).toContain('MAIN_A_2026')
  })

  it('survives a boat with no sails and no name', () => {
    expect(() => vocabularyBlock([], null)).not.toThrow()
    expect(vocabularyBlock([], null)).toContain('pointing')
  })

  // A vocabulary that maps an ambiguous word confidently is worse than one that
  // leaves it out: the search tokens would then show a filter nobody meant.
  it('maps nothing to two different channels', () => {
    const targets = CHANNEL_PHRASES.flatMap(([phrases]) => phrases.split(',').map(p => p.trim().toLowerCase()))
    expect(new Set(targets).size).toBe(targets.length)
  })

  it('does not claim to measure something it also says is not measured', () => {
    const measured = new Set(CHANNEL_PHRASES.flatMap(([p]) => p.split(',').map(x => x.trim().toLowerCase())))
    for (const [phrases] of NOT_MEASURED) {
      for (const word of phrases.split(',').map(x => x.trim().toLowerCase())) {
        expect(measured.has(word)).toBe(false)
      }
    }
  })
})

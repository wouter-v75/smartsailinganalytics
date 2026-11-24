// One boat's sail codes must not be offered to another boat.
//
// Ryujin, 7 Nov 2026. Her debrief came back naming a sail she does not own —
// "MH0 (referred to as 'the zero')" and "J-Zero (jib top / masthead zero)" —
// when the sail discussed all day was her J0. Her wardrobe WAS loaded and J0 WAS
// in the prompt; what beat it was DEFAULT_GLOSSARY, which is one squad's
// vocabulary shared by every team: MH0 and BRO in `sails`, and a mishearing map
// pointing "mode zero", "mower", "emmage zero" and "the mode" straight at MH0.
//
// The same mistake as northstarConditions() falling back to Northstar's
// sailmaker sheet for any boat — one boat's reference leaking into another's and
// being asserted as fact. And the two failure directions are not equal, which is
// what settles the design: a MISSING correction leaves a garbled word a reader
// can spot, a WRONG one invents a sail the boat has never owned.
//
// Numbers below are the real wardrobes, read from the database on 8 Nov 2026.

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_GLOSSARY, GENERIC_SAILS, foreignCodes, withOverride, vocabForBoat,
} from '../debriefGlossary'

const RYUJIN = ['MN 2026', 'J2 2026', 'J3', 'A1.5', 'A2', 'J0', 'A2.5', 'GS 2026']
const NORTHSTAR = ['MH0 A', 'BR0 A', 'A1.5 A', 'A2 A', 'MAIN A', 'J1 A', 'J2 A', 'SSS A 2026']
const BARAKA = ['GS', 'SS', 'A4', 'J1', 'J2', 'J1.5', 'J2.5', 'J3', 'J4', 'MN-3', 'MH0', 'JT', 'A1.5 2025', 'A2']

describe('foreignCodes', () => {
  it("drops the other squad's codes from Ryujin's prompt", () => {
    const dropped = foreignCodes(DEFAULT_GLOSSARY, RYUJIN)
    expect(dropped).toContain('MH0')
    expect(dropped).toContain('BRO')
    expect(dropped).toContain('mo')
    expect(dropped).toContain('masthead zero')
  })

  it('keeps every code Ryujin does own', () => {
    const dropped = foreignCodes(DEFAULT_GLOSSARY, RYUJIN)
    for (const own of ['J0', 'A2', 'A1.5']) expect(dropped).not.toContain(own)
  })

  it('takes nothing off Northstar, whose vocabulary these codes are', () => {
    const team = vocabForBoat('Northstar 76')
    const dropped = foreignCodes(DEFAULT_GLOSSARY, [...NORTHSTAR, ...(team?.sails ?? [])])
    for (const own of ['MH0', 'BRO', 'mo']) expect(dropped).not.toContain(own)
  })

  it("keeps a nickname that is the crew's only word for a sail they have", () => {
    // No wardrobe lists slang, so "mo" survives on the strength of the alias
    // mo → MH0 and Northstar owning an MH0. Scoping on the wardrobe alone would
    // take the nickname off the one boat that uses it.
    expect(foreignCodes(DEFAULT_GLOSSARY, ['MH0 A'])).not.toContain('mo')
    expect(foreignCodes(DEFAULT_GLOSSARY, ['A2'])).toContain('mo')
  })

  it('keeps the canonical code when the wardrobe spells it the other way', () => {
    // Northstar's own sail list has both "MH0 A" and "MHO B" — zero and letter
    // O. A boat that only ever spelled it MHO must still get MH0, which is the
    // form the note should use.
    expect(foreignCodes(DEFAULT_GLOSSARY, ['MHO B'])).not.toContain('MH0')
  })

  it('does not confuse A2 with A2.5, in either direction', () => {
    expect(foreignCodes(DEFAULT_GLOSSARY, ['A2'])).toContain('A1.5')
    expect(foreignCodes(DEFAULT_GLOSSARY, ['A2.5'])).toContain('A2')
    expect(foreignCodes(DEFAULT_GLOSSARY, ['A2'])).not.toContain('A2')
  })

  it('matches a wardrobe name that carries its year', () => {
    expect(foreignCodes(DEFAULT_GLOSSARY, BARAKA)).not.toContain('A1.5')
  })

  it('never drops a generic sail word, which no wardrobe lists', () => {
    const dropped = foreignCodes(DEFAULT_GLOSSARY, RYUJIN)
    for (const g of GENERIC_SAILS) expect(dropped).not.toContain(g)
    // The guard on the guard: if a generic ever appeared in a wardrobe this test
    // would still pass, so assert the premise too.
    for (const g of GENERIC_SAILS) expect(DEFAULT_GLOSSARY.sails).toContain(g)
  })
})

describe('withOverride · scoping', () => {
  it("removes the mishearings that steer to another boat's sail", () => {
    const g = withOverride({ sails: RYUJIN })
    const says = g.fixups.map(([say]) => say)
    for (const gone of ['mode zero', 'mower', 'emmage zero', 'the mode', 'Brault', 'raw']) {
      expect(says, `${gone} still points Ryujin at a sail she has not got`).not.toContain(gone)
    }
    expect(g.sails).not.toContain('MH0')
    expect(g.sails).toContain('J0')
  })

  it('leaves those same mishearings in place for Northstar', () => {
    const team = vocabForBoat('Northstar 76')
    const g = withOverride({ ...team, sails: [...NORTHSTAR, ...(team?.sails ?? [])] })
    const says = g.fixups.map(([say]) => say)
    for (const kept of ['mode zero', 'mower', 'Brault', 'raw']) expect(says).toContain(kept)
  })

  it('changes nothing when the wardrobe is unknown', () => {
    // A rival boat, a bench run, every existing caller that passes no sails.
    const g = withOverride({ crew: ['Someone'] })
    expect(g.sails).toEqual(DEFAULT_GLOSSARY.sails)
    expect(g.fixups).toEqual(DEFAULT_GLOSSARY.fixups)
    expect(withOverride(undefined)).toBe(DEFAULT_GLOSSARY)
  })

  it("never filters the boat's OWN typed-in pairs", () => {
    // Boat → Debrief words is the team's word on the matter, even if it names a
    // code the wardrobe has not got yet.
    const g = withOverride({ sails: RYUJIN, fixups: [['bro', 'BRO']] })
    expect(g.fixups).toContainEqual(['bro', 'BRO'])
  })
})

describe('the terms from the 7 Nov debrief', () => {
  const find = (pairs: [string, string][], say: string) =>
    pairs.find(([s]) => s.toLowerCase() === say.toLowerCase())?.[1] ?? ''

  it('knows "wind weight" is a real term and not AWA', () => {
    // Wouter, 8 Nov 2026: "wind weight is a correct term."
    expect(find(DEFAULT_GLOSSARY.aliases, 'wind weight')).toMatch(/strength or pressure of the breeze/)
  })

  it('stops the AWA fixup from being aimed at it', () => {
    // ['the weight', 'the AWA …'] was in the fixups, and "wind weight" sits
    // squarely inside its stated scope of sail trim.
    expect(find(DEFAULT_GLOSSARY.fixups, 'the weight')).toMatch(/NEVER in "wind weight"/)
  })

  it('knows "cals" means the wind calibrations', () => {
    expect(find(DEFAULT_GLOSSARY.aliases, 'cals')).toMatch(/calibration/i)
  })

  it('spells the J0 the way the boat does', () => {
    for (const said of ['J-Zero', 'J zero', 'jay zero']) {
      expect(find(DEFAULT_GLOSSARY.fixups, said)).toBe('J0')
    }
  })

  it('carries the manoeuvres and the part the debrief used', () => {
    expect(DEFAULT_GLOSSARY.manoeuvres).toContain('gorilla hoist')
    expect(DEFAULT_GLOSSARY.manoeuvres).toContain('hatch set')
    expect(DEFAULT_GLOSSARY.parts).toContain('mast butt')
  })
})

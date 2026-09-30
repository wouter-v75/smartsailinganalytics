// src/lib/__tests__/debriefVocab.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// The boat's own debrief words. Two things here are load-bearing and neither is
// obvious from the types:
//
//   an empty list INHERITS rather than clears, so a first save of one mishearing
//   cannot wipe the crew that lives in code;
//   a half-typed pair is DROPPED, because a name with no role reaches the model
//   as an instruction with no content and the model fills the gap itself.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import {
  EMPTY_VOCAB, MAX_ENTRIES, MAX_ENTRY_CHARS, VOCAB_LABELS, VOCAB_LISTS,
  countVocab, isEmptyVocab, isPairList, normaliseDebriefVocab,
} from '../debriefVocab'

describe('normaliseDebriefVocab — what survives', () => {
  it('keeps the six lists and nothing else', () => {
    const v = normaliseDebriefVocab({ crew: ['Pedro'], sails: ['MH0'], nonsense: 1 })
    expect(Object.keys(v).sort()).toEqual([...VOCAB_LISTS].sort())
    expect((v as Record<string, unknown>).sails).toBeUndefined()
  })

  it('takes the shapes the editor produces', () => {
    const v = normaliseDebriefVocab({
      crew: ['Pedro', 'Mika'],
      boats: ['Tilakkhana II'],
      roles: [['Nick', 'tactician']],
      manoeuvres: ['Sandukan'],
      aliases: [['Sandukan', 'gybe set at the top mark']],
      fixups: [['Jesu', 'Jethou (boat name)']],
    })
    expect(v.crew).toEqual(['Pedro', 'Mika'])
    expect(v.roles).toEqual([['Nick', 'tactician']])
    expect(v.aliases[0][1]).toBe('gybe set at the top mark')
  })

  it('accepts {from,to} as well as a tuple, so an older draft still loads', () => {
    const v = normaliseDebriefVocab({ fixups: [{ from: 'Jesu', to: 'Jethou' }] })
    expect(v.fixups).toEqual([['Jesu', 'Jethou']])
  })

  it('tidies whitespace and drops blanks', () => {
    const v = normaliseDebriefVocab({ crew: ['  Pedro  ', '', '   ', 'Mika\tvan\n Dijk'] })
    expect(v.crew).toEqual(['Pedro', 'Mika van Dijk'])
  })

  it('drops a pair with only one half — both or neither', () => {
    const v = normaliseDebriefVocab({
      roles: [['Nick', 'tactician'], ['Frank', ''], ['', 'bow'], ['Miles', 'navigator']],
    })
    expect(v.roles).toEqual([['Nick', 'tactician'], ['Miles', 'navigator']])
  })

  it('de-duplicates case-insensitively, keeping the first spelling', () => {
    // The first is the one somebody typed deliberately; a later "jethou" is a
    // repeat, not a correction, and replacing it would restyle a proper noun.
    const v = normaliseDebriefVocab({ boats: ['Jethou', 'JETHOU', 'jethou', 'Jolt'] })
    expect(v.boats).toEqual(['Jethou', 'Jolt'])
  })

  it('de-duplicates pairs on the left-hand side', () => {
    const v = normaliseDebriefVocab({ fixups: [['Jesu', 'Jethou'], ['jesu', 'something else']] })
    expect(v.fixups).toEqual([['Jesu', 'Jethou']])
  })

  it('caps the entries and their length, because the prompt has a budget', () => {
    const many = Array.from({ length: MAX_ENTRIES + 50 }, (_, i) => `name${i}`)
    expect(normaliseDebriefVocab({ crew: many }).crew).toHaveLength(MAX_ENTRIES)
    const long = 'x'.repeat(MAX_ENTRY_CHARS + 80)
    expect(normaliseDebriefVocab({ crew: [long] }).crew[0]).toHaveLength(MAX_ENTRY_CHARS)
  })

  it('never throws on rubbish — a debrief must not fail over a stored column', () => {
    for (const junk of [null, undefined, 0, 'a string', [], { crew: 'not a list' }, { roles: [1, 2] }]) {
      expect(() => normaliseDebriefVocab(junk)).not.toThrow()
    }
    expect(normaliseDebriefVocab(null)).toEqual(EMPTY_VOCAB)
    expect(normaliseDebriefVocab({ crew: 'not a list' }).crew).toEqual([])
  })
})

describe('empty means inherit', () => {
  it('recognises an untouched vocabulary', () => {
    expect(isEmptyVocab(EMPTY_VOCAB)).toBe(true)
    expect(isEmptyVocab(normaliseDebriefVocab({}))).toBe(true)
    expect(isEmptyVocab(normaliseDebriefVocab({ roles: [['Nick', 'tactician']] }))).toBe(false)
  })

  it('a vocabulary of nothing but half-typed rows is still empty', () => {
    // Otherwise a draft with one unfinished row would count as an override and
    // the merge would treat the boat as having been edited.
    expect(isEmptyVocab(normaliseDebriefVocab({ roles: [['Frank', '']] }))).toBe(true)
  })

  it('counts what is actually there', () => {
    expect(countVocab(EMPTY_VOCAB)).toBe(0)
    expect(countVocab(normaliseDebriefVocab({
      crew: ['a', 'b'], fixups: [['x', 'y']],
    }))).toBe(3)
  })
})

describe('the editor is told how to render each list', () => {
  it('labels every list', () => {
    for (const k of VOCAB_LISTS) {
      expect(VOCAB_LABELS[k].title).toBeTruthy()
      expect(VOCAB_LABELS[k].hint).toBeTruthy()
    }
  })

  it('gives both column names for every pair list, and none for the rest', () => {
    for (const k of VOCAB_LISTS) {
      if (isPairList(k)) {
        expect(VOCAB_LABELS[k].a, k).toBeTruthy()
        expect(VOCAB_LABELS[k].b, k).toBeTruthy()
      } else {
        expect(VOCAB_LABELS[k].a, k).toBeUndefined()
      }
    }
  })

  it('does not offer sails — those come from the inventory', () => {
    expect(VOCAB_LISTS).not.toContain('sails')
  })
})

// src/lib/__tests__/boatVocab.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Where the boat's typed-in words meet the ones that live in code.
//
// The failure this guards against is quiet and expensive: somebody opens Boat →
// Debrief words, types one mishearing, saves — and the fifteen crew names and
// seven rival boats that TEAM_VOCAB carries are gone from the prompt. Nothing
// would say so. The next debrief would just come back with a name wrong, and
// nobody would connect the two.
//
// So: a list with something in it ADDS; a list with nothing in it INHERITS.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadBoatVocab, clearBoatVocab } from '../boatVocab'
import { withOverride, whisperPrompt, glossaryBlock, WHISPER_PROMPT_MAX_CHARS } from '../debriefGlossary'

const BOATS = { boats: [{ id: 'b1', name: 'Northstar 76' }] }
const SAILS = { sails: [{ name: 'MAIN_B_2026' }, { name: 'J1.5_B_2026', retired: false }] }

const mockFetch = (vocab: unknown) => vi.fn((url: string) => {
  const body = url.includes('/debrief-vocab') ? { vocab }
    : url.includes('/sails') ? SAILS
      : BOATS
  return Promise.resolve({ ok: true, json: async () => body })
})

beforeEach(() => clearBoatVocab())
afterEach(() => { clearBoatVocab(); vi.restoreAllMocks() })

describe('loadBoatVocab — the boat’s own words', () => {
  it('adds typed-in entries to the ones in code', async () => {
    vi.stubGlobal('fetch', mockFetch({
      boats: ['Tilakkhana II'],
      fixups: [['Tilak', 'Tilakkhana II (boat name)']],
    }))
    const extra = await loadBoatVocab('t1', 'b1')
    expect(extra?.boats).toContain('Tilakkhana II')
    expect(extra?.boats).toContain('Jethou')          // still from TEAM_VOCAB
    expect(extra?.fixups?.some(([a]: string[]) => a === 'Tilak')).toBe(true)
    expect(extra?.fixups?.some(([a]: string[]) => a === 'Jesu')).toBe(true)
  })

  it('does NOT wipe the code lists when only one list is filled in', async () => {
    // The whole point. One mishearing typed in must not cost the crew.
    vi.stubGlobal('fetch', mockFetch({ fixups: [['Tilak', 'Tilakkhana II']] }))
    const extra = await loadBoatVocab('t1', 'b1')
    expect(extra?.crew).toContain('Pedro')
    expect(extra?.boats).toContain('Bella Mente')
    expect(extra?.roles?.length).toBeGreaterThan(0)
  })

  it('leaves everything alone when the boat has never been edited', async () => {
    vi.stubGlobal('fetch', mockFetch({}))
    const extra = await loadBoatVocab('t1', 'b1')
    expect(extra?.crew).toContain('Pedro')
    expect(extra?.boats).toContain('Jethou')
  })

  it('keeps the code defaults when the vocabulary cannot be fetched', async () => {
    // A debrief with the old glossary is worth far more than one with none.
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      url.includes('/debrief-vocab')
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ ok: true, json: async () => (url.includes('/sails') ? SAILS : BOATS) })))
    const extra = await loadBoatVocab('t1', 'b1')
    expect(extra?.crew).toContain('Pedro')
    expect(extra?.boats).toContain('Jethou')
  })

  it('still brings the sail wardrobe in, with the version suffix off', async () => {
    vi.stubGlobal('fetch', mockFetch({ crew: ['Someone New'] }))
    const extra = await loadBoatVocab('t1', 'b1')
    expect(extra?.sails).toContain('MAIN B')
    expect(extra?.crew).toContain('Someone New')
  })

  it('drops a half-typed row before it can reach a prompt', async () => {
    vi.stubGlobal('fetch', mockFetch({ roles: [['Nobody', '']] }))
    const extra = await loadBoatVocab('t1', 'b1')
    expect(extra?.roles?.some(([n]: string[]) => n === 'Nobody')).toBe(false)
  })
})

describe('what the boat typed reaches both prompts', () => {
  it('a new rival reaches Whisper and the summariser', async () => {
    vi.stubGlobal('fetch', mockFetch({
      boats: ['Tilakkhana II'],
      aliases: [['Sandukan', 'gybe set at the top mark']],
    }))
    const g = withOverride(await loadBoatVocab('t1', 'b1') || undefined)

    const p = whisperPrompt(g)
    expect(p.length).toBeLessThanOrEqual(WHISPER_PROMPT_MAX_CHARS)
    expect(p).toContain('Tilakkhana II')

    const block = glossaryBlock(g)
    expect(block).toContain('Tilakkhana II')
    expect(block).toContain('Sandukan→gybe set at the top mark')
  })
})

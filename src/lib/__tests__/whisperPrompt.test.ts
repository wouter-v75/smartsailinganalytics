import { describe, it, expect } from 'vitest'
import {
  whisperPrompt, clampWhisperPrompt, withOverride,
  WHISPER_PROMPT_MAX_CHARS, WHISPER_TOTAL_MAX_CHARS, DEFAULT_GLOSSARY,
} from '../debriefGlossary'

// Whisper's decoder context is 448 tokens for prompt AND output, and Scaleway
// rejects an over-long prompt with a 400 rather than truncating. Sail codes
// tokenise at roughly 2 chars/token, which is what made a "short-looking" list blow
// the limit in the field.
const CHARS_PER_TOKEN = 2
const tokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN)

// The boat's live wardrobe, as /api/teams/:id/sails feeds it in.
const WARDROBE = ['MAIN-2025','J1-2023','J2-2022','J3-2021','A1.5-2022','A1.5-2023',
  'A2-2024','A3-2022','MH0-2024','SS-2023','C0-2023','JT-2022','A4-2021','J1.5-2024']

describe('whisper prompt budget', () => {
  it('pins the regression: the OLD unbudgeted prompt blew past any safe budget', () => {
    // What the code used to build — every term, plus a 200-char tail carried from
    // the previous chunk. In the field this came back as
    //   "maximum context length is 448 tokens ... at least 449 input tokens".
    // The assertion is on CHARACTERS, which is what this code can actually measure;
    // the exact token count depends on Whisper's tokeniser and on how large the
    // boat's wardrobe happens to be that day. The point being pinned is that the old
    // path had no ceiling at all, so a big enough wardrobe always breaks it.
    const g = withOverride({ sails: WARDROBE })
    const unbudgeted = `Sailing-team debrief. Terms used: ${
      [...g.crew, ...g.sails, ...g.manoeuvres, ...g.parts.slice(0, 14)].join(', ')}.`
    const withTail = 'x'.repeat(200) + '\n' + unbudgeted
    expect(withTail.length).toBeGreaterThan(WHISPER_TOTAL_MAX_CHARS)
    // …and grows without limit as the wardrobe does, which is the actual defect.
    const huge = withOverride({ sails: Array.from({ length: 60 }, (_, i) => `SAIL-${i}-2026`) })
    const unbounded = `Sailing-team debrief. Terms used: ${
      [...huge.crew, ...huge.sails, ...huge.manoeuvres].join(', ')}.`
    expect(unbounded.length).toBeGreaterThan(withTail.length)
    // The budgeted builder, given the same absurd input, does not.
    expect(whisperPrompt(huge).length).toBeLessThanOrEqual(WHISPER_PROMPT_MAX_CHARS)
  })

  it('stays inside the budget with a full wardrobe merged in', () => {
    const p = whisperPrompt(withOverride({ sails: WARDROBE }))
    expect(p.length).toBeLessThanOrEqual(WHISPER_PROMPT_MAX_CHARS)
    expect(tokens(p)).toBeLessThan(224)
  })

  it('stays inside the budget for an absurd wardrobe, not just a plausible one', () => {
    const many = Array.from({ length: 200 }, (_, i) => `SAIL-${i}-2026`)
    const p = whisperPrompt(withOverride({ sails: many, crew: many }))
    expect(p.length).toBeLessThanOrEqual(WHISPER_PROMPT_MAX_CHARS)
  })

  it('spends the budget on what Whisper cannot guess — names first', () => {
    const p = whisperPrompt(withOverride({ sails: WARDROBE }))
    // Every proper noun must survive: Whisper cannot guess a name, and a wrong one
    // reaches the summary as fact.
    for (const c of DEFAULT_GLOSSARY.crew) expect(p).toContain(c)
    for (const b of DEFAULT_GLOSSARY.boats) expect(p).toContain(b)
  })

  it('carries most of the wardrobe, and drops generic words rather than codes', () => {
    // A full crew + rival boats + a season's wardrobe genuinely exceed the token
    // budget, so this asserts the PRIORITY, not that everything fits: unguessable
    // codes stay, and the words Whisper already knows are what get dropped.
    const p = whisperPrompt(withOverride({ sails: WARDROBE }))
    const kept = WARDROBE.filter((s) => p.includes(s))
    expect(kept.length).toBeGreaterThanOrEqual(8)
    expect(p).toContain('BRO')          // a real sail read as slang before it was listed
    expect(p).toContain('MH0')          // heard as "the mo"
    expect(p).not.toContain('spinnaker') // generic: correctly sacrificed first
  })

  it('still reaches the most-mangled hardware, which is the whole point', () => {
    // Filling strictly by priority let crew+sails eat the entire budget, so the
    // terms this glossary exists to correct never reached Whisper. Each category
    // now gets a share.
    const p = whisperPrompt(withOverride({ sails: WARDROBE }))
    for (const t of ['halyard', 'tackline', 'constrictor']) expect(p).toContain(t)
  })

  it('gives the wardrobe room even when the crew list is long', () => {
    const crew = Array.from({ length: 40 }, (_, i) => `Crewmember${i}`)
    const p = whisperPrompt(withOverride({ sails: WARDROBE, crew }))
    expect(p).toContain('MAIN-2025')
    expect(p).toContain('halyard')
    expect(p.length).toBeLessThanOrEqual(WHISPER_PROMPT_MAX_CHARS)
  })

  it('is still a usable sentence, not a truncated fragment', () => {
    const p = whisperPrompt(withOverride({ sails: WARDROBE }))
    expect(p.startsWith('Sailing-team debrief. Terms used: ')).toBe(true)
    expect(p.endsWith('.')).toBe(true)
    expect(p).not.toContain(', .')
  })

  it('clamps the composed prompt and keeps the TERMS over the chunk tail', () => {
    const bias = whisperPrompt(withOverride({ sails: WARDROBE }))
    const composed = clampWhisperPrompt('previous chunk text '.repeat(40) + '\n' + bias)
    expect(composed.length).toBeLessThanOrEqual(WHISPER_TOTAL_MAX_CHARS)
    expect(tokens(composed)).toBeLessThan(448)
    expect(composed.endsWith('.')).toBe(true)   // the glossary end survived
    expect(composed).toContain('MAIN-2025')
  })

  it('leaves a short prompt alone', () => {
    expect(clampWhisperPrompt('  short one  ')).toBe('short one')
    expect(clampWhisperPrompt('')).toBe('')
  })
})

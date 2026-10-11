// src/lib/__tests__/debriefPromptUnits.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// The prompt is a specification, so a few parts of it are worth asserting.
//
// Not its wording — that is tuned by running the bench. These are the pieces
// whose ABSENCE is a silent wrong answer: a unit missing from QUANTITIES means
// a bare number gets read as whatever the model assumes, and nothing in the
// note says it guessed.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { QUANTITIES, RULES, MODES, buildMessages } from '../debriefPrompt'
import { DEFAULT_GLOSSARY } from '../debriefGlossary'

describe('QUANTITIES — every unit nobody says out loud', () => {
  it('names each quantity the fleet speaks in bare numbers', () => {
    for (const unit of ['DEGREES', 'KNOTS', 'MILLIMETRES', 'PERCENT', 'SECONDS', 'METRES']) {
      expect(QUANTITIES).toContain(unit)
    }
  })

  it('covers IRC RATING POINTS, which a rating conversation is full of', () => {
    // Baraka's 9 Oct meeting: "0.5 to 1 point over", "the interceptor adds 2
    // points", "use the 2 points elsewhere". Read as knots or percent, the whole
    // trade inverts — the question is always whether the speed gained is worth
    // the rating paid.
    expect(QUANTITIES).toContain('IRC RATING POINTS')
    expect(QUANTITIES.toLowerCase()).toContain('interceptor')
  })

  it('still insists a number of unknown unit is QUOTED, not labelled', () => {
    // The fallback that makes the rest safe: a number with the wrong unit is
    // worse than a quote.
    expect(QUANTITIES).toMatch(/quote the speaker's phrase around it verbatim/)
  })
})

describe('RULES — the ones a correction must not quietly undo', () => {
  it('still forbids inventing a role for a name', () => {
    // A corrected note that writes "Olivier (helm)" needs Olivier in the boat's
    // Roles list. The fix for that is the Boat tab, never this rule.
    expect(RULES).toMatch(/Never write "<role> \(e\.g\. <name>\)"/)
  })

  it('still forbids inventing an owner for a task', () => {
    expect(RULES).toMatch(/NEVER invent an owner/)
  })
})

describe('the speed-team sections', () => {
  it('asks for the headings in the order the team writes them', () => {
    const p = MODES.speedteam.prompt
    const order = ['Goals for today', 'Upwind', 'Downwind', 'Rig', 'Tests / focus today', 'Long-term']
    let at = -1
    for (const h of order) {
      const i = p.indexOf(h)
      expect(i, `${h} missing from the speedteam prompt`).toBeGreaterThan(-1)
      expect(i, `${h} out of order`).toBeGreaterThan(at)
      at = i
    }
  })

  it('reaches the model with the quantities attached', () => {
    // buildMessages is where the glossary, the rules and the mode meet; a mode
    // that lost QUANTITIES would summarise numbers by guesswork.
    const [system] = buildMessages('speedteam', 'transcript', undefined) as { content: string }[]
    expect(system.content).toContain('IRC RATING POINTS')
  })
})

describe('the shared mishearings', () => {
  it('knows "flower TWS" is "lower TWS"', () => {
    // It survived the AI note AND the hand correction on 9 Oct, which is why it
    // is here rather than left to either pass.
    const pairs = DEFAULT_GLOSSARY.fixups.map(([heard, meant]) => `${heard}→${meant}`)
    expect(pairs.some((p) => /^flower/.test(p) && /lower/.test(p))).toBe(true)
  })

  it('scopes it to wind strength rather than replacing the word everywhere', () => {
    // These go to the summariser as context, not as a find-and-replace, and the
    // scope is what keeps a context-dependent entry safe.
    const entry = DEFAULT_GLOSSARY.fixups.find(([heard]) => heard === 'flower')
    expect(entry?.[1]).toMatch(/wind strength/)
  })
})

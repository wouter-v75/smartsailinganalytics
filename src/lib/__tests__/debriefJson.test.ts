// src/lib/__tests__/debriefJson.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// The repair is allowed to rescue a cut-off debrief. It is not allowed to do it
// silently — that is how Baraka's Admiral's Cup note was saved ending
// "- Apparel: Assign someone to handle team clothing/gear (e.g., with".
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { extractJson, stoppedCleanly, endsMidSentence } from '../debriefJson'

describe('extractJson — a clean parse says so', () => {
  it('reads a plain object without claiming repair', () => {
    const out = extractJson('{"notes":"all of it"}')
    expect(out.data).toEqual({ notes: 'all of it' })
    expect(out.repaired).toBe(false)
  })

  it('strips code fences without claiming repair', () => {
    // Untidy is not truncated. A fenced but COMPLETE object must not raise the
    // warning, or the warning stops meaning anything.
    const out = extractJson('```json\n{"notes":"all of it"}\n```')
    expect(out.data).toEqual({ notes: 'all of it' })
    expect(out.repaired).toBe(false)
  })

  it('digs a complete object out of surrounding prose, still unrepaired', () => {
    const out = extractJson('Here you go:\n{"notes":"all of it"}\nhope that helps')
    expect(out.data).toEqual({ notes: 'all of it' })
    expect(out.repaired).toBe(false)
  })
})

describe('extractJson — a repaired parse SAYS SO', () => {
  it('rescues an object cut mid-string, and reports it', () => {
    // The real shape of the failure: the model ran out of room inside a value.
    const cut = '{"notes":"**Logistics**\\n- Apparel: Assign someone to handle team clothing/gear (e.g., with'
    const out = extractJson(cut)
    expect(out.repaired).toBe(true)
    expect(String(out.data!.notes)).toContain('Apparel')
  })

  it('keeps everything written before the cut', () => {
    // Rescuing matters: a 75-minute debrief should not be lost because the last
    // sentence was. What must not happen is losing it SILENTLY.
    const cut = '{"overall":"complete section","notes":"second section that stops here'
    const out = extractJson(cut)
    expect(out.data!.overall).toBe('complete section')
    expect(out.repaired).toBe(true)
  })

  it('closes unbalanced braces as well as strings', () => {
    const out = extractJson('{"a":{"b":"cut off here')
    expect(out.repaired).toBe(true)
    expect(out.data).toBeTruthy()
  })

  it('gives up honestly when there is nothing to parse', () => {
    expect(extractJson('').data).toBeNull()
    expect(extractJson('no json at all').data).toBeNull()
    expect(extractJson('').repaired).toBe(false)
  })
})

describe('stoppedCleanly — the enum is not dependable, so lean safe', () => {
  it('accepts the two endings that mean "finished"', () => {
    expect(stoppedCleanly('stop')).toBe(true)
    expect(stoppedCleanly('tool_calls')).toBe(true)
  })

  it('treats length AND its variants as cut short', () => {
    // Mistral's published values disagree about whether an exhausted generation
    // is `length` or `model_length`; checking only for `length` is what let
    // Baraka's note through with no warning.
    expect(stoppedCleanly('length')).toBe(false)
    expect(stoppedCleanly('model_length')).toBe(false)
    expect(stoppedCleanly('error')).toBe(false)
    expect(stoppedCleanly('content_filter')).toBe(false)
  })

  it('takes a MISSING reason as clean, so no provider lights it on every run', () => {
    // The two failure directions are not equal — a spurious warning costs a
    // second's reading, a missing one saves a note with its last point gone —
    // but a provider that sends no finish_reason at all would otherwise warn
    // every single time, and a warning that is always on is no warning.
    expect(stoppedCleanly(null)).toBe(true)
    expect(stoppedCleanly(undefined)).toBe(true)
    expect(stoppedCleanly('')).toBe(true)
  })
})

// The third signal. Cases taken from real stored debriefs: the clean ones from
// notes nobody complained about, the cut ones from notes that were short.
describe('endsMidSentence', () => {
  it.each([
    'Team talk scheduled for 6 PM to discuss next year’s plans.',
    'Consider adding 100 kg of weight (A1.5, J1.5, A2, J2).',
    'Open question: who owns the drone?',
    'He said "go".',
    'Set the runner to 12:',
    'tighter mark-rounding communication.',
  ])('calls a finished note finished: %s', (s) => {
    expect(endsMidSentence(s)).toBe(false)
  })

  it.each([
    // Ryujin, 7 Nov — the exact tail that was saved as a whole note.
    '- Packing the A1.5 in phases (tack zipped first, head optional) allowed for a quick ',
    '- Ease the cable, so the sail projects more to windward until it gets',
    '- Nick; to help Peter with rotation speed\n- Gabri to help with landing angle',
    'BRO to MHO cross-over and MHO to A sail have the focus\n',
  ])('calls a cut note cut: %s', (s) => {
    expect(endsMidSentence(s)).toBe(true)
  })

  it('is not fooled by trailing whitespace either way', () => {
    expect(endsMidSentence('finished.   \n\n')).toBe(false)
    expect(endsMidSentence('not finished   \n\n')).toBe(true)
  })

  it('says nothing about empty or missing text', () => {
    // An empty key is a key the model never reached, which the merge handles.
    // Reporting it as mid-sentence would fire the warning on every run that had
    // a key left over.
    expect(endsMidSentence('')).toBe(false)
    expect(endsMidSentence('   ')).toBe(false)
    expect(endsMidSentence(null)).toBe(false)
    expect(endsMidSentence(undefined)).toBe(false)
  })
})

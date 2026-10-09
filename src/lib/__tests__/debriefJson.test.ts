// src/lib/__tests__/debriefJson.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// The repair is allowed to rescue a cut-off debrief. It is not allowed to do it
// silently — that is how Baraka's Admiral's Cup note was saved ending
// "- Apparel: Assign someone to handle team clothing/gear (e.g., with".
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest'
import { extractJson, stoppedCleanly } from '../debriefJson'

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

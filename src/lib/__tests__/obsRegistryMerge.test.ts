import { describe, expect, it } from 'vitest'
import { keepInRegistry, type ProbeOutcome } from '../obsRegistryMerge'

const OUTCOMES: ProbeOutcome[] = ['wind', 'answered-no-wind', 'stale', 'no-answer']

describe('keepInRegistry', () => {
  it('keeps anything that is reporting', () => {
    expect(keepInRegistry('wind', false).keep).toBe(true)
    expect(keepInRegistry('wind', true).keep).toBe(true)
  })

  it('keeps a KNOWN station whose anemometer is silent today', () => {
    // The Yacht Club de Saint-Tropez case: station alive, upload one minute
    // old, windSpeed "--". Rebuilding without this deletes the only station
    // on the race area and never asks it again.
    const d = keepInRegistry('answered-no-wind', true)
    expect(d.keep).toBe(true)
    expect(d.why).toMatch(/known station/i)
  })

  it('still makes a NEW candidate prove itself', () => {
    // Five of the first forty-eight candidates were dead. Listing those
    // unchecked is what this half of the rule prevents.
    expect(keepInRegistry('answered-no-wind', false).keep).toBe(false)
    expect(keepInRegistry('stale', false).keep).toBe(false)
  })

  it('gives a known station the benefit of the doubt on a stale reading', () => {
    expect(keepInRegistry('stale', true).keep).toBe(true)
  })

  it('drops anything that stops answering, known or not', () => {
    // The grace is for a station that still responds. A URL that errors is
    // not being kept warm.
    expect(keepInRegistry('no-answer', true).keep).toBe(false)
    expect(keepInRegistry('no-answer', false).keep).toBe(false)
  })

  it('is never more permissive for an unknown station than a known one', () => {
    for (const o of OUTCOMES) {
      const known = keepInRegistry(o, true).keep
      const unknown = keepInRegistry(o, false).keep
      expect(unknown && !known, `${o} kept an unknown station but not a known one`).toBe(false)
    }
  })

  it('always says why, because a person reads the run log to decide to trust it', () => {
    for (const o of OUTCOMES) {
      for (const known of [true, false]) {
        expect(keepInRegistry(o, known).why.trim()).not.toBe('')
      }
    }
  })
})

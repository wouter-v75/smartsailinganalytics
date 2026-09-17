// The settings object is the only thing between a boat's log and its reference data,
// so the tests are about what happens when it is WRONG — a stale stored object, a typo
// in a field, a combination that quietly yields rubbish.
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SETTINGS, DEFAULT_GATE, withSettings, settingsWarnings, resolutionNote,
  PHASE_LENGTHS, TEST_DURATIONS_MIN, DEFAULT_TEST_MIN,
} from '../phaseSettings'

describe('withSettings', () => {
  it('is the published defaults when a boat has no overrides', () => {
    expect(withSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(withSettings(undefined).gate).toEqual(DEFAULT_GATE)
  })

  it('takes a boat’s overrides and leaves the rest alone', () => {
    const s = withSettings({ phaseLenS: 10, gate: { twsDriftMaxKn: 2 } as never })
    expect(s.phaseLenS).toBe(10)
    expect(s.gate.twsDriftMaxKn).toBe(2)
    expect(s.gate.awaDriftMaxDeg).toBe(DEFAULT_GATE.awaDriftMaxDeg)
    expect(s.guardAfterS).toBe(DEFAULT_SETTINGS.guardAfterS)
  })

  it('falls back rather than failing on a junk value', () => {
    const s = withSettings({ phaseLenS: NaN, minCoverage: 'most' as never, gate: { rotMaxDegS: null } as never })
    expect(s.phaseLenS).toBe(DEFAULT_SETTINGS.phaseLenS)
    expect(s.minCoverage).toBe(DEFAULT_SETTINGS.minCoverage)
    expect(s.gate.rotMaxDegS).toBe(DEFAULT_GATE.rotMaxDegS)
  })

  it('clamps a value that would make the builder nonsense', () => {
    const s = withSettings({ phaseLenS: 0, minCoverage: 4, gate: { awaSpreadMaxDeg: 5000 } as never })
    expect(s.phaseLenS).toBeGreaterThanOrEqual(5)
    expect(s.minCoverage).toBe(1)
    expect(s.gate.awaSpreadMaxDeg).toBe(180)
  })

  it('keeps manoeuvre phases on by default — they are what calibration is read from', () => {
    expect(withSettings().manoeuvrePhases).toBe(true)
    expect(withSettings({ manoeuvrePhases: false }).manoeuvrePhases).toBe(false)
  })
})

describe('settingsWarnings', () => {
  it('says nothing about the defaults', () => {
    expect(settingsWarnings(DEFAULT_SETTINGS)).toEqual([])
  })

  it('catches a guard shorter than a phase — a phase would start in the manoeuvre’s wake', () => {
    const w = settingsWarnings(withSettings({ phaseLenS: 60, guardAfterS: 20 }))
    expect(w.join(' ')).toMatch(/guard after a manoeuvre/i)
  })

  it('warns that a length other than 30 s no longer lines up with the event file', () => {
    expect(settingsWarnings(withSettings({ phaseLenS: 10, guardAfterS: 20 })).join(' ')).toMatch(/event file/i)
  })

  it('warns about a coverage that averages a phase from less than half its rows', () => {
    expect(settingsWarnings(withSettings({ minCoverage: 0.3 })).join(' ')).toMatch(/coverage/i)
  })
})

describe('resolutionNote', () => {
  it('refuses the ~6 s cloud copy of a log', () => {
    expect(resolutionNote(6, 30)).toMatch(/full-resolution log/i)
  })

  it('is quiet about a 1 Hz log', () => {
    expect(resolutionNote(1, 30)).toBeNull()
  })

  it('counts the rows when a short phase meets a coarse log', () => {
    expect(resolutionNote(2, 10)).toMatch(/~5 rows/)
  })

  it('says nothing when the resolution is unknown', () => {
    expect(resolutionNote(null, 30)).toBeNull()
  })
})

describe('offered choices', () => {
  it('offers the event file’s own 30 s among the phase lengths', () => {
    expect(PHASE_LENGTHS).toContain(30)
  })

  it('offers the test durations the team asked for, defaulting to 2 min', () => {
    expect(TEST_DURATIONS_MIN).toEqual([1, 2, 5, 7])
    expect(TEST_DURATIONS_MIN).toContain(DEFAULT_TEST_MIN)
  })
})

import { describe, it, expect } from 'vitest'
import { CHANNELS, computePhaseStats, type LogRow } from '../../phaseStats'
import { coverageNote } from '../askData'
import { CORE_METRICS, validate, type ComparePhasesArgs } from '../askTools'
import { vocabularyBlock } from '../vocabulary'
import type { PhaseStat } from '../../phaseStats'

const toeIn = CHANNELS.find(c => c.key === 'toeIn')!
const ctx = { tack: 'stbd' as const, mode: 'up' as const, polar: null }
const at = (r: Partial<LogRow>) => toeIn.get(r as LogRow, ctx)

// The crew's own definition, typed into the box on 23 Sep:
//   "toe in = difference between stb and port rudder angle"
describe('the toe-in channel', () => {
  it('is starboard minus port, signed', () => {
    expect(at({ ruddS: -8.84, ruddP: -5.36 })).toBeCloseTo(-3.48, 6)
    expect(at({ ruddS: 2, ruddP: -1 })).toBe(3)
  })

  it('does not flip with the tack, unlike `rudder`', () => {
    const port = toeIn.get({ ruddS: 2, ruddP: -1 } as LogRow, { ...ctx, tack: 'port' })
    expect(port).toBe(3)
  })

  it('needs both rudders — one alone says nothing about the angle between them', () => {
    expect(at({ ruddS: 2 })).toBeNull()
    expect(at({ ruddP: -1 })).toBeNull()
    expect(at({})).toBeNull()
  })

  it('caps at ±20°, which the real range (−15 to +12) sits inside', () => {
    expect(toeIn.lo).toBe(-20)
    expect(toeIn.hi).toBe(20)
  })

  it('is computed on a phase from real-shaped rows', () => {
    const rows: LogRow[] = Array.from({ length: 30 }, (_, i) => ({
      utc: 1_000_000 + i * 1000, twa: 42, ruddP: -5.36, ruddS: -8.84, tws: 14, bsp: 10,
    }))
    const [phase] = computePhaseStats(rows, { phases: [{ utc: 1_000_000, endUtc: 1_030_000, mode: 1 }] })
    expect(phase.mean.toeIn).toBeCloseTo(-3.48, 2)
  })

  it('is askable, nameable and rankable', () => {
    expect(CORE_METRICS).toContain('toeIn')
    const v = validate('compare_phases', JSON.stringify({ by: ['tack'], metrics: ['toeIn'] }))
    expect(v.ok).toBe(true)
    if (v.ok) expect((v.args as ComparePhasesArgs).metrics).toEqual(['toeIn'])
    expect(vocabularyBlock([], null)).toContain('toe-in')
  })
})

// Toe-in exists on 13 of 33 stored days: the rest cannot be rebuilt from the cloud
// log. Averaging over the 13 while looking like an answer from all 33 is the failure
// this guards against.
describe('coverage, when a channel is only on some of the days', () => {
  const phase = (date: string, toe: number | null): PhaseStat & { date: string } => ({
    utc: 1, endUtc: 2, mode: 'up', tack: 'port', sails: [], sailCombo: 'J4', race: null, n: 5,
    mean: { vmgPct: 97, ...(toe == null ? {} : { toeIn: toe }) }, max: {}, date,
  } as PhaseStat & { date: string })

  it('says nothing when the metric is on everything', () => {
    expect(coverageNote([phase('a', -1), phase('b', -2)], ['toeIn'])).toBe('')
  })

  it('counts the phases AND the days when it is not', () => {
    const phases = [phase('a', -1), phase('a', -2), phase('b', null), phase('c', null)]
    const note = coverageNote(phases, ['toeIn'])
    expect(note).toContain('2 of 4 phases')
    expect(note).toContain('1 of 3 days')
    expect(note).toContain('not the whole period')
  })

  it('says plainly when the metric is on none of them', () => {
    expect(coverageNote([phase('a', null)], ['toeIn'])).toContain('none of these phases')
  })

  it('does not nag about a metric that is merely a little short', () => {
    const phases = [...Array.from({ length: 19 }, (_, i) => phase(`d${i}`, -1)), phase('x', null)]
    expect(coverageNote(phases, ['toeIn'])).toBe('')
  })

  it('reports only the metric that is short, not the healthy one beside it', () => {
    const phases = [phase('a', -1), phase('b', null), phase('c', null)]
    const note = coverageNote(phases, ['vmgPct', 'toeIn'])
    expect(note).toContain('TOE-IN')
    expect(note).not.toContain('VMG%')
  })
})

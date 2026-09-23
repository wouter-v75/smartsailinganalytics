import { describe, it, expect } from 'vitest'
import {
  validate, applyTokenEdit, tokensFor, describeCall, DEFAULT_MIN_PHASES,
  type ComparePhasesArgs, type FindMediaArgs, type DayTimeseriesArgs,
} from '../askTools'

const compare = (o: Record<string, unknown>) => validate('compare_phases', JSON.stringify(o))

describe('validate — the gate between the model and the maths', () => {
  it('accepts a well-formed comparison and fills the defaults', () => {
    const v = compare({ by: ['tack'], metrics: ['vmgPct'], modes: ['up'] })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const a = v.args as ComparePhasesArgs
    expect(a.by).toEqual(['tack'])
    expect(a.minPhases).toBe(DEFAULT_MIN_PHASES)
    expect(a.modes).toEqual(['up'])
  })

  // The live model really did write metrics: ["speed"] on the first try. A throw
  // here would be a 500; a sentence is a retry.
  it('rejects an invented metric with a message the model can act on', () => {
    const v = compare({ by: ['tack'], metrics: ['speed'] })
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.error).toContain('speed')
    expect(v.error).toContain('vmgPct')
  })

  it('keeps the good metrics and drops the invented one', () => {
    const v = compare({ by: ['tack'], metrics: ['vmgPct', 'speed'] })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect((v.args as ComparePhasesArgs).metrics).toEqual(['vmgPct'])
  })

  it('accepts a lidar channel without enumerating all 54 of them', () => {
    const v = compare({ by: ['tack'], metrics: ['jibCa50', 'tMnTw75'] })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect((v.args as ComparePhasesArgs).metrics).toEqual(['jibCa50', 'tMnTw75'])
  })

  it('rejects an unknown grouping key', () => {
    const v = compare({ by: ['crewMember'], metrics: ['vmgPct'] })
    expect(v.ok).toBe(false)
  })

  it('takes a lone `mode` as one-of-modes — the mistake the model makes most', () => {
    const v = compare({ by: ['tack'], metrics: ['vmgPct'], mode: 'up' })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect((v.args as ComparePhasesArgs).modes).toEqual(['up'])
  })

  it('swaps a reversed range rather than returning nothing', () => {
    const v = compare({ by: ['tack'], metrics: ['vmgPct'], twsMin: 22, twsMax: 14 })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const a = v.args as ComparePhasesArgs
    expect([a.twsMin, a.twsMax]).toEqual([14, 22])
  })

  it('swaps a reversed date range', () => {
    const v = compare({ by: ['date'], metrics: ['vmgPct'], dateFrom: '2026-09-11', dateTo: '2026-09-01' })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const a = v.args as ComparePhasesArgs
    expect([a.dateFrom, a.dateTo]).toEqual(['2026-09-01', '2026-09-11'])
  })

  it('drops a malformed date rather than passing it to SQL', () => {
    const v = compare({ by: ['tack'], metrics: ['vmgPct'], dateFrom: 'last Tuesday' })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect((v.args as ComparePhasesArgs).dateFrom).toBeUndefined()
  })

  it('survives arguments that are not JSON at all', () => {
    const v = validate('compare_phases', 'by: tack')
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.error).toContain('JSON')
  })

  it('names the real tools when asked for one that does not exist', () => {
    const v = validate('run_sql', '{}')
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.error).toContain('compare_phases')
  })

  it('caps find_media at a dozen items however many are asked for', () => {
    const v = validate('find_media', JSON.stringify({ kinds: ['photo'], limit: 500 }))
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect((v.args as FindMediaArgs).limit).toBe(12)
  })

  it('rejects a media call with no kind it recognises', () => {
    const v = validate('find_media', JSON.stringify({ kinds: ['drone_footage'] }))
    expect(v.ok).toBe(false)
  })
})

describe('search tokens', () => {
  it('renders a resolved call as something a crew member can read', () => {
    const v = compare({ by: ['tack'], metrics: ['vmgPct'], modes: ['up'], twsMin: 14, twsMax: 18 })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const text = describeCall(v.name, v.args, '2026-09-11').join(' · ')
    expect(text).toContain('2026-09-11')
    expect(text).toContain('Upwind')
    expect(text).toContain('TWS 14–18 kn')
    expect(text).toContain('by tack')
  })

  it('labels a call that named no day with the day that is open', () => {
    const v = compare({ by: ['tack'], metrics: ['vmgPct'] })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(describeCall(v.name, v.args, '2026-09-11')[0]).toBe('2026-09-11')
  })

  it('gives every editable token the choices it may be set to', () => {
    const v = compare({ by: ['tack'], metrics: ['vmgPct'], modes: ['up'] })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const modes = tokensFor(v.name, v.args, null).find(t => t.path === 'modes')
    expect(modes?.options?.map(o => o.value)).toEqual(['up', 'down', 'reach'])
  })

  it('applies an edited wind band', () => {
    const v = compare({ by: ['tack'], metrics: ['vmgPct'], twsMin: 14, twsMax: 18 })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const edited = applyTokenEdit(v.name, v.args, 'tws', ['20', ''])
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    const a = edited.args as ComparePhasesArgs
    expect(a.twsMin).toBe(20)
    expect(a.twsMax).toBeUndefined()
  })

  it('applies an edited day range to both the range and the single date', () => {
    const v = validate('day_timeseries', JSON.stringify({ channels: ['tws'], date: '2026-09-11' }))
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const edited = applyTokenEdit(v.name, v.args, 'dateRange', ['2026-09-08', '2026-09-08'])
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect((edited.args as DayTimeseriesArgs).date).toBe('2026-09-08')
  })

  // The whole point of routing the edit back through validate(): a person must
  // not be able to steer a tool anywhere the model could not.
  it('refuses an edit that would put the tool outside its schema', () => {
    const v = compare({ by: ['tack'], metrics: ['vmgPct'] })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(applyTokenEdit(v.name, v.args, 'by', ['crewMember']).ok).toBe(false)
    expect(applyTokenEdit(v.name, v.args, 'metrics', ['gut feel']).ok).toBe(false)
  })
})

// Two sources of phases for the same water. The rules that matter are the ones that
// stop the same seconds being counted twice, and the ones that stop a decision being
// irreversible.
import { describe, it, expect } from 'vitest'
import {
  findOverlaps, mergePhases, phasesForSource, resolutionOf, upsertRun, removeRun, phasesOfRun, runLabel,
  type PhaseRun, type SsaPhaseDoc,
} from '../ssaPhases'
import { SSA_MODE, type BuiltPhase } from '../buildPhases'
import { withSettings } from '../phaseSettings'
import type { Phase } from '../phaseStats'

const T0 = Date.UTC(2026, 8, 11, 10, 0, 0)
const ev = (startS: number, lenS = 30): Phase => ({ utc: T0 + startS * 1000, endUtc: T0 + (startS + lenS) * 1000, mode: 1 })
const ssa = (startS: number, lenS = 30, kind: BuiltPhase['kind'] = 'steady'): BuiltPhase => ({
  utc: T0 + startS * 1000, endUtc: T0 + (startS + lenS) * 1000, mode: SSA_MODE, src: 'ssa', kind, quality: 0.8,
})

describe('findOverlaps', () => {
  it('finds where the two sources cover the same water, and by how much', () => {
    const o = findOverlaps([ev(0), ev(30)], [ssa(15)])
    expect(o).toHaveLength(2)
    expect(o[0].pctOfSsa).toBeCloseTo(0.5)
  })

  it('is empty when they sit side by side', () => {
    expect(findOverlaps([ev(0)], [ssa(30)])).toHaveLength(0)
  })
})

describe('mergePhases', () => {
  const event = [ev(0), ev(30), ev(60)]

  it('add: the event file stands and a clashing SSA phase stays out', () => {
    const m = mergePhases(event, [ssa(15), ssa(120)], 'add')
    expect(m.keptEvent).toBe(3)
    expect(m.droppedSsa).toBe(1)
    expect(m.phases.map(p => p.utc)).toContain(T0 + 120_000)
    expect(m.phases.filter(p => p.utc === T0 + 15_000)).toHaveLength(0)
  })

  it('override: the hand-built phases win where they were built', () => {
    const m = mergePhases(event, [ssa(15)], 'override')
    expect(m.droppedEvent).toBe(2)          // the two event phases it straddles
    expect(m.keptSsa).toBe(1)
    // Left standing: the SSA phase, and the one event phase it never touched.
    expect(m.phases.map(p => p.utc)).toEqual([T0 + 15_000, T0 + 60_000])
  })

  it('never drops a manoeuvre phase — calibration is read from those', () => {
    const m = mergePhases(event, [ssa(10, 20, 'tack'), ssa(45, 20, 'gybe')], 'add')
    const kinds = m.phases.filter((p): p is BuiltPhase => 'kind' in p).map(p => p.kind)
    expect(kinds).toEqual(['tack', 'gybe'])
    expect(m.droppedSsa).toBe(0)
    expect(m.keptEvent).toBe(3)
  })

  it('ignores a one-second brush past a neighbouring phase', () => {
    const m = mergePhases([ev(0)], [ssa(29, 30)], 'add')   // 1 s of 30 = 3 %
    expect(m.droppedSsa).toBe(0)
    expect(m.overlaps).toHaveLength(0)
  })

  it('returns everything in time order, ready to average', () => {
    const m = mergePhases(event, [ssa(200), ssa(140)], 'add')
    const utcs = m.phases.map(p => p.utc)
    expect([...utcs].sort((a, b) => a - b)).toEqual(utcs)
  })

  it('copes with one source being absent', () => {
    expect(mergePhases(null, [ssa(0)], 'add').keptSsa).toBe(1)
    expect(mergePhases(event, null, 'override').keptEvent).toBe(3)
  })
})

describe('phasesForSource', () => {
  it('shows one source, the other, or both resolved', () => {
    const event = [ev(0)], built = [ssa(15)]
    expect(phasesForSource('event', event, built)).toHaveLength(1)
    expect(phasesForSource('ssa', event, built)[0].utc).toBe(T0 + 15_000)
    expect(phasesForSource('both', event, built, 'add')).toHaveLength(1)
    expect(phasesForSource('both', event, built, 'override')[0].utc).toBe(T0 + 15_000)
  })
})

describe('resolutionOf', () => {
  it('records what was decided, so an upload can be explained afterwards', () => {
    const m = mergePhases([ev(0), ev(30)], [ssa(15)], 'override')
    const r = resolutionOf(m, 'override', 'user-1')
    expect(r).toMatchObject({ mode: 'override', droppedEvent: 2, keptSsa: 1, byUserId: 'user-1' })
    expect(r.at).toBeGreaterThan(0)
  })
})

describe('runs', () => {
  const run = (id: string, from = 0): PhaseRun => ({
    id, name: `run ${id}`, tags: ['line-up'], from: T0 + from * 1000, to: T0 + (from + 120) * 1000,
    createdAt: Date.now(), kind: 'selection', settings: withSettings(),
  })

  it('tags every phase with its run and replaces a re-run', () => {
    let doc: SsaPhaseDoc | null = null
    doc = upsertRun(doc, run('a'), [ssa(0), ssa(30)], '2026-09-11')
    expect(phasesOfRun(doc, 'a')).toHaveLength(2)
    // Same run, rebuilt with other settings: the old phases must not linger.
    doc = upsertRun(doc, run('a'), [ssa(0)], '2026-09-11')
    expect(doc.phases).toHaveLength(1)
    expect(doc.runs).toHaveLength(1)
  })

  it('keeps runs and phases apart from each other’s runs', () => {
    let doc = upsertRun(null, run('a'), [ssa(0)], '2026-09-11')
    doc = upsertRun(doc, run('b', 200), [ssa(200)], '2026-09-11')
    expect(doc.runs.map(r => r.id)).toEqual(['a', 'b'])
    doc = removeRun(doc, 'a')
    expect(doc.runs.map(r => r.id)).toEqual(['b'])
    expect(doc.phases.every(p => p.runId === 'b')).toBe(true)
  })

  it('always has something to call a run', () => {
    expect(runLabel({ ...run('a'), name: '' })).toBe('Selection')
    expect(runLabel({ ...run('a'), name: '', kind: 'test' })).toBe('Test run')
    expect(runLabel(run('a'))).toBe('run a')
  })
})

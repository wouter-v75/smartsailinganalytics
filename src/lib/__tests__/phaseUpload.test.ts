// What a coach is agreeing to when they upload. The plan is the whole safety mechanism:
// it has to say, before the button is pressed, whose phases win where the two sources
// cover the same water.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { planUpload, planSentence, uploadPhaseSet } from '../phaseUpload'
import { withSettings } from '../phaseSettings'
import { SSA_MODE, type BuiltPhase } from '../buildPhases'
import type { Phase } from '../phaseStats'

const T0 = Date.UTC(2026, 8, 11, 10, 0, 0)
const ev = (s: number, len = 30): Phase => ({ utc: T0 + s * 1000, endUtc: T0 + (s + len) * 1000, mode: 1 })
const ssa = (s: number, len = 30, kind: BuiltPhase['kind'] = 'steady'): BuiltPhase => ({
  utc: T0 + s * 1000, endUtc: T0 + (s + len) * 1000, mode: SSA_MODE, src: 'ssa', kind, quality: 0.9,
})

describe('planUpload', () => {
  const event = [ev(0), ev(30), ev(60)]

  it('add: leaves out the phases that cover seconds the event file already has', () => {
    const plan = planUpload(event, [ssa(15), ssa(200)], 'add')
    expect(plan.toUpload.map(p => p.utc)).toEqual([T0 + 200_000])
    expect(plan.overlapping).toBe(1)
    expect(plan.standDownEvent).toBe(0)
  })

  it('override: uploads them all and says how many event phases stand aside', () => {
    const plan = planUpload(event, [ssa(15)], 'override')
    expect(plan.toUpload).toHaveLength(1)
    expect(plan.standDownEvent).toBe(2)
  })

  it('keeps manoeuvre phases whatever the mode — calibration needs them', () => {
    const plan = planUpload(event, [ssa(10, 20, 'tack'), ssa(15)], 'add')
    expect(plan.toUpload.filter(p => p.kind === 'tack')).toHaveLength(1)
    expect(plan.manoeuvres).toBe(1)
  })

  it('has nothing to upload when the event file covers everything', () => {
    expect(planUpload(event, [ssa(15)], 'add').toUpload).toHaveLength(0)
  })
})

describe('planSentence', () => {
  it('says what pressing upload will do', () => {
    const add = planSentence(planUpload([ev(0), ev(30)], [ssa(15), ssa(200), ssa(10, 20, 'gybe')], 'add'))
    expect(add).toMatch(/2 phases/)
    expect(add).toMatch(/1 of them tacks or gybes, kept for calibration/)
    expect(add).toMatch(/1 left out where the event file already covers/)
    const over = planSentence(planUpload([ev(0), ev(30)], [ssa(15)], 'override'))
    expect(over).toMatch(/2 event-file phases stood aside/)
  })
})

describe('uploadPhaseSet', () => {
  afterEach(() => vi.unstubAllGlobals())

  const args = (plan: ReturnType<typeof planUpload>) => ({
    plan, eventPhases: [ev(0)], builtPhases: [ssa(200)], runs: [], settings: withSettings(),
  })

  it('refuses an upload with nothing in it rather than writing an empty set', async () => {
    const plan = planUpload([ev(0)], [ssa(0)], 'add')
    const res = await uploadPhaseSet('t', 'b', '2026-09-11', args(plan))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/nothing to upload/)
  })

  it('sends the phases, the mode and what the choice dropped', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ set: { id: 's1', phase_count: 1, created_at: '2026-09-11T10:00:00Z' } }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const plan = planUpload([ev(0)], [ssa(200)], 'override')
    const res = await uploadPhaseSet('team-1', 'boat-1', '2026-09-11', args(plan))
    expect(res.ok).toBe(true)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/teams/team-1/boats/boat-1/phases/2026-09-11')
    expect(body.mode).toBe('override')
    expect(body.phases).toHaveLength(1)
    expect(body.resolution).toMatchObject({ mode: 'override' })
  })

  it('says plainly when the table is not there yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 503, json: async () => ({ error: 'session_phases not found — run migration 0069', needsMigration: true }),
    }))
    const res = await uploadPhaseSet('t', 'b', '2026-09-11', args(planUpload([ev(0)], [ssa(200)], 'add')))
    expect(res.ok).toBe(false)
    expect(res.needsMigration).toBe(true)
  })

  it('does not report success when the server answers without a set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }))
    const res = await uploadPhaseSet('t', 'b', '2026-09-11', args(planUpload([ev(0)], [ssa(200)], 'add')))
    expect(res.ok).toBe(false)
  })

  it('survives the connection dropping mid-upload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const res = await uploadPhaseSet('t', 'b', '2026-09-11', args(planUpload([ev(0)], [ssa(200)], 'add')))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Failed to fetch/)
  })
})

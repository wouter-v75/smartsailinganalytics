import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { gradeCase, summarise, formatSummary, type EvalOutcome, type GoldCase } from '../askEval'
import { TOOL_NAMES, validate } from '../askTools'

const gold = (expect_: GoldCase['expect']): GoldCase =>
  ({ id: 'c', question: 'q', date: '2026-09-11', expect: expect_ })

const out = (o: Partial<EvalOutcome> = {}): EvalOutcome =>
  ({ steps: [], lines: ['a number, 96.4'], dropped: [], evidence: '', ...o })

const step = (tool: string, args: Record<string, unknown> = {}) =>
  ({ tool: tool as never, args })

describe('gradeCase — it grades the tool call, not the prose', () => {
  it('passes when the right tool ran with the right arguments', () => {
    const r = gradeCase(
      gold({ tools: ['scatter_phases'], args: { scatter_phases: { x: 'sog', y: 'bsp' } } }),
      out({ steps: [step('scatter_phases', { x: 'sog', y: 'bsp', splitBy: 'tack' })] }),
    )
    expect(r.pass).toBe(true)
  })

  it('fails when the tool was not called, and says what was', () => {
    const r = gradeCase(gold({ tools: ['scatter_phases'] }), out({ steps: [step('day_timeseries')] }))
    expect(r.pass).toBe(false)
    expect(r.failures[0]).toContain('day_timeseries')
  })

  // The failure that started the whole eval: a scatter question answered with
  // two traces against the clock.
  it('fails on the WRONG tool even when a right one also ran', () => {
    const r = gradeCase(
      gold({ tools: ['scatter_phases'], notTools: ['day_timeseries'] }),
      out({ steps: [step('scatter_phases', {}), step('day_timeseries', {})] }),
    )
    expect(r.pass).toBe(false)
    expect(r.failures.join(' ')).toContain('wrong tool')
  })

  it('fails when an argument is subtly wrong, which is the whole point', () => {
    const r = gradeCase(
      gold({ args: { compare_phases: { by: ['tack'] } } }),
      out({ steps: [step('compare_phases', { by: ['twsBand'] })] }),
    )
    expect(r.pass).toBe(false)
    expect(r.failures[0]).toContain('args wrong')
  })

  it('matches array arguments as a subset, not an exact list', () => {
    const r = gradeCase(
      gold({ args: { compare_phases: { modes: ['up'] } } }),
      out({ steps: [step('compare_phases', { modes: ['up', 'down'] })] }),
    )
    expect(r.pass).toBe(true)
  })

  it('accepts when ANY call of a tool satisfies the expectation', () => {
    const r = gradeCase(
      gold({ args: { find_media: { kinds: ['sailscan'] } } }),
      out({ steps: [step('find_media', { kinds: ['photo'] }), step('find_media', { kinds: ['sailscan'] })] }),
    )
    expect(r.pass).toBe(true)
  })

  it('catches "the season" being read as one day', () => {
    const one = gradeCase(gold({ multiDay: true }), out({ steps: [step('compare_phases', { dateFrom: '2026-09-11', dateTo: '2026-09-11' })] }))
    expect(one.pass).toBe(false)
    expect(one.failures[0]).toContain('read as one')
    const many = gradeCase(gold({ multiDay: true }), out({ steps: [step('compare_phases', { dateFrom: '2026-07-27', dateTo: '2026-10-03' })] }))
    expect(many.pass).toBe(true)
  })

  it('checks a refusal in both directions', () => {
    expect(gradeCase(gold({ blocked: true }), out({ blocked: true })).pass).toBe(true)
    expect(gradeCase(gold({ blocked: true }), out({ steps: [step('compare_phases')] })).pass).toBe(false)
    expect(gradeCase(gold({ tools: ['compare_phases'] }), out({ blocked: true })).failures.join(' ')).toContain('declined')
  })

  it('fails on any sentence the number check dropped', () => {
    const r = gradeCase(gold({}), out({ dropped: ['Starboard was 2.7 points better.'] }))
    expect(r.pass).toBe(false)
    expect(r.failures[0]).toContain('2.7')
  })

  it('does not demand answer lines from a refusal', () => {
    expect(gradeCase(gold({ blocked: true, minLines: 3 }), out({ blocked: true, lines: [] })).pass).toBe(true)
  })

  it('checks the evidence actually mentions what was asked for', () => {
    expect(gradeCase(gold({ mentions: ['J2_B'] }), out({ evidence: 'scan of J2_B 2026' })).pass).toBe(true)
    expect(gradeCase(gold({ mentions: ['J2_B'] }), out({ evidence: 'scan of MAIN_A' })).failures[0]).toContain('J2_B')
  })
})

describe('formatSummary', () => {
  it('counts, and puts the reasons under the failures', () => {
    const s = summarise([
      { id: 'ok', pass: true, failures: [] },
      { id: 'bad', pass: false, failures: ['did not call scatter_phases'] },
    ])
    const text = formatSummary(s)
    expect(text).toContain('✓ ok')
    expect(text).toContain('did not call scatter_phases')
    expect(text).toContain('1/2 passed')
  })
})

// A golden set that cannot run is worse than none, and a typo in a tool name
// would quietly make a case unfalsifiable rather than failing loudly.
describe('the golden set itself', () => {
  const cases: GoldCase[] = readFileSync(resolve('evals/ask/gold.jsonl'), 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l))

  it('is not empty and every id is unique', () => {
    expect(cases.length).toBeGreaterThan(10)
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length)
  })

  it('names only tools that exist', () => {
    for (const c of cases) {
      for (const t of [...(c.expect.tools || []), ...(c.expect.notTools || []), ...Object.keys(c.expect.args || {})]) {
        expect(TOOL_NAMES, `${c.id} names ${t}`).toContain(t)
      }
    }
  })

  it('expects only arguments the validator would actually accept', () => {
    for (const c of cases) {
      for (const [tool, args] of Object.entries(c.expect.args || {})) {
        const v = validate(tool, JSON.stringify(args))
        // A partial expectation may be missing required fields; what must not
        // happen is an expectation the validator would reject on its VALUES.
        if (!v.ok) expect(v.error, `${c.id} / ${tool}`).toMatch(/needs|required/i)
      }
    }
  })

  it('has a date on every case, since the open day changes the answer', () => {
    for (const c of cases) expect(c.date, c.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('still covers the four questions that failed live', () => {
    const ids = cases.map(c => c.id)
    expect(ids).toContain('season-scatter-sog-bsp')   // drew two time series
    expect(ids).toContain('sailscan-by-name')          // underscore lost the scans
    expect(ids).toContain('refuse-who')                // would have invented a name
    expect(ids).toContain('dominant-parameter')        // the newest tool
  })
})

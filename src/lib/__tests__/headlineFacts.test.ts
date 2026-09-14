import { describe, it, expect } from 'vitest'
import { buildHeadlineFacts, buildHeadlineMessages, numbersIn, factNumbers, validateHeadlines } from '../headlineFacts'
import type { PhaseStat } from '../phaseStats'
import type { Manoeuvre } from '../manoeuvres'

let t = Date.UTC(2026, 8, 11, 10, 18, 59)
const phase = (mode: 'up' | 'down', tack: 'port' | 'stbd', mean: Record<string, number>): PhaseStat =>
  ({ utc: (t += 30_000), endUtc: t + 30_000, mode, tack, sails: [], sailCombo: 'J4_A 2026', race: 1, n: 5, mean, max: {} })
const stats = [
  phase('up', 'port', { tws: 23.1, bsp: 11.88, twa: 39.7, bspPol: 98.2, vmgPct: 96, heel: 21.9 }),
  phase('up', 'stbd', { tws: 23.7, bsp: 11.73, twa: 39.1, bspPol: 98.0, vmgPct: 95.5, heel: 22.4 }),
  phase('down', 'port', { tws: 23.1, bsp: 21.47, twa: 146.2, bspPol: 97.6, vmgPct: 95.4, heel: 13.7 }),
]
const tack = (utc: number, over: Partial<Manoeuvre> = {}): Manoeuvre => ({
  utc, kind: 'tack', source: 'event', context: 'race', race: 1, atMark: false, intoMark: false, shortHitch: false, logGap: false,
  from: 'stbd', to: 'port', sails: 'J4_A 2026', tws: 23, bspBefore: 11.45, bspAfter: 9.58, timeTo95: 30, distLost: 21.8,
  maxRotation: 6, turnAngle: 77.04, target: 70, ...over,
})
const manoeuvres = [tack(Date.UTC(2026, 8, 11, 10, 23, 19)), tack(Date.UTC(2026, 8, 11, 10, 39, 10), { atMark: true, timeTo95: 99 })]

const facts = buildHeadlineFacts({
  date: '2026-09-11', stats, manoeuvres, tzOffsetMin: 120, polarName: '37m-VPP-76 v1.7', resolutionSeconds: 6,
  boat: 'Northstar 76', venue: '2026 Porto Cervo',
})

describe('buildHeadlineFacts', () => {
  it('carries the report tables, rounded as the tables show them', () => {
    const bySails = facts.tables.find(x => x.title === 'Upwind by sail combination and tack')!
    expect(bySails.columns.slice(0, 7)).toEqual(['sailCombo', 'tack', 'n', 'TWS (kn)', 'BSP (kn)', 'TWA (deg)', '%Pol'])
    expect(bySails.rows[0].slice(0, 7)).toEqual(['J4_A 2026', 'Port', 1, 23.1, 11.88, 39.7, 98.2])
    expect(facts.counts).toEqual({ phases: 3, upwindPhases: 2, downwindPhases: 1, tacks: 1, gybes: 0 })
  })

  it('lists the judged tacks in venue time with an average, leaving mark roundings out', () => {
    expect(facts.tacks.rows).toEqual([
      ['12:23:19', 'stbd', 'port', 30, 21.8, 11.45, 9.58, 77, 70, ''],
      ['AVERAGE', '', '', 30, 21.8, 11.45, 9.58, 77, 70, '1 judged'],
    ])
    expect(JSON.stringify(facts)).not.toContain('99')
  })

  it('leaves thin band rows out of the facts, but keeps every sails-by-tack row', () => {
    // 3 stbd phases in one heel band, 1 port phase in another
    const many = [
      ...[21, 21.5, 21.8].map(h => phase('up', 'stbd', { tws: 23, bsp: 11.7, twa: 39, bspPol: 98, vmgPct: 95, heel: h })),
      phase('up', 'port', { tws: 23, bsp: 11.9, twa: 40, bspPol: 98.2, vmgPct: 96, heel: 25.3 }),
    ]
    const f = buildHeadlineFacts({ date: '2026-09-11', stats: many, manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 6 })
    const heel = f.tables.find(x => x.title === 'VMG by heel band and tack')!
    expect(heel.rows.map(r => [r[1], r[2]])).toEqual([['Stbd', 3]])            // the 1-phase port row is gone
    const sails = f.tables.find(x => x.title === 'Upwind by sail combination and tack')!
    expect(sails.rows.map(r => [r[1], r[2]])).toEqual([['Port', 1], ['Stbd', 3]])
  })

  it('builds a system + user prompt that forbids computing numbers', () => {
    const [system, user] = buildHeadlineMessages(facts)
    expect(system.content).toMatch(/Never calculate/)
    expect(user.content.startsWith('FACTS:\n{')).toBe(true)
  })
})

describe('number checks', () => {
  it('reads numbers but not times or sail / sensor labels', () => {
    expect(numbersIn('At 12:23:19 the J4_A 2026 tack lost 21.8 m, BSP 11,45 kn, V1 load -4.7 t, A2+B up')).toEqual(['2026', '21.8', '11.45', '-4.7'])
  })

  it('knows every number in the facts, as written with fewer decimals and without sign', () => {
    const known = factNumbers({ a: 98.2, b: [-4.7, 96], c: 'J4_A 2026' })
    for (const n of ['98.2', '4.7', '-4.7', '96', '96.0', '2026']) expect(known.has(n)).toBe(true)
    expect(known.has('97.1')).toBe(false)
  })

  it('drops any sentence with a number the facts do not contain', () => {
    const v = validateHeadlines({
      headlines: [
        '- Upwind the tacks were level: Port 98.2 %Pol against Stbd 98.0.',
        'Port was 0.2 %Pol quicker upwind.',                 // a computed difference
        'The 12:23:19 tack took 30 s to reach 95% BSP and lost 21.8 m.',
      ],
      bottomLine: ['Work on the tack exit: BSP drops from 11.45 to 9.58 kn.', 'Sail 5 degrees lower.'],
    }, facts)
    expect(v.headlines).toEqual([
      'Upwind the tacks were level: Port 98.2 %Pol against Stbd 98.0.',
      'The 12:23:19 tack took 30 s to reach 95% BSP and lost 21.8 m.',
    ])
    expect(v.bottomLine).toEqual(['Work on the tack exit: BSP drops from 11.45 to 9.58 kn.'])
    expect(v.dropped).toEqual(['Port was 0.2 %Pol quicker upwind.', 'Sail 5 degrees lower.'])
  })

  it('keeps at most 8 headlines and 3 bottom-line points, most important first', () => {
    const v = validateHeadlines({
      headlines: Array.from({ length: 10 }, (_, i) => `Headline ${['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][i]}`),
      bottomLine: ['a', 'b', 'c', 'd'],
    }, facts)
    expect(v.headlines).toHaveLength(8)
    expect(v.headlines[7]).toBe('Headline eight')
    expect(v.bottomLine).toEqual(['a', 'b', 'c'])
  })

  it('copes with a model that returns strings or nothing', () => {
    expect(validateHeadlines({ headlines: 'not a list' as any }, facts)).toEqual({ headlines: [], bottomLine: [], dropped: [] })
  })
})

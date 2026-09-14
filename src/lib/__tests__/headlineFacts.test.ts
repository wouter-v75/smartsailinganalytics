import { describe, it, expect } from 'vitest'
import {
  buildHeadlineFacts, buildHeadlineMessages, numbersIn, factNumbers, validateHeadlines, validateSections,
  MIN_SECTION_PHASES,
} from '../headlineFacts'
import type { PhaseStat } from '../phaseStats'
import type { Manoeuvre } from '../manoeuvres'

let t = Date.UTC(2026, 8, 11, 10, 18, 59)
const phase = (mode: 'up' | 'down' | 'reach', tack: 'port' | 'stbd', mean: Record<string, number>): PhaseStat =>
  ({ utc: (t += 30_000), endUtc: t + 30_000, mode, tack, sails: [], sailCombo: 'J4_A 2026', race: 1, n: 30, mean, max: {} })
const xml = { sailsUpEvents: [{ utc: Date.UTC(2026, 8, 11, 10, 0), sails: ['MAIN_B 2026', 'J4_A 2026'] }] }
const up = (tack: 'port' | 'stbd', over: Record<string, number> = {}) =>
  phase('up', tack, { tws: 23.1, bsp: 11.88, twa: 39.7, bspPol: 98.2, vmgPct: 96, heel: 21.9, ...over })
const stats = [
  up('port'), up('port'), up('port'),
  up('stbd', { bsp: 11.73, bspPol: 98.0, vmgPct: 95.5 }), up('stbd', { bsp: 11.73, bspPol: 98.0, vmgPct: 95.5 }), up('stbd', { bsp: 11.73, bspPol: 98.0, vmgPct: 95.5 }),
  ...Array.from({ length: 6 }, (_, i) => phase('down', i % 2 ? 'port' : 'stbd', { tws: 23.1, bsp: 21.47, twa: 146.2, bspPol: 97.6, vmgPct: 95.4, heel: 13.7 })),
  phase('reach', 'port', { tws: 20, bsp: 18, twa: 100, bspPol: 99 }),   // one reaching phase: no section
]
const tack = (utc: number, over: Partial<Manoeuvre> = {}): Manoeuvre => ({
  utc, kind: 'tack', source: 'event', context: 'race', race: 1, atMark: false, intoMark: false, shortHitch: false, logGap: false,
  from: 'stbd', to: 'port', sails: 'J4_A 2026', tws: 23, bspBefore: 11.45, bspAfter: 9.58, timeTo95: 30, distLost: 21.8,
  maxRotation: 6, turnAngle: 77.04, target: 70, ...over,
})
const manoeuvres = [tack(Date.UTC(2026, 8, 11, 10, 23, 19)), tack(Date.UTC(2026, 8, 11, 10, 39, 10), { atMark: true, timeTo95: 99 })]

const facts = buildHeadlineFacts({
  date: '2026-09-11', stats, manoeuvres, tzOffsetMin: 120, polarName: '37m-VPP-76 v1.7', resolutionSeconds: 6,
  boat: 'Northstar 76', venue: '2026 Porto Cervo', xml,
})

describe('buildHeadlineFacts — sections', () => {
  it('gives upwind and downwind their own report tables, and no section to a point of sail barely sailed', () => {
    expect(Object.keys(facts.sections)).toEqual(['upwind', 'downwind'])
    const bySails = facts.sections.upwind!.tables.find(x => x.title === 'Upwind by sail combination and tack')!
    expect(bySails.columns.slice(0, 7)).toEqual(['sailCombo', 'tack', 'n', 'TWS (kn)', 'BSP (kn)', 'TWA (deg)', '%Pol'])
    expect(bySails.rows[0].slice(0, 7)).toEqual(['J4_A 2026', 'Port', 3, 23.1, 11.88, 39.7, 98.2])
    expect(facts.sections.downwind!.tables.every(x => !x.title.startsWith('Upwind'))).toBe(true)
    expect(facts.sections.upwind!.phases).toBe(6)
    expect(MIN_SECTION_PHASES).toBe(6)
  })

  it('tags each section with the main and headsails in use', () => {
    expect(facts.sections.upwind!.sailsInUse.rows).toEqual([['MAIN_B 2026', 'J4_A 2026', 6]])
  })

  it('puts the judged tacks (with their sails) under upwind, in venue time, leaving mark roundings out', () => {
    expect(facts.sections.upwind!.manoeuvres!.rows).toEqual([
      ['12:23:19', 'stbd', 'port', 'J4_A 2026', 30, 21.8, 11.45, 9.58, 77, 70, ''],
      ['AVERAGE', '', '', '', 30, 21.8, 11.45, 9.58, 77, 70, '1 judged'],
    ])
    expect(facts.sections.downwind!.manoeuvres!.title).toBe('Gybes')
    expect(JSON.stringify(facts)).not.toContain('99')
  })

  it('writes a reaching section with %Pol tables when reaching was sailed', () => {
    const reach = Array.from({ length: 6 }, (_, i) => phase('reach', i % 2 ? 'port' : 'stbd', { tws: 20, bsp: 18.2, twa: 101, bspPol: 99.1, heel: 18 }))
    const f = buildHeadlineFacts({ date: '2026-09-11', stats: reach, manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 1, xml })
    expect(Object.keys(f.sections)).toEqual(['reaching'])
    expect(f.sections.reaching!.tables.map(x => x.title)).toEqual(['Reaching by sail combination and tack', '%Pol by TWA band (reaching)'])
  })

  it('leaves thin band rows out of the facts, but keeps every sails-by-tack row', () => {
    const many = [
      ...[21, 21.5, 21.8].map(h => up('stbd', { heel: h })),   // 3 stbd phases in one heel band
      up('port', { heel: 25.3 }), up('port', { heel: 30 }), up('port', { heel: 30.5 }),   // 1 + 2 port phases
    ]
    const f = buildHeadlineFacts({ date: '2026-09-11', stats: many, manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 6 })
    const heel = f.sections.upwind!.tables.find(x => x.title === 'VMG by heel band and tack')!
    expect(heel.rows.map(r => [r[1], r[2]])).toEqual([['Stbd', 3]])
    const sails = f.sections.upwind!.tables.find(x => x.title === 'Upwind by sail combination and tack')!
    expect(sails.rows.map(r => [r[1], r[2]])).toEqual([['Port', 3], ['Stbd', 3]])
  })
})

describe('buildHeadlineFacts — sail shape', () => {
  // 8 upwind phases on MAIN_B: camber 25 % around 7.5 sails at VMG% 97, around 9.5 at 94.
  const shapePhases = [
    ...[7.2, 7.4, 7.6, 7.8].map(ca => up('stbd', { mnCa25: ca, tMnCa25: 4.5, vmgPct: 97 })),
    ...[9.2, 9.4, 9.6, 9.8].map(ca => up('port', { mnCa25: ca, tMnCa25: 4.5, vmgPct: 94 })),
  ]
  const f = buildHeadlineFacts({ date: '2026-09-11', stats: shapePhases, manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 1, xml })

  it('ranks shape bands by the VMG% sailed in them — one table per point of sail, sail and variable, best first', () => {
    const shape = f.sections.sailShape!
    expect(shape.lidarPhases).toBe(8)
    expect(shape.tables.map(x => x.title)).toEqual(['Upwind MAIN_B 2026 Camber 25% — shape bands by VMG%'])
    expect(shape.tables[0].columns).toEqual(['band', 'n', 'VMG%', '%Pol', 'measured', 'target'])
    expect(shape.tables[0].rows).toEqual([
      ['7-8', 4, 97, 98.2, 7.5, 4.5],
      ['9-10', 4, 94, 98.2, 9.5, 4.5],
    ])
  })

  it('drops a shape claim that borrows a band or VMG% from another sail’s table', () => {
    // A jib camber 25 % table as well: bands 11-12 (VMG% 96) and 13-14 (VMG% 93).
    const both = [
      ...[7.2, 7.4, 7.6, 7.8].map(ca => up('stbd', { mnCa25: ca, tMnCa25: 4.5, jibCa25: 11.5, tJibCa25: 6, vmgPct: 96 })),
      ...[9.2, 9.4, 9.6, 9.8].map(ca => up('port', { mnCa25: ca, tMnCa25: 4.5, jibCa25: 13.5, tJibCa25: 6, vmgPct: 93 })),
    ]
    const g = buildHeadlineFacts({ date: 'd', stats: both, manoeuvres: [], tzOffsetMin: 0, polarName: 'p', resolutionSeconds: 1, xml })
    expect(g.sections.sailShape!.tables.map(x => x.title)).toEqual([
      'Upwind MAIN_B 2026 Camber 25% — shape bands by VMG%', 'Upwind J4_A 2026 Camber 25% — shape bands by VMG%',
    ])
    const v = validateSections({
      sailShape: {
        headlines: [
          'MAIN_B 2026 upwind camber 25%: 7-8 gave VMG% 96, 9-10 gave 93.',
          'MAIN_B 2026 upwind camber 25%: 7-8 gave VMG% 96, 13-14 gave 93.',   // 13-14 is the jib's band
        ],
        bottomLine: [],
      },
    }, g)
    expect(v.sections.sailShape!.headlines).toEqual(['MAIN_B 2026 upwind camber 25%: 7-8 gave VMG% 96, 9-10 gave 93.'])
    expect(v.dropped).toEqual(['MAIN_B 2026 upwind camber 25%: 7-8 gave VMG% 96, 13-14 gave 93.'])
  })

  it('leaves out phases that were not steady sailing (start sequences: VMG% 53, %Pol 191)', () => {
    const withStarts = [
      ...shapePhases,
      ...[5.2, 5.4, 5.6].map(ca => up('stbd', { mnCa25: ca, tMnCa25: 4.5, vmgPct: 53, bspPol: 191 })),
    ]
    const g = buildHeadlineFacts({ date: 'd', stats: withStarts, manoeuvres: [], tzOffsetMin: 0, polarName: 'p', resolutionSeconds: 1, xml })
    const main = g.sections.sailShape!.tables.find(x => x.title === 'Upwind MAIN_B 2026 Camber 25% — shape bands by VMG%')!
    expect(main.rows.map(r => r[0])).toEqual(['7-8', '9-10'])   // no 5-6 band from the start phases
    expect(g.sections.sailShape!.lidarPhases).toBe(8)
  })

  it('has no sail shape section without lidar, or with a single band', () => {
    expect(facts.sections.sailShape).toBeUndefined()
    const oneBand = buildHeadlineFacts({ date: 'd', stats: shapePhases.slice(0, 4), manoeuvres: [], tzOffsetMin: 0, polarName: 'p', resolutionSeconds: 1, xml })
    expect(oneBand.sections.sailShape).toBeUndefined()
  })
})

describe('prompt', () => {
  it('asks for sections, sail tags and copied numbers only', () => {
    const [system, user] = buildHeadlineMessages(facts)
    expect(system.content).toMatch(/Never calculate/)
    expect(system.content).toMatch(/Sail tags/)
    expect(system.content).toMatch(/"upwind": \{"headlines"/)
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

  it('checks each section against its own facts, keeping only sections the facts have', () => {
    const v = validateSections({
      upwind: {
        headlines: ['- Port 98.2 %Pol against Stbd 98.0 on MAIN_B 2026 with J4_A 2026.', 'Port was 0.2 %Pol quicker upwind.'],
        bottomLine: ['Work on the tack exit: BSP drops from 11.45 to 9.58 kn.'],
      },
      downwind: { headlines: ['Downwind 97.6 %Pol on both tacks.', 'Downwind BSP 11.88 kn.'], bottomLine: [] },   // 11.88 is an upwind number
      reaching: { headlines: ['Reaching at 99 %Pol.'] },                                                       // no reaching section
    }, facts)
    expect(v.version).toBe(2)
    expect(v.sections.upwind).toEqual({
      headlines: ['Port 98.2 %Pol against Stbd 98.0 on MAIN_B 2026 with J4_A 2026.'],
      bottomLine: ['Work on the tack exit: BSP drops from 11.45 to 9.58 kn.'],
    })
    expect(v.sections.downwind).toEqual({ headlines: ['Downwind 97.6 %Pol on both tacks.'], bottomLine: [] })
    expect(v.sections.reaching).toBeUndefined()
    expect(v.dropped).toEqual(['Port was 0.2 %Pol quicker upwind.', 'Downwind BSP 11.88 kn.'])
  })

  it('drops a sentence that stitches numbers from different tables into one claim', () => {
    const v = validateSections({
      upwind: {
        headlines: [
          'Port 98.2 %Pol on J4_A 2026, and the tacks lost 21.8 m.',          // sails table + tacks table
          'The 12:23:19 tack on J4_A 2026 lost 21.8 m and took 30 s to 95% BSP.', // one table; 95 is a column label
          'MAIN_B 2026 sailed 6 upwind phases at 98.2 %Pol.',                    // phase count is a label
        ],
        bottomLine: [],
      },
    }, facts)
    expect(v.sections.upwind!.headlines).toEqual([
      'The 12:23:19 tack on J4_A 2026 lost 21.8 m and took 30 s to 95% BSP.',
      'MAIN_B 2026 sailed 6 upwind phases at 98.2 %Pol.',
    ])
    expect(v.dropped).toEqual(['Port 98.2 %Pol on J4_A 2026, and the tacks lost 21.8 m.'])
  })

  it('writes in the team’s own jargon — the debrief glossary — without crew or rival names', () => {
    const [system] = buildHeadlineMessages(facts)   // boat: Northstar 76 → the Northstar squad vocabulary
    expect(system.content).toContain('TEAM VOCABULARY')
    expect(system.content).toMatch(/Sails: .*MH0/)
    expect(system.content).toMatch(/Manoeuvres: .*peel/)
    expect(system.content).toMatch(/mo = MH0/)
    expect(system.content).toMatch(/speed-team notes/)
    for (const name of ['Wouter', 'Pedro', 'Bella Mente', 'Django']) expect(system.content).not.toContain(name)
  })

  it('reads "Code 0" and short sail names as labels, not numbers', () => {
    expect(numbersIn('Code 0 up, J1.5 and MH0 at 98.2 %Pol')).toEqual(['98.2'])
  })

  it('tells the model not to steer the shape to target, nor to give an average to one tack', () => {
    const [system] = buildHeadlineMessages(facts)
    expect(system.content).toMatch(/Never advise moving the shape to\s+the target/)
    expect(system.content).toMatch(/AVERAGE row .* never present it as one tack/)
  })

  it('keeps at most 5 headlines and 2 bottom-line points per section, and copes with junk', () => {
    const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven']
    const v = validateSections({ upwind: { headlines: words.map(w => `Headline ${w}`), bottomLine: ['a', 'b', 'c'] }, downwind: 'not an object' }, facts)
    expect(v.sections.upwind!.headlines).toHaveLength(5)
    expect(v.sections.upwind!.bottomLine).toEqual(['a', 'b'])
    expect(v.sections.downwind).toBeUndefined()
    expect(validateSections(null, facts)).toEqual({ version: 2, sections: {}, dropped: [] })
  })

  it('still validates single-list headlines (older days)', () => {
    const v = validateHeadlines({ headlines: ['Port 98.2 %Pol.', 'Port was 0.2 %Pol quicker.'], bottomLine: 'x' as any }, facts)
    expect(v).toEqual({ headlines: ['Port 98.2 %Pol.'], bottomLine: [], dropped: ['Port was 0.2 %Pol quicker.'] })
  })
})

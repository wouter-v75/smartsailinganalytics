import { describe, it, expect } from 'vitest'
import {
  buildHeadlineFacts, buildHeadlineMessages, numbersIn, factNumbers, validateHeadlines, validateSections,
  MIN_SECTION_PHASES, metricNumbers,
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
    expect(f.sections.reaching!.tables.map(x => x.title)).toEqual([
      'Reaching: Port vs Stbd, and against this season at the same wind', 'Reaching by sail combination and tack', '%Pol by TWA band (reaching)',
    ])
    expect(f.sections.reaching!.tables[0].columns[2]).toBe('%Pol')
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

describe('buildHeadlineFacts — tacks and season', () => {
  // Port VMG% 97, Stbd 94.6 → 95; the season's other day sailed VMG% 95 in the same 23 kn.
  const day = [
    up('port', { vmgPct: 97 }), up('port', { vmgPct: 97 }), up('port', { vmgPct: 97 }),
    up('stbd', { bsp: 11.73, vmgPct: 94.6 }), up('stbd', { bsp: 11.73, vmgPct: 94.6 }), up('stbd', { bsp: 11.73, vmgPct: 94.6 }),
  ]
  const other = Array.from({ length: 4 }, (_, i) => ({ u: i, e: i + 30, m: 'up', t: 'port', s: 'J4_A 2026', r: 1, n: 30, v: { tws: 23.1, vmgPct: 95 }, x: {} }))
  const seasonRows = [{ date: '2026-09-10', phases: other }, { date: '2026-09-11', phases: other.map(p => ({ ...p, v: { tws: 23.1, vmgPct: 60 } })) }] as any
  const g = buildHeadlineFacts({ date: '2026-09-11', stats: day, manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 1, xml, seasonRows })

  it('opens each section with port against starboard and the season at this wind, worded', () => {
    const t = g.sections.upwind!.tables[0]
    expect(t.title).toBe('Upwind: Port vs Stbd, and against this season at the same wind')
    expect(t.columns).toEqual(['tack', 'phases', 'VMG%', 'BSP (kn)', 'vs other tack (VMG% points)', 'wording vs other tack',
      'season VMG% at this wind', 'vs season (VMG% points)', 'wording vs season'])
    expect(t.rows).toEqual([
      ['Port', 3, 97, 11.88, 2, '2% faster on port', 95, 2, '2% better than the season average at this wind'],
      ['Stbd', 3, 95, 11.73, -2, '2% slower on starboard', 95, 0, 'level with the season average at this wind'],   // the day itself (60) is left out
    ])
  })

  it('compares only a tack with 3 or more phases (7 Sep: one reaching phase on port)', () => {
    const thinDay = [up('port', { vmgPct: 82 }), ...Array.from({ length: 5 }, () => up('stbd', { vmgPct: 92 }))]
    const t = buildHeadlineFacts({ date: '2026-09-11', stats: thinDay, manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 1, xml, seasonRows }).sections.upwind!.tables[0]
    expect(t.rows[0]).toEqual(['Port', 1, '', '', '', '', '', '', ''])            // count only: nothing to compare with
    expect(t.rows[1].slice(0, 6)).toEqual(['Stbd', 5, 92, 11.88, '', ''])            // no comparison against a one-phase tack
    expect(t.rows[1].slice(6)).toEqual([95, -3, '3% below the season average at this wind'])
  })

  it('says nothing about the season without season data at this wind', () => {
    const t = buildHeadlineFacts({ date: '2026-09-11', stats: day, manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 1, xml }).sections.upwind!.tables[0]
    expect(t.rows[0].slice(6)).toEqual(['', '', ''])
  })

  it('keeps the worded comparison and drops a difference that is not in the table', () => {
    const v = validateSections({
      upwind: {
        headlines: [
          'Upwind: 2% faster on port with VMG% 97, 2% better than the season average at this wind (95).',
          'Upwind: 5% faster on port with VMG% 97.',
        ],
        bottomLine: [],
      },
    }, g)
    expect(v.sections.upwind!.headlines).toEqual(['Upwind: 2% faster on port with VMG% 97, 2% better than the season average at this wind (95).'])
    expect(v.dropped).toEqual(['Upwind: 5% faster on port with VMG% 97.'])
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

describe('buildHeadlineFacts — start', () => {
  // A 1 Hz run-in to a 12:18:00 (venue) gun: close-hauled on stbd, closing the line at 0.1 BL a second.
  const GUN = Date.UTC(2026, 8, 11, 10, 18, 0)
  const rows = Array.from({ length: 421 }, (_, i) => {
    const t = i - 330
    return {
      utc: GUN + t * 1000, bsp: 11, vsTargPct: 95, twa: 40, twaTarg: 35, tws: 20, twd: 280, vmg: 8.4,
      ruddP: 3, ruddS: -6, dstLine: t < 0 ? -t / 10 : 0, tmLine: t < 0 ? 5 : null, lat: 41.15, lon: 9.64,
    }
  })
  const startXml = { ...xml, raceGuns: [{ utc: GUN, raceNum: 5 }], tackJibes: [] }
  const polar = { entries: [{ tws: 10, upTwa: 40, downTwa: 150, upVMG: 8, downVMG: 16 }, { tws: 30, upTwa: 40, downTwa: 150, upVMG: 8, downVMG: 16 }] }
  const f = buildHeadlineFacts({ date: '2026-09-11', stats: [], manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 1, xml: startXml, rows, polar })

  it('opens with a start section: one row per gun, at the gun and 30 s later, with the sails', () => {
    expect(Object.keys(f.sections)).toEqual(['start'])
    const [overview, runIn] = f.sections.start!.tables
    expect(overview.columns.slice(0, 8)).toEqual(['start', 'race', 'gun', 'sails', 'timing at gun', 'line at gun', 'TWS last minute (kn)', 'TWD last minute (deg)'])
    expect(overview.rows).toEqual([[1, 5, '12:18:00', 'J4_A 2026', 'early by 5 s', '0.1 BL below the line', 20, 280, 0.1, 11, 95, 5, 40, 11, 95, 105]])
    expect(runIn.title).toBe('Start 1 (Race 5) run-in, every 10 s (t = seconds to the gun)')
    expect(runIn.rows.map(r => r[0])).toEqual([-120, -110, -100, -90, -80, -70, -60, -50, -40, -30, -20, -10, 0, 10, 20, 30])
    expect(runIn.rows.find(r => r[0] === -60)!.slice(1, 6)).toEqual(['', 6, 11, 95, 40])
    expect(runIn.rows.find(r => r[0] === 0)![1]).toBe('gun')
  })

  it('words the gun the way the crew do: late or early by whole seconds, BL below or over the line', () => {
    // Far out early (so the distance reads as boat lengths), 0.3 BL over the line for the last 10 s,
    // and 0 — no value — from the gun on, so the −0.3 from a second before stands in at the gun.
    const late = rows.map(r => {
      const t = (r.utc - GUN) / 1000
      return { ...r, tmLine: t < 0 ? -3.4 : null, dstLine: t < -10 ? -t / 10 : t < 0 ? -0.3 : 0 }
    })
    const g = buildHeadlineFacts({ date: '2026-09-11', stats: [], manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 1, xml: startXml, rows: late, polar })
    const [ov] = g.sections.start!.tables
    const col = (name: string) => ov.rows[0][ov.columns.indexOf(name)]
    expect([col('timing at gun'), col('Burn at gun (s)')]).toEqual(['late by 3 s', -3])
    expect([col('line at gun'), col('DistLn at gun (BL)')]).toEqual(['0.3 BL over the line', -0.3])
  })

  it('ranks two or more starts by VMG% after the gun, so the bottom line copies rows instead of judging', () => {
    const GUN2 = GUN + 1_200_000
    const two = [...rows, ...rows.map(r => ({ ...r, utc: r.utc + 1_200_000, vmg: 7.2 }))]
    const g = buildHeadlineFacts({ date: '2026-09-11', stats: [], manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 1,
      xml: { ...startXml, raceGuns: [{ utc: GUN, raceNum: 5 }, { utc: GUN2, raceNum: 6 }] }, rows: two, polar })
    const [, ranking, ...runIns] = g.sections.start!.tables
    expect(ranking.title).toBe('Starts ranked by VMG% 30 s after the gun (first row = highest, last row = lowest)')
    expect(ranking.rows).toEqual([[1, 'Race 5', 105, 'early by 5 s'], [2, 'Race 6', 90, 'early by 5 s']])
    expect(runIns).toHaveLength(2)
    const v = validateSections({
      start: {
        headlines: ['Race 5: early for the start by 5 s, 0.1 BL below the line at the gun, 105 VMG% 30 s after the gun, on J4_A 2026.'],
        bottomLine: ['Highest VMG% after the gun: Race 5 (105%), lowest: Race 6 (90%).'],
      },
    }, g)
    expect(v.sections.start).toEqual({
      headlines: ['Race 5: early for the start by 5 s, 0.1 BL below the line at the gun, 105 VMG% 30 s after the gun, on J4_A 2026.'],
      bottomLine: ['Highest VMG% after the gun: Race 5 (105%), lowest: Race 6 (90%).'],
    })
    // one start: no ranking table
    expect(f.sections.start!.tables.map(t => t.title).some(t => t.startsWith('Starts ranked'))).toBe(false)
  })

  it('drops a start sentence that takes a number from another start\'s row (11 Sep: Race 5\'s distance given to Race 6)', () => {
    const GUN2 = GUN + 1_200_000
    // The second run-in closes three times as fast, so it is 0.3 BL from the line at its gun, the first 0.1.
    const two = [...rows, ...rows.map(r => {
      const t = (r.utc - GUN) / 1000
      return { ...r, utc: r.utc + 1_200_000, vmg: 7.2, dstLine: t < 0 ? (-3 * t) / 10 : 0 }
    })]
    const g = buildHeadlineFacts({ date: '2026-09-11', stats: [], manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 1,
      xml: { ...startXml, raceGuns: [{ utc: GUN, raceNum: 5 }, { utc: GUN2, raceNum: 6 }] }, rows: two, polar })
    const v = validateSections({
      start: {
        headlines: [
          'Race 6: 0.1 BL below the line at the gun, 90% VMG 30 s after the gun.',     // 0.1 BL is Race 5's
          'Race 6: 0.3 BL below the line at the gun, 90% VMG 30 s after the gun.',
          'Race 5: 0.1 BL below the line at the gun, 105% VMG 30 s after the gun.',
        ],
        bottomLine: ['Highest VMG% after the gun: Race 5 (105%), lowest: Race 6 (90%).'],   // names two: the ranking table
      },
    }, g)
    expect(v.sections.start!.headlines).toEqual([
      'Race 6: 0.3 BL below the line at the gun, 90% VMG 30 s after the gun.',
      'Race 5: 0.1 BL below the line at the gun, 105% VMG 30 s after the gun.',
    ])
    expect(v.sections.start!.bottomLine).toHaveLength(1)
    expect(v.dropped).toEqual(['Race 6: 0.1 BL below the line at the gun, 90% VMG 30 s after the gun.'])
  })

  it('leaves out start columns the log has no values for (4 and 7 Sep: no BSP_trg%)', () => {
    const noTarget = rows.map(({ vsTargPct: _t, ...r }) => r)
    const g = buildHeadlineFacts({ date: '2026-09-11', stats: [], manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 1, xml: startXml, rows: noTarget, polar })
    const [ov, ri] = g.sections.start!.tables
    expect(ov.columns.filter(c => c.startsWith('BSP_trg%'))).toEqual([])
    expect(ri.columns).not.toContain('BSP_trg%')
    expect(ov.columns.slice(0, 4)).toEqual(['start', 'race', 'gun', 'sails'])   // identity columns always stay
    expect(ov.rows[0].length).toBe(ov.columns.length)
  })

  it('keeps example numbers out of the prompt rules for start and tacks', () => {
    const [system] = buildHeadlineMessages(facts)
    expect(system.content).toMatch(/never copy a number from an example/)
    expect(system.content).toMatch(/never "0 BL"/)
    // No example in the rules carries a real-looking number the model could copy into a day's text
    // (v9 copied "0.4 BL" from rule 12 into four days' starts).
    for (const leaked of [/fell from 111 at −70 s/, /late for the start by 10 s/, /"0\.4 BL"/, /98\.2 %Pol/, /97\.6/, /7-8 gave/]) {
      expect(system.content).not.toMatch(leaked)
    }
  })

  it('accepts the start written as text, and checks its numbers against the right columns', () => {
    const v = validateSections({
      start: {
        headlines: [
          'Race 5: early for the start by 5 s, 0.1 BL below the line at the gun at 95% of target, 105% VMG 30 s after the gun, on J4_A 2026.',
          'Race 5: 95% VMG 30 s after the gun.',   // 95 is BSP_trg%, VMG% was 105
        ],
        bottomLine: [],
      },
    }, f)
    expect(v.sections.start!.headlines).toEqual(['Race 5: early for the start by 5 s, 0.1 BL below the line at the gun at 95% of target, 105% VMG 30 s after the gun, on J4_A 2026.'])
    expect(v.dropped).toEqual(['Race 5: 95% VMG 30 s after the gun.'])
  })

  it('leaves VMG% out of the run-in before the gun, and names a start without a race by its number', () => {
    const [, runIn] = f.sections.start!.tables
    expect(runIn.columns[7]).toBe('VMG% (from the gun)')
    expect(runIn.rows.find(r => r[0] === -60)![7]).toBe('')
    expect(runIn.rows.find(r => r[0] === 30)![7]).toBe(105)
    const practice = buildHeadlineFacts({ date: 'd', stats: [], manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 1,
      xml: { ...startXml, raceGuns: [{ utc: GUN, raceNum: 0 }] }, rows, polar })
    const [ov, ri] = practice.sections.start!.tables
    expect(ov.rows[0].slice(0, 2)).toEqual([1, ''])
    expect(ri.title).toBe('Start 1 run-in, every 10 s (t = seconds to the gun)')
  })

  it('has no start section without guns or without the log', () => {
    expect(buildHeadlineFacts({ date: 'd', stats: [], manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 1, xml, rows, polar }).sections.start).toBeUndefined()
    expect(buildHeadlineFacts({ date: 'd', stats: [], manoeuvres: [], tzOffsetMin: 120, polarName: 'p', resolutionSeconds: 1, xml: startXml }).sections.start).toBeUndefined()
  })

  it('drops a start value quoted under the neighbouring column (8 Sep: VMG% at the gun called BSP_trg%)', () => {
    const v = validateSections({
      start: { headlines: ['Race 5 BSP_trg% 105 at +30 s.', 'Race 5 VMG% 105 at +30 s, BSP_trg% 95.'], bottomLine: [] },
    }, f)
    expect(v.sections.start!.headlines).toEqual(['Race 5 VMG% 105 at +30 s, BSP_trg% 95.'])
    expect(v.dropped).toEqual(['Race 5 BSP_trg% 105 at +30 s.'])
  })

  it('checks start sentences against one start table', () => {
    const v = validateSections({
      start: {
        headlines: [
          'Race 5 on J4_A 2026: 0.1 BL from the line at the gun, BSP_trg% 95, burn 5 s.',   // the Starts table
          'Race 5 closed from 6 BL at −60 s to the gun at BSP 11 kn.',                       // its run-in table
          // 6 BL at −60 s is only in the run-in table, TWD 280 only in the Starts table
          'Race 5 was 6 BL off at −60 s, TWD 280 in the last minute.',
        ],
        bottomLine: [],
      },
    }, f)
    expect(v.sections.start!.headlines).toEqual([
      'Race 5 on J4_A 2026: 0.1 BL from the line at the gun, BSP_trg% 95, burn 5 s.',
      'Race 5 closed from 6 BL at −60 s to the gun at BSP 11 kn.',
    ])
    expect(v.dropped).toEqual(['Race 5 was 6 BL off at −60 s, TWD 280 in the last minute.'])
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

  it('drops a number quoted under the wrong metric, even from the right table', () => {
    const v = validateSections({
      upwind: {
        headlines: [
          'Port VMG% 98.2 on J4_A 2026.',                      // 98.2 is Port's %Pol, VMG% is 96
          'Port 98.2 %Pol, VMG% 96, TWA 39.7 deg.',            // each under its own metric
          'Port 11.88 kn BSP against Stbd 11.73.',
        ],
        bottomLine: [],
      },
    }, facts)
    expect(v.sections.upwind!.headlines).toEqual(['Port 98.2 %Pol, VMG% 96, TWA 39.7 deg.', 'Port 11.88 kn BSP against Stbd 11.73.'])
    expect(v.dropped).toEqual(['Port VMG% 98.2 on J4_A 2026.'])
  })

  it('pairs metrics with their numbers, both ways round, and skips band labels', () => {
    expect(metricNumbers('Race 5 BSP_trg% 70.2 at 12:18:00, Burn −4 s, 103.4 VMG% at +30 s, 0.4 BL')).toEqual([
      ['BSP_trg%', '70.2'], ['Burn', '4'], ['VMG%', '103.4'], ['DistLn', '0.4'],
    ])
    expect(metricNumbers('Port TWS 11-13 kn band VMG% 102.3')).toEqual([['VMG%', '102.3']])
  })

  it('does not take labels for metric values: time to 95% BSP, a sail code year, a band end', () => {
    expect(metricNumbers('AVERAGE tack: time to 95% BSP 29 s, distance lost 34 m, BSP before 10.57 kn')).toEqual([])
    expect(metricNumbers('Port J4_A 2026 VMG% 96')).toEqual([['VMG%', '96']])
    expect(metricNumbers('MAIN_B 2026 upwind camber 25% 6-7 VMG% 96.5')).toEqual([['VMG%', '96.5']])
    expect(metricNumbers('Race 5: late by 10 s, 1.2 BL below the line, 89% VMG 30 s after the gun')).toEqual([['DistLn', '1.2'], ['VMG%', '89']])
  })

  it('reads a time after a metric as a time, and "N VMG% points" as a difference (11 Sep, 7 Sep)', () => {
    expect(metricNumbers('Race 5: 89 VMG% 30 s after the gun, Burn −10 s')).toEqual([['Burn', '10'], ['VMG%', '89']])
    expect(metricNumbers('Starboard tack lost 10 VMG% points to port, port lost 2 %Pol points')).toEqual([])
    expect(metricNumbers('BSP 10.6 kn, TWA 42 deg, BSP_trg% 57')).toEqual([['BSP', '10.6'], ['TWA', '42'], ['BSP_trg%', '57']])
  })

  it('keeps the tack average and a sail-coded VMG% that the column check used to drop', () => {
    const v = validateSections({
      upwind: { headlines: ['AVERAGE tack: time to 95% BSP 30 s, distance lost 21.8 m.', 'Port J4_A 2026 VMG% 96.'], bottomLine: [] },
    }, facts)
    expect(v.sections.upwind!.headlines).toEqual(['AVERAGE tack: time to 95% BSP 30 s, distance lost 21.8 m.', 'Port J4_A 2026 VMG% 96.'])
    expect(v.dropped).toEqual([])
  })

  it('drops a sentence that quotes no value from the tables', () => {
    const v = validateSections({
      upwind: { headlines: ['Port was quicker than Stbd on J4_A 2026.', 'Port 98.2 %Pol against Stbd 98.0.'], bottomLine: ['Keep it up.'] },
    }, facts)
    expect(v.sections.upwind).toEqual({ headlines: ['Port 98.2 %Pol against Stbd 98.0.'], bottomLine: [] })
    expect(v.dropped).toEqual(['Port was quicker than Stbd on J4_A 2026.', 'Keep it up.'])
  })

  it('keeps at most 5 headlines and 2 bottom-line points per section, and copes with junk', () => {
    const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven']
    const v = validateSections({
      upwind: { headlines: words.map(w => `Port 98.2 %Pol, headline ${w}`), bottomLine: ['Port 98.2 a', 'Port 98.2 b', 'Port 98.2 c'] },
      downwind: 'not an object',
    }, facts)
    expect(v.sections.upwind!.headlines).toHaveLength(5)
    expect(v.sections.upwind!.bottomLine).toEqual(['Port 98.2 a', 'Port 98.2 b'])
    expect(v.sections.downwind).toBeUndefined()
    expect(validateSections(null, facts)).toEqual({ version: 2, sections: {}, dropped: [] })
  })

  it('still validates single-list headlines (older days)', () => {
    const v = validateHeadlines({ headlines: ['Port 98.2 %Pol.', 'Port was 0.2 %Pol quicker.'], bottomLine: 'x' as any }, facts)
    expect(v).toEqual({ headlines: ['Port 98.2 %Pol.'], bottomLine: [], dropped: ['Port was 0.2 %Pol quicker.'] })
  })
})

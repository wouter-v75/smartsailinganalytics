import { describe, it, expect } from 'vitest'
import { filterPhases, buildCompareTable } from '../askData'
import type { PhaseStat } from '../../phaseStats'
import type { ComparePhasesArgs } from '../askTools'

type Dated = PhaseStat & { date: string }

let seq = 0
const phase = (o: Partial<Dated> & { tws?: number; vmgPct?: number }): Dated => {
  const utc = 1_000_000 + seq++ * 30_000
  const { tws = 15, vmgPct = 97, ...rest } = o
  return {
    utc, endUtc: utc + 30_000, mode: 'up', tack: 'port', sails: [], sailCombo: 'J4_A 2026',
    race: null, n: 5, max: {},
    mean: { tws, vmgPct, twa: 42, heel: 22, bsp: 10 },
    date: '2026-09-11',
    ...rest,
  } as Dated
}

const args = (o: Partial<ComparePhasesArgs> = {}): ComparePhasesArgs =>
  ({ by: ['tack'], metrics: ['vmgPct'], minPhases: 1, ...o })

describe('filterPhases', () => {
  const stats = [
    phase({ tack: 'port', tws: 12 }),
    phase({ tack: 'stbd', tws: 20 }),
    phase({ tack: 'stbd', tws: 16, mode: 'down' }),
    phase({ tack: 'port', tws: 25, race: 2 }),
  ]

  it('keeps everything when nothing is asked of it', () => {
    expect(filterPhases(stats, {})).toHaveLength(4)
  })

  it('filters on a wind band, inclusive at both ends', () => {
    expect(filterPhases(stats, { twsMin: 16, twsMax: 20 }).map(p => p.mean.tws)).toEqual([20, 16])
  })

  it('filters on point of sail and tack together', () => {
    expect(filterPhases(stats, { modes: ['up'], tack: 'stbd' })).toHaveLength(1)
  })

  it('filters on a race', () => {
    expect(filterPhases(stats, { race: 2 })).toHaveLength(1)
  })

  it('matches a sail combination loosely — "J4" finds "J4_A 2026"', () => {
    expect(filterPhases(stats, { sailCombo: 'j4' })).toHaveLength(4)
    expect(filterPhases(stats, { sailCombo: 'A2' })).toHaveLength(0)
  })

  // A phase with no value for the channel being filtered is not "inside" the
  // band — it is unknown, and treating unknown as a match is how a filter
  // silently stops filtering.
  it('drops a phase with no value for the filtered channel', () => {
    const blind = phase({ tack: 'port' })
    blind.mean.tws = null
    expect(filterPhases([blind], { twsMin: 10 })).toHaveLength(0)
  })
})

describe('buildCompareTable', () => {
  const twoTacks = [
    phase({ tack: 'port', vmgPct: 96 }), phase({ tack: 'port', vmgPct: 97 }),
    phase({ tack: 'stbd', vmgPct: 99 }), phase({ tack: 'stbd', vmgPct: 100 }),
  ]

  it('gives one row per group, each carrying its n', () => {
    const t = buildCompareTable(twoTacks, args())
    expect(t.rows).toEqual([['Port', 2, 96.5], ['Stbd', 2, 99.5]])
    expect(t.columns.map(c => c.key)).toEqual(['tack', 'n', 'vmgPct'])
  })

  it('labels the metric column with its unit, from CHANNELS', () => {
    const col = buildCompareTable(twoTacks, args()).columns.find(c => c.key === 'vmgPct')
    expect(col?.label).toBe('VMG%')
    expect(col?.unit).toBe('%')
  })

  // The 11 Sep mistake: a one-phase heel band read as the best or the worst of
  // the day. A group the table never shows cannot be quoted.
  it('leaves out a group with fewer phases than the floor, and counts it', () => {
    const lopsided = [...twoTacks, phase({ tack: 'stbd', mode: 'reach', vmgPct: 120 })]
    const t = buildCompareTable(lopsided, args({ by: ['mode'], minPhases: 3 }))
    expect(t.rows.map(r => r[0])).toEqual(['Upwind'])
    expect(t.droppedThin).toBe(1)
  })

  it('groups by day when asked to compare days', () => {
    const across = [
      phase({ date: '2026-09-08', vmgPct: 95 }),
      phase({ date: '2026-09-11', vmgPct: 99 }),
    ]
    const t = buildCompareTable(across, args({ by: ['date'] }))
    expect(t.rows).toEqual([['2026-09-08', 1, 95], ['2026-09-11', 1, 99]])
  })

  it('crosses the day with another key without losing either', () => {
    const across = [
      phase({ date: '2026-09-08', tack: 'port', vmgPct: 95 }),
      phase({ date: '2026-09-08', tack: 'stbd', vmgPct: 96 }),
      phase({ date: '2026-09-11', tack: 'port', vmgPct: 98 }),
    ]
    const t = buildCompareTable(across, args({ by: ['date', 'tack'] }))
    expect(t.rows).toEqual([
      ['2026-09-08', 'Port', 1, 95],
      ['2026-09-08', 'Stbd', 1, 96],
      ['2026-09-11', 'Port', 1, 98],
    ])
  })

  it('rounds each metric to the decimals CHANNELS gives it', () => {
    const noisy = [phase({ tack: 'port', vmgPct: 96.44444 }), phase({ tack: 'port', vmgPct: 96.55555 })]
    expect(buildCompareTable(noisy, args()).rows[0][2]).toBe(96.5)
  })

  it('writes null, not zero, for a metric the phases do not carry', () => {
    const t = buildCompareTable(twoTacks, args({ metrics: ['fsty'] }))
    expect(t.rows[0][2]).toBeNull()
  })

  it('returns no rows rather than an empty group for no phases', () => {
    expect(buildCompareTable([], args()).rows).toEqual([])
  })
})

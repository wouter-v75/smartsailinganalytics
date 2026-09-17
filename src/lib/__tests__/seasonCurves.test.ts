import { describe, it, expect } from 'vitest'
import {
  compactPhases, expandPhases, compactManoeuvres, medianInterval, shouldReplace, preferStored,
  seasonCurves, median, statsAreCurrent, STATS_VERSION, type StoredPhase,
} from '../seasonCurves'
import type { PhaseStat } from '../phaseStats'

const stat = (over: Partial<PhaseStat> & { mean: PhaseStat['mean'] }): PhaseStat => ({
  utc: 1, endUtc: 30_001, mode: 'up', tack: 'stbd', sails: [], sailCombo: 'J4_A 2026', race: 1, n: 5, max: {}, ...over,
})
const sp = (m: 'up' | 'down', tws: number, bsp: number, extra: Record<string, number> = {}): StoredPhase =>
  ({ u: 0, e: 30_000, m, t: 'port', s: 'J4_A 2026', r: 1, n: 5, v: { tws, bsp, ...extra } })

describe('compactPhases', () => {
  it('keeps means and maxima, rounded, without empty channels', () => {
    const [p] = compactPhases([stat({ mean: { tws: 21.123456, bsp: 11.03, vang: null, heel: NaN } })].map(s => ({ ...s, max: { fsty: 17.2249, vang: null } })))
    expect(p).toEqual({ u: 1, e: 30_001, m: 'up', t: 'stbd', s: 'J4_A 2026', r: 1, n: 5, v: { tws: 21.123, bsp: 11.03 }, x: { fsty: 17.225 } })
    // 3 since the five minutes before a gun count as that race: stored rows carry
    // `race`, so anything written under the old rule has to be rebuilt.
    expect(STATS_VERSION).toBe(3)
  })

  it('expands stored phases back into chart / table input, old rows without maxima too', () => {
    const [p] = expandPhases([{ u: 1, e: 2, m: 'down', t: 'port', s: 'A2', r: null, n: 30, v: { bsp: 21.5 } }])
    expect(p).toEqual({ utc: 1, endUtc: 2, mode: 'down', tack: 'port', sails: [], sailCombo: 'A2', race: null, n: 30, mean: { bsp: 21.5 }, max: {} })
    expect(expandPhases(null)).toEqual([])
  })

  it('rounds manoeuvre numbers for storage', () => {
    const [m] = compactManoeuvres([{ utc: 1789122199000, distLost: 21.83333, timeTo95: 26, sails: 'J4_A 2026' } as any])
    expect(m).toEqual({ utc: 1789122199000, distLost: 21.833, timeTo95: 26, sails: 'J4_A 2026' })
  })
})

describe('log resolution and which stats win', () => {
  const rowsEvery = (s: number, n = 100) => Array.from({ length: n }, (_, i) => ({ utc: i * s * 1000 }))

  it('measures the median interval between rows', () => {
    expect(medianInterval(rowsEvery(1))).toBe(1)
    expect(medianInterval(rowsEvery(6))).toBe(6)
    expect(medianInterval(rowsEvery(1, 20_000))).toBe(1)     // long logs are sampled
    expect(medianInterval([{ utc: 0 }])).toBeNull()
  })

  const now = { polarId: 'v17', sessionUpdatedAt: '2026-09-12T06:46:29Z' }
  const row = (resolution_s: number | null) => ({ stats_version: STATS_VERSION, polar_id: 'v17', computed_at: '2026-09-14T09:27:03Z', resolution_s })

  it('never lets the 6 s cloud copy replace stats from the full log', () => {
    expect(shouldReplace(row(1), 6, now)).toBe(false)
    expect(shouldReplace(row(6), 1, now)).toBe(true)        // full log beats the cloud copy
    expect(shouldReplace(row(6), 5.8, now)).toBe(false)     // not clearly finer
    expect(shouldReplace(null, 6, now)).toBe(true)
  })

  it('replaces any row that is out of date, whatever its resolution', () => {
    expect(shouldReplace(row(1), 6, { ...now, polarId: 'v18' })).toBe(true)
    expect(shouldReplace({ ...row(1), stats_version: 1 }, 6, now)).toBe(true)
  })

  it('uses stored stats on a device with only the cloud copy, when polar and version match', () => {
    expect(preferStored(row(1), 6, 'v17')).toBe(true)
    expect(preferStored(row(1), 1, 'v17')).toBe(false)      // this device has the full log itself
    expect(preferStored(row(6), 6, 'v17')).toBe(false)
    expect(preferStored(row(1), 6, 'v18')).toBe(false)      // polar changed since
    expect(preferStored(null, 6, 'v17')).toBe(false)
  })
})

describe('statsAreCurrent', () => {
  const row = { stats_version: STATS_VERSION, polar_id: 'v17', computed_at: '2026-09-14T09:27:03Z' }
  const now = { polarId: 'v17', sessionUpdatedAt: '2026-09-12T06:46:29Z' }   // 11 Sep as stored

  it('keeps a row computed with this version and polar after the session last changed', () => {
    expect(statsAreCurrent(row, now)).toBe(true)
    expect(statsAreCurrent(row, { ...now, sessionUpdatedAt: null })).toBe(true)
  })

  it('recomputes when there is no row, the maths or the polar changed', () => {
    expect(statsAreCurrent(null, now)).toBe(false)
    expect(statsAreCurrent({ ...row, stats_version: STATS_VERSION - 1 }, now)).toBe(false)
    expect(statsAreCurrent(row, { ...now, polarId: 'v16' })).toBe(false)
    expect(statsAreCurrent({ ...row, polar_id: null }, { ...now, polarId: null })).toBe(true)
  })

  it('recomputes when a log or event file arrived after the stats were stored', () => {
    // e.g. 6 Sep: event file on file, log uploaded later
    expect(statsAreCurrent(row, { ...now, sessionUpdatedAt: '2026-09-15T08:00:00Z' })).toBe(false)
    expect(statsAreCurrent({ ...row, computed_at: 'not a date' }, now)).toBe(false)
  })
})

describe('median', () => {
  it('handles odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})

describe('seasonCurves', () => {
  const rows = [
    { date: '2025-07-01', phases: [sp('up', 20.2, 11), sp('up', 19.8, 11.4), sp('up', 20.4, 11.2), sp('up', 20.0, 11.6)] },
    { date: '2026-09-10', phases: [sp('up', 20.1, 12), sp('up', 19.6, 12.2), sp('down', 20, 21)] },
    { date: '2026-09-11', phases: [sp('up', 20.3, 11.8), sp('up', 20.4, 12.4), sp('up', 22, 12.5)] },
  ]

  it('takes the median per 1 kn TWS bin, per season and point of sail', () => {
    const r = seasonCurves(rows, { minPhases: 4 })
    expect(r.curves['2025'].up!.bsp).toEqual([{ x: 20, y: 11.3, n: 4 }])
    expect(r.curves['2026'].up!.bsp).toEqual([{ x: 20, y: 12.1, n: 4 }])   // 22 kn bin has 1 phase → dropped
    expect(r.curves['2026'].down!.bsp).toBeUndefined()                   // 1 downwind phase
    expect(r.sessions).toEqual({ '2025': 1, '2026': 2 })
    expect(r.phases).toEqual({ '2025': 4, '2026': 6 })
  })

  it('leaves out excluded dates, e.g. the session being judged', () => {
    const r = seasonCurves(rows, { minPhases: 2, exclude: ['2026-09-11'] })
    expect(r.curves['2026'].up!.bsp).toEqual([{ x: 20, y: 12.1, n: 2 }])
    expect(r.sessions['2026']).toBe(1)
  })

  it('uses the bin width given and skips phases without TWS', () => {
    const r = seasonCurves(
      [{ date: '2026-08-01', phases: [sp('up', 19.1, 10), sp('up', 20.9, 12), { ...sp('up', 0, 9), v: { bsp: 9 } }] }],
      { binWidth: 2, minPhases: 2 }
    )
    expect(r.curves['2026'].up!.bsp).toEqual([{ x: 20, y: 11, n: 2 }])
    expect(r.phases['2026']).toBe(2)
  })
})

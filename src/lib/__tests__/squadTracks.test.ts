import { describe, it, expect } from 'vitest'
import { loadSquadTracks, thinTrack, colourForBoat, SQUAD_COLOURS } from '../squadTracks'

const boats = [
  { id: 'b-active', name: 'Miss Behavior', sail_number: 'NED 1' },
  { id: 'b-other', name: 'Torvar', sail_number: 'NED 2' },
  { id: 'b-absent', name: 'Ghost', sail_number: null },
]
const track = (n: number) => ({
  session: { log_data: { rows: Array.from({ length: n }, (_, i) => ({ utc: 1000 + i * 1000, lat: 39.5 + i * 1e-4, lon: 2.57 })) } },
})

const SHARED = {
  tracks: [
    { teamId: 't2', teamName: 'Team Torvar', boatId: 'b-torvar', boatName: 'Sunrise',
      sailNumber: 'NED 9', rows: [{ utc: 1, lat: 39.5, lon: 2.57 }, { utc: 5000, lat: 39.51, lon: 2.57 }] },
    // Also reachable in-team: must not appear twice.
    { teamId: 't1', teamName: 'Dragon', boatId: 'b-other', boatName: 'Torvar',
      sailNumber: null, rows: [{ utc: 1, lat: 1, lon: 2 }, { utc: 5000, lat: 1, lon: 2 }] },
    // The boat already on screen: never drawn as a reference track.
    { teamId: 't1', teamName: 'Dragon', boatId: 'b-active', boatName: 'Miss Behavior',
      sailNumber: null, rows: [{ utc: 1, lat: 1, lon: 2 }, { utc: 5000, lat: 1, lon: 2 }] },
  ],
}

const fakeFetch = (opts: { boatsFail?: boolean; squadFail?: boolean } = {}) => (async (url: string) => {
  if (url.startsWith('/api/squads/tracks/')) {
    return opts.squadFail
      ? { ok: false, json: async () => ({}) }
      : { ok: true, json: async () => SHARED }
  }
  if (url.endsWith('/boats')) {
    return opts.boatsFail
      ? { ok: false, json: async () => ({}) }
      : { ok: true, json: async () => ({ boats }) }
  }
  if (url.includes('/b-other/')) return { ok: true, json: async () => track(600) }
  if (url.includes('/b-absent/')) return { ok: false, json: async () => ({}) }   // no session
  return { ok: true, json: async () => ({ session: { log_data: { rows: [] } } }) }
}) as unknown as typeof fetch

describe('thinTrack', () => {
  it('keeps one point per bucket', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ utc: i * 1000, lat: 1, lon: 2 }))
    expect(thinTrack(rows, 4000)).toHaveLength(25)
  })

  it('drops rows with no fix or no clock', () => {
    expect(thinTrack([
      { utc: 0, lat: 1, lon: 2 }, { utc: 5000, lat: null, lon: 2 },
      { utc: 10000, lat: 1, lon: undefined }, { utc: NaN, lat: 1, lon: 2 },
    ], 1000)).toHaveLength(1)
  })

  it('survives junk', () => {
    expect(thinTrack(null as any)).toEqual([])
    expect(thinTrack([])).toEqual([])
  })
})

describe('colourForBoat', () => {
  it('is stable for a boat and drawn from the identity palette', () => {
    const c = colourForBoat('b-other')
    expect(colourForBoat('b-other')).toBe(c)
    expect(SQUAD_COLOURS).toContain(c)
  })

  it('is independent of load order', () => {
    // A boat must keep its colour whichever day it is opened from.
    expect(colourForBoat('abc')).toBe(colourForBoat('abc'))
  })
})

describe('loadSquadTracks', () => {
  it('returns the other boats in the SAME team that actually sailed', async () => {
    // Pinned to the same-team path; the squad path has its own block below.
    const t = await loadSquadTracks({
      teamId: 't1', date: '2026-02-08', excludeBoatId: 'b-active',
      fetchImpl: fakeFetch({ squadFail: true }),
    })
    expect(t.map((x) => x.boatName)).toEqual(['Torvar'])
    expect(t[0].sailNumber).toBe('NED 2')
    expect(t[0].colour).toBe(colourForBoat('b-other'))
  })

  it('never includes the boat already on screen', async () => {
    const t = await loadSquadTracks({
      teamId: 't1', date: '2026-02-08', excludeBoatId: 'b-active', fetchImpl: fakeFetch(),
    })
    expect(t.some((x) => x.boatId === 'b-active')).toBe(false)
  })

  it('thins hard — six boats at 10 Hz is millions of points', async () => {
    const t = await loadSquadTracks({
      teamId: 't1', date: '2026-02-08', excludeBoatId: 'b-active', fetchImpl: fakeFetch(),
    })
    expect(t[0].rows.length).toBeLessThan(600 / 3)
  })

  it('omits a boat with no session that day, without erroring', async () => {
    const t = await loadSquadTracks({
      teamId: 't1', date: '2026-02-08', excludeBoatId: 'b-active', fetchImpl: fakeFetch(),
    })
    expect(t.some((x) => x.boatName === 'Ghost')).toBe(false)
  })

  it('returns empty rather than throwing when the team is unreadable', async () => {
    expect(await loadSquadTracks({
      teamId: 't1', date: '2026-02-08', fetchImpl: fakeFetch({ boatsFail: true }),
    })).toEqual([])
    const boom = (async () => { throw new Error('network') }) as unknown as typeof fetch
    expect(await loadSquadTracks({ teamId: 't1', date: '2026-02-08', fetchImpl: boom })).toEqual([])
  })
})

describe('tracks other teams shared with the squad', () => {
  const load = (o = {}) => loadSquadTracks({
    teamId: 't1', date: '2026-02-08', excludeBoatId: 'b-active', fetchImpl: fakeFetch(o),
  })

  it('includes a boat from another team that shared this day', async () => {
    // The cross-OWNERSHIP path. Not "the main path" — a team that fields two
    // boats itself gets both from the same-team path below, with no squad at
    // all. Both are first-class; see the module header.
    const t = await load()
    const other = t.find((x) => x.boatId === 'b-torvar')!
    expect(other).toBeTruthy()
    expect(other.boatName).toBe('Sunrise')
    expect(other.teamName).toBe('Team Torvar')
    expect(other.sailNumber).toBe('NED 9')
  })

  it('never draws the boat already on screen', async () => {
    expect((await load()).some((x) => x.boatId === 'b-active')).toBe(false)
  })

  it('shows a boat reachable BOTH ways exactly once', async () => {
    const t = await load()
    expect(t.filter((x) => x.boatId === 'b-other')).toHaveLength(1)
  })

  it('keeps the same-team boats when no squad is available', async () => {
    // A squad is optional; its absence is not an error.
    const t = await load({ squadFail: true })
    expect(t.map((x) => x.boatId)).toEqual(['b-other'])
  })

  it('gives every boat its stable identity colour', async () => {
    const t = await load()
    for (const x of t) expect(x.colour).toBe(colourForBoat(x.boatId))
  })
})

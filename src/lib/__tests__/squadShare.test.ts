import { describe, it, expect } from 'vitest'
import { squadsForTeam, setSessionShared, shareLabel } from '../squadShare'

const MINE = 'team-dragon', OTHER = 'team-49er', THIRD = 'team-470'
const payload = {
  squads: [
    { id: 's1', name: 'NED Squad', squad_members: [
      { team_id: MINE, status: 'active', teams: { name: 'Dragon' } },
      { team_id: OTHER, status: 'active', teams: { name: '49er Crew' } },
      { team_id: THIRD, status: 'left', teams: { name: '470 Crew' } },
    ] },
    { id: 's2', name: 'Not mine', squad_members: [
      { team_id: OTHER, status: 'active', teams: { name: '49er Crew' } },
    ] },
    { id: 's3', name: 'Invited only', squad_members: [
      { team_id: MINE, status: 'invited', teams: { name: 'Dragon' } },
    ] },
  ],
}
const ok = (body: any) => (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch

describe('squadsForTeam', () => {
  it('returns only squads this team is ACTIVE in', async () => {
    const s = await squadsForTeam(MINE, ok(payload))
    expect(s.map((x) => x.name)).toEqual(['NED Squad'])
  })

  it('does not count an invitation as membership', async () => {
    // Being asked to join is not joining — "Invited only" must not appear.
    const s = await squadsForTeam(MINE, ok(payload))
    expect(s.some((x) => x.name === 'Invited only')).toBe(false)
  })

  it('lists the other ACTIVE teams, excluding itself and those who left', async () => {
    const s = await squadsForTeam(MINE, ok(payload))
    expect(s[0].otherTeams).toEqual(['49er Crew'])
  })

  it('is empty for a team in no squad — the common case', async () => {
    expect(await squadsForTeam('team-alone', ok(payload))).toEqual([])
  })

  it('returns empty rather than throwing when squads are unavailable', async () => {
    const bad = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
    expect(await squadsForTeam(MINE, bad)).toEqual([])
    const boom = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await squadsForTeam(MINE, boom)).toEqual([])
  })
})

describe('setSessionShared', () => {
  it('sends ONLY the flag, so a toggle cannot disturb the log', async () => {
    let body: any = null
    const spy = (async (_u: string, init: any) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({}) } }) as unknown as typeof fetch
    await setSessionShared('t', 'b', '2026-02-08', true, spy)
    expect(body).toEqual({ shared_with_squad: true })
    expect(Object.keys(body)).toHaveLength(1)
  })

  it('can turn sharing off again', async () => {
    let body: any = null
    const spy = (async (_u: string, init: any) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({}) } }) as unknown as typeof fetch
    await setSessionShared('t', 'b', '2026-02-08', false, spy)
    expect(body.shared_with_squad).toBe(false)
  })

  it('reports a refusal instead of pretending it worked', async () => {
    const denied = (async () => ({ ok: false, json: async () => ({ error: 'not your team' }) })) as unknown as typeof fetch
    expect(await setSessionShared('t', 'b', 'd', true, denied)).toEqual({ ok: false, error: 'not your team' })
  })
})

describe('shareLabel', () => {
  it('names the squad and how many other teams would see it', () => {
    expect(shareLabel([{ id: 's1', name: 'NED Squad', otherTeams: ['49er Crew', '470 Crew'] }]))
      .toBe('Share this track with NED Squad — 2 other teams will see it')
  })

  it('uses the singular for one team', () => {
    expect(shareLabel([{ id: 's1', name: 'NED Squad', otherTeams: ['49er Crew'] }]))
      .toContain('1 other team will see it')
  })

  it('says nothing about others when a squad has none yet', () => {
    expect(shareLabel([{ id: 's1', name: 'NED Squad', otherTeams: [] }]))
      .toBe('Share this track with NED Squad')
  })

  it('is empty when there is no squad, so the question is never asked', () => {
    expect(shareLabel([])).toBe('')
  })
})

describe('media sharing', () => {
  it('sends only the flag, to its own endpoint', async () => {
    let url = '', body: any = null
    const spy = (async (u: string, init: any) => { url = u; body = JSON.parse(init.body); return { ok: true, json: async () => ({}) } }) as unknown as typeof fetch
    const { setMediaShared } = await import('../squadShare')
    await setMediaShared('videos', 'vid-1', true, spy)
    // NOT /share — that URL already mints an external capability token.
    expect(url).toBe('/api/videos/vid-1/squad-share')
    expect(body).toEqual({ shared_with_squad: true })
  })

  it('shares a whole session of clips at once', async () => {
    // A drone operator comes back with dozens of clips of six boats.
    const spy = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch
    const { setSessionMediaShared } = await import('../squadShare')
    const r = await setSessionMediaShared('videos', ['a', 'b', 'c'], true, spy)
    expect(r).toEqual({ ok: true, changed: 3, failed: 0, error: undefined })
  })

  it('reports a PARTIAL failure rather than claiming success', async () => {
    // Half-shared media is the kind of thing somebody discovers much later.
    let n = 0
    const flaky = (async () => { n++; return n === 2
      ? { ok: false, json: async () => ({ error: 'denied' }) }
      : { ok: true, json: async () => ({}) } }) as unknown as typeof fetch
    const { setSessionMediaShared } = await import('../squadShare')
    const r = await setSessionMediaShared('photos', ['a', 'b', 'c'], true, flaky)
    expect(r.ok).toBe(false)
    expect(r.changed).toBe(2)
    expect(r.failed).toBe(1)
    expect(r.error).toBe('denied')
  })

  it('does nothing, successfully, for an empty session', async () => {
    const { setSessionMediaShared } = await import('../squadShare')
    expect(await setSessionMediaShared('videos', [], true)).toEqual({ ok: true, changed: 0, failed: 0 })
  })
})

describe('squadStanding — a team must know it is in a squad', () => {
  const squadsJson = {
    squads: [{
      id: 'sq1', name: 'Dragon Squad',
      squad_members: [
        { team_id: 't1', status: 'active', teams: { name: 'Dragon' } },
        { team_id: 't2', status: 'active', teams: { name: 'Team Torvar' } },
      ],
    }],
  }
  const fetchSquads = (async () => ({ ok: true, json: async () => squadsJson })) as unknown as typeof fetch
  const noSquads = (async () => ({ ok: true, json: async () => ({ squads: [] }) })) as unknown as typeof fetch

  it('reports the squad and who else is in it', async () => {
    const { squadStanding } = await import('../squadShare')
    const r = await squadStanding('t1', async () => 0, fetchSquads)
    expect(r.squads).toHaveLength(1)
    expect(r.squads[0].name).toBe('Dragon Squad')
    expect(r.squads[0].otherTeams).toEqual(['Team Torvar'])
  })

  it('does not count anything when there is no squad', async () => {
    // The counts are three queries; a team not in a squad should not pay for
    // them, and should see no squad vocabulary at all.
    const { squadStanding } = await import('../squadShare')
    let calls = 0
    const r = await squadStanding('t1', async () => { calls++; return 5 }, noSquads)
    expect(r.squads).toEqual([])
    expect(calls).toBe(0)
    expect(r.shared).toEqual({ sessions: 0, videos: 0, photos: 0 })
  })

  it('counts what is ACTUALLY shared, because joining shares nothing', async () => {
    const { squadStanding } = await import('../squadShare')
    const r = await squadStanding('t1', async (t) => ({ sessions: 2, videos: 0, photos: 7 }[t] ?? 0), fetchSquads)
    expect(r.shared).toEqual({ sessions: 2, videos: 0, photos: 7 })
  })

  it('survives a failing count rather than breaking the user menu', async () => {
    const { squadStanding } = await import('../squadShare')
    const r = await squadStanding('t1', async () => { throw new Error('rls') }, fetchSquads)
    expect(r.shared).toEqual({ sessions: 0, videos: 0, photos: 0 })
    expect(r.squads).toHaveLength(1)   // the relationship still shows
  })
})

describe('sharedSummary', () => {
  it('reassures when nothing is shared', async () => {
    const { sharedSummary } = await import('../squadShare')
    expect(sharedSummary({ sessions: 0, videos: 0, photos: 0 }))
      .toBe('Nothing shared yet — you choose per track.')
  })

  it('names only the categories that are non-zero', async () => {
    const { sharedSummary } = await import('../squadShare')
    expect(sharedSummary({ sessions: 2, videos: 0, photos: 0 })).toBe('Sharing 2 tracks.')
    expect(sharedSummary({ sessions: 1, videos: 0, photos: 0 })).toBe('Sharing 1 track.')
    expect(sharedSummary({ sessions: 2, videos: 3, photos: 7 }))
      .toBe('Sharing 2 tracks, 3 clips and 7 photos.')
    expect(sharedSummary({ sessions: 0, videos: 1, photos: 1 }))
      .toBe('Sharing 1 clip and 1 photo.')
  })
})

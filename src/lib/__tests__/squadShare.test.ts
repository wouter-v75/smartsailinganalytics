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

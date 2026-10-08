import { describe, it, expect } from 'vitest'
import {
  collapseWorkspaces, expandWorkspaces, strongestRole, workspaceLabel, ROLE_RANK,
} from '../memberships'

const row = (o: Partial<Parameters<typeof collapseWorkspaces>[0][0]> = {}) => ({
  id: 'm1', team_id: 't1', boat_id: 'b1', role: 'tl1',
  team_name: 'Northstar', boat_name: 'Northstar 76',
  valid_from: null, valid_to: null, ...o,
})

describe('collapseWorkspaces', () => {
  it('merges two roles in the same team+boat into ONE workspace', () => {
    // The request that started this: one person, manager AND coach. The
    // switcher used to offer the same boat twice with no way to tell them apart.
    const out = collapseWorkspaces([
      row({ id: 'a', role: 'coach' }),
      row({ id: 'b', role: 'team_manager' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].roles).toEqual(['team_manager', 'coach'])
  })

  it('keeps the STRONGEST role\'s row as the representative', () => {
    // Storing the weaker membership would make a manager look like a coach on
    // the next load — access they still hold, apparently lost.
    const out = collapseWorkspaces([
      row({ id: 'weak', role: 'tl1' }),
      row({ id: 'strong', role: 'team_manager' }),
    ])
    expect(out[0].id).toBe('strong')
    expect(out[0].role).toBe('team_manager')
  })

  it('does NOT merge different boats, or different teams', () => {
    const out = collapseWorkspaces([
      row({ boat_id: 'b1', boat_name: '76' }),
      row({ boat_id: 'b2', boat_name: '72' }),
      row({ team_id: 't2', team_name: 'Dragon', boat_id: 'b9', boat_name: 'Miss Behavior' }),
    ])
    expect(out).toHaveLength(3)
  })

  it('treats a null boat as its own workspace, not as a wildcard', () => {
    const out = collapseWorkspaces([
      row({ boat_id: null, boat_name: null }),
      row({ boat_id: 'b1' }),
    ])
    expect(out).toHaveLength(2)
  })

  it('preserves input order — the loader decides ordering, not this', () => {
    const out = collapseWorkspaces([
      row({ team_id: 'z', team_name: 'Zulu', boat_id: 'b9' }),
      row({ team_id: 'a', team_name: 'Alpha', boat_id: 'b8' }),
    ])
    expect(out.map((r) => r.team_name)).toEqual(['Zulu', 'Alpha'])
  })

  it('de-duplicates an identical role rather than listing it twice', () => {
    const out = collapseWorkspaces([row({ id: 'a' }), row({ id: 'b' })])
    expect(out[0].roles).toEqual(['tl1'])
  })
})

describe('strongestRole', () => {
  it('ranks manager above coach above crew', () => {
    expect(strongestRole(['tl1', 'coach', 'team_manager'])).toBe('team_manager')
    expect(strongestRole(['tl1', 'coach'])).toBe('coach')
    expect(strongestRole(['guest', 'tl3'])).toBe('tl3')
  })

  it('sorts an unknown role last but still returns it', () => {
    expect(strongestRole(['mystery'])).toBe('mystery')
    expect(strongestRole(['mystery', 'coach'])).toBe('coach')
  })

  it('is null for nothing', () => {
    expect(strongestRole([])).toBeNull()
  })

  it('covers every role the app defines', () => {
    // A role missing from ROLE_RANK sorts last and would silently outrank
    // nothing — cheap to assert, expensive to discover.
    expect(ROLE_RANK).toContain('team_manager')
    expect(ROLE_RANK).toContain('coach')
    expect(new Set(ROLE_RANK).size).toBe(ROLE_RANK.length)
  })
})

describe('workspaceLabel', () => {
  it('shows every role, not just the strongest', () => {
    expect(workspaceLabel({ team_name: 'Northstar', boat_name: 'Northstar 76', roles: ['team_manager', 'coach'] }))
      .toBe('Northstar · Northstar 76 (team_manager, coach)')
  })

  it('falls back to a single role, and to no role at all', () => {
    expect(workspaceLabel({ team_name: 'Dragon', boat_name: null, role: 'coach' })).toBe('Dragon (coach)')
    expect(workspaceLabel({ team_name: 'Dragon', boat_name: null })).toBe('Dragon')
  })
})

describe('expandWorkspaces', () => {
  const TEAM = 'team-northstar'
  const names: Record<string, string> = {
    [TEAM]: 'Northstar Racing',
    'b-n76': 'Northstar 76',
    'b-bella': 'Bella Mente',
    'b-jolt': 'Jolt',
  }
  const nameOf = (id: string) => names[id] || '(removed)'
  const boats = [
    { id: 'b-n76', name: 'Northstar 76', team_id: TEAM },
    { id: 'b-bella', name: 'Bella Mente', team_id: TEAM, is_competitor: true },
    { id: 'b-jolt', name: 'Jolt', team_id: TEAM, is_competitor: true },
  ]
  const allBoats = [{ id: 'm1', team_id: TEAM, boat_id: null, role: 'team_manager' }]

  it('leaves competitors out of an "all boats" expansion', () => {
    // 0091 files a rival under the team that photographs it so a coach can
    // MEASURE it. That is not the same as a workspace: a rival has no session,
    // no log and no upload, so picking one scoped the app to nothing.
    const out = expandWorkspaces(allBoats, boats, nameOf, nameOf)
    expect(out).toHaveLength(1)
    expect(out[0].boat_name).toBe('Northstar 76')
    expect(out.map((w) => w.boat_name)).not.toContain('Bella Mente')
  })

  it('still gives each of our own boats its own workspace', () => {
    const two = [...boats, { id: 'b-n44', name: 'Northstar 44', team_id: TEAM }]
    names['b-n44'] = 'Northstar 44'
    const out = expandWorkspaces(allBoats, two, nameOf, nameOf)
    expect(out.map((w) => w.boat_name).sort()).toEqual(['Northstar 44', 'Northstar 76'])
    // The synthetic id is what lets the switcher tell expansions apart.
    expect(out.every((w) => w.id.startsWith('m1::'))).toBe(true)
  })

  it('keeps a membership that names a competitor ON PURPOSE', () => {
    // Somebody chose that; the expansion rule is not the place to overrule it.
    const out = expandWorkspaces(
      [{ id: 'm2', team_id: TEAM, boat_id: 'b-bella', role: 'coach' }], boats, nameOf, nameOf
    )
    expect(out).toHaveLength(1)
    expect(out[0].boat_name).toBe('Bella Mente')
    expect(out[0].id).toBe('m2')
  })

  it('does not make a team vanish when every boat in it is a rival', () => {
    // Losing a team from the menu is worse than showing one with no boat.
    const rivalsOnly = boats.filter((b) => b.is_competitor)
    const out = expandWorkspaces(allBoats, rivalsOnly, nameOf, nameOf)
    expect(out).toHaveLength(1)
    expect(out[0].boat_name).toBeNull()
    expect(out[0].team_name).toBe('Northstar Racing')
  })

  it('handles a team with no boats at all', () => {
    const out = expandWorkspaces(allBoats, [], nameOf, nameOf)
    expect(out).toHaveLength(1)
    expect(out[0].boat_id).toBeNull()
  })

  it('names a boat that has gone rather than dropping the row', () => {
    const out = expandWorkspaces(
      [{ id: 'm3', team_id: TEAM, boat_id: 'b-deleted', role: 'tl1' }], boats, nameOf, nameOf
    )
    expect(out[0].boat_name).toBe('(removed)')
  })
})

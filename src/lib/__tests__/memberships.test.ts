import { describe, it, expect } from 'vitest'
import { collapseWorkspaces, strongestRole, workspaceLabel, ROLE_RANK } from '../memberships'

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

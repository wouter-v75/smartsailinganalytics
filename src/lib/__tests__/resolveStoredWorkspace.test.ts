import { describe, it, expect } from 'vitest'
import { resolveStoredWorkspace } from '../../components/UserPill'

const row = (id: string, team_id: string, boat_id: string | null) =>
  ({ id, team_id, boat_id, role: 'team_manager', valid_from: null, valid_to: null,
     team_name: 't', boat_name: boat_id }) as any

const DRAGON = 'team-dragon', NS = 'team-northstar'
const MEMBERSHIP = 'mem-dragon'

describe('resolveStoredWorkspace', () => {
  it('finds the exact row it named', () => {
    const ms = [row('a', NS, 'ns76'), row('b', DRAGON, 'torvar')]
    expect(resolveStoredWorkspace(ms, { id: 'b', team_id: DRAGON })!.id).toBe('b')
  })

  it('follows a boat-less workspace into its expansion', () => {
    // Stored while the team had NO boats, so the id was the bare membership
    // uuid. Boats now exist, so only `<uuid>::<boatId>` rows remain.
    const ms = [
      row('ns', NS, 'ns76'),
      row(`${MEMBERSHIP}::miss`, DRAGON, 'miss'),
      row(`${MEMBERSHIP}::torvar`, DRAGON, 'torvar'),
    ]
    const got = resolveStoredWorkspace(ms, { id: MEMBERSHIP, team_id: DRAGON })!
    expect(got.team_id).toBe(DRAGON)
    expect(got.boat_id).toBeTruthy()
  })

  it('never falls through to another team when the stored team still exists', () => {
    // The bug: the miss sent the caller to the GLOBAL default, which is the
    // current Northstar boat — a different team entirely.
    const ms = [row('ns', NS, 'ns76'), row('other-id', DRAGON, 'torvar')]
    const got = resolveStoredWorkspace(ms, { id: 'gone', team_id: DRAGON })!
    expect(got.team_id).toBe(DRAGON)
    expect(got.team_id).not.toBe(NS)
  })

  it('prefers a boat-scoped row over a boat-less one in the same team', () => {
    const ms = [row('teamwide', DRAGON, null), row('scoped', DRAGON, 'torvar')]
    expect(resolveStoredWorkspace(ms, { id: 'gone', team_id: DRAGON })!.id).toBe('scoped')
  })

  it('returns undefined when the team is gone, so the caller picks a default', () => {
    const ms = [row('ns', NS, 'ns76')]
    expect(resolveStoredWorkspace(ms, { id: 'gone', team_id: 'deleted-team' })).toBeUndefined()
  })

  it('returns undefined with nothing stored', () => {
    expect(resolveStoredWorkspace([row('a', NS, 'ns76')], null)).toBeUndefined()
    expect(resolveStoredWorkspace([], { id: 'x', team_id: 'y' })).toBeUndefined()
  })

  it('does not mistake a different membership sharing an id prefix', () => {
    const ms = [row('mem-1234::boat', DRAGON, 'boat')]
    // 'mem-1' must not match 'mem-1234::boat'
    expect(resolveStoredWorkspace(ms, { id: 'mem-1', team_id: 'other' })).toBeUndefined()
  })
})

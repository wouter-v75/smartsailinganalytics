import { describe, it, expect } from 'vitest'
import {
  loadComments, addComment, deleteComment, canDelete, authorLine, isFromPartner,
  type SquadComment,
} from '../squadComments'

const c = (o: Partial<SquadComment> = {}): SquadComment => ({
  id: 'c1', tag_event_id: 'tag1', owner_team_id: 'dragon',
  author_user_id: 'u1', author_team_id: 'dragon', body: 'late on the sheet',
  created_at: '2026-02-08T13:00:00Z', ...o,
})

const reply = (status: number, body: unknown) =>
  (async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch

describe('loadComments — empty is not the same as broken', () => {
  it('reports OK with no comments', async () => {
    const s = await loadComments('tag1', reply(200, { comments: [], viewerId: 'u1' }))
    expect(s).toEqual({ kind: 'ok', comments: [], viewerId: 'u1' })
  })

  it('reports ERROR rather than an empty thread when the server refuses', async () => {
    // An empty thread is what a broken RLS policy looks like. That exact
    // ambiguity hid the squad feature for a day; it must not recur here.
    const s = await loadComments('tag1', reply(500, { error: 'boom' }))
    expect(s).toEqual({ kind: 'error', message: 'boom' })
  })

  it('reports UNAVAILABLE when the table is not there yet', async () => {
    const s = await loadComments('tag1', reply(200, { needsMigration: true }))
    expect(s.kind).toBe('unavailable')
  })

  it('does not throw when the network is gone', async () => {
    const boom = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    const s = await loadComments('tag1', boom)
    expect(s.kind).toBe('error')
  })
})

describe('addComment', () => {
  it('refuses empty or whitespace before troubling the server', async () => {
    let called = false
    const spy = (async () => { called = true; return { ok: true, json: async () => ({}) } }) as unknown as typeof fetch
    expect(await addComment('t', 'team', '   ', spy)).toEqual({ ok: false, error: 'a comment needs some words' })
    expect(called).toBe(false)
  })

  it('sends the trimmed body and the team being spoken for', async () => {
    let sent: any = null
    const spy = (async (_u: string, init: any) => {
      sent = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ comment: c() }) }
    }) as unknown as typeof fetch
    const r = await addComment('tag1', 'dragon', '  hello  ', spy)
    expect(sent).toEqual({ body: 'hello', author_team_id: 'dragon' })
    expect(r.ok).toBe(true)
  })

  it('surfaces the server\'s refusal verbatim', async () => {
    const r = await addComment('t', 'team', 'hi', reply(403, { error: 'not in that squad' }))
    expect(r).toEqual({ ok: false, error: 'not in that squad' })
  })
})

describe('deleteComment', () => {
  it('reports failure rather than pretending it worked', async () => {
    expect(await deleteComment('t', 'c', reply(403, { error: 'not yours' })))
      .toEqual({ ok: false, error: 'not yours' })
  })
  it('succeeds quietly', async () => {
    expect(await deleteComment('t', 'c', reply(200, { deleted: 'c' }))).toEqual({ ok: true })
  })
})

describe('canDelete — your own words only', () => {
  it('allows the author', () => {
    expect(canDelete(c({ author_user_id: 'u1' }), 'u1')).toBe(true)
  })

  it('refuses everyone else, INCLUDING the team that owns the tag', () => {
    // Deleting somebody's sentence out of your debrief is not a power 0074
    // hands out — a team that dislikes a comment un-shares the category.
    expect(canDelete(c({ author_user_id: 'partner' }), 'owner-user')).toBe(false)
  })

  it('refuses a signed-out viewer', () => {
    expect(canDelete(c(), null)).toBe(false)
  })
})

describe('authorLine', () => {
  it('names the person and their team', () => {
    expect(authorLine(c({ author: { name: 'Jonathan' }, team: { name: 'Team Torvar' } })))
      .toBe('Jonathan · Team Torvar')
  })
  it('falls back through email, then to something neutral', () => {
    expect(authorLine(c({ author: { email: 'j@x.com' }, team: { name: 'T' } }))).toBe('j@x.com · T')
    expect(authorLine(c({ author: null, team: null }))).toBe('Someone')
  })
})

describe('isFromPartner', () => {
  it('marks a comment from another team', () => {
    // The whole point of the feature. Rendering a rival coach's words exactly
    // like your own crew's throws away the context that makes them useful.
    expect(isFromPartner(c({ author_team_id: 'torvar', owner_team_id: 'dragon' }))).toBe(true)
    expect(isFromPartner(c({ author_team_id: 'dragon', owner_team_id: 'dragon' }))).toBe(false)
  })
})

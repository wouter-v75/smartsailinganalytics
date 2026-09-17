// The migration is one behaviour: a read tries the tenant-scoped key, then the
// flat pre-migration key. Nothing in the zone has to move for old sessions to
// keep opening. If this stops holding, every session uploaded before storage was
// scoped silently disappears from the app — so it is worth pinning down.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SCOPE = { teamId: 'team-abc', boatId: 'boat-xyz' }
const DATE = '2026-09-11'
const SCOPED = 'teams/team-abc/boats/boat-xyz/sessions/2026-09-11/log.json'
const LEGACY = 'sessions/2026-09-11/log.json'

let asked: string[] = []
/** Serve only the keys named; everything else 404s, as Bunny's proxy does. */
function zoneContaining(...present: string[]) {
  return vi.fn(async (url: string) => {
    const key = decodeURIComponent(new URL(url, 'http://x').searchParams.get('key') || '')
    asked.push(key)
    return present.includes(key)
      ? { ok: true, json: async () => ({ rows: [{ utc: 1 }], from: key }) }
      : { ok: true, json: async () => null }   // the proxy returns 200/null for absent
  }) as unknown as typeof fetch
}

beforeEach(() => { asked = [] })
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

async function readLog(scope: typeof SCOPE | null) {
  const { fetchSessionFile } = await import('../bunny')
  const { SESSION_LEAVES } = await import('../storageKeys')
  return fetchSessionFile(scope, DATE, SESSION_LEAVES.log)
}

describe('fetchSessionFile', () => {
  it('takes the scoped copy when there is one, without asking for the legacy key', async () => {
    vi.stubGlobal('fetch', zoneContaining(SCOPED, LEGACY))
    const got = await readLog(SCOPE) as { from: string }
    expect(got.from).toBe(SCOPED)
    expect(asked).toEqual([SCOPED])
  })

  it('falls back to the pre-migration key — a session uploaded before scoping', async () => {
    vi.stubGlobal('fetch', zoneContaining(LEGACY))
    const got = await readLog(SCOPE) as { from: string }
    expect(got.from).toBe(LEGACY)
    expect(asked).toEqual([SCOPED, LEGACY])
  })

  it('returns null when the day is in neither place', async () => {
    vi.stubGlobal('fetch', zoneContaining())
    expect(await readLog(SCOPE)).toBeNull()
    expect(asked).toEqual([SCOPED, LEGACY])
  })

  it('asks only for the flat key when there is no scope, and does not ask twice', async () => {
    vi.stubGlobal('fetch', zoneContaining(LEGACY))
    const got = await readLog(null) as { from: string }
    expect(got.from).toBe(LEGACY)
    expect(asked).toEqual([LEGACY])
  })
})

describe('uploadSessionFile', () => {
  it('writes to the scoped key, never the flat one', async () => {
    const put = vi.fn(async () => ({ ok: true, status: 201 }))
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/storage/credentials')) {
        return { ok: true, json: async () => ({ accessKey: 'k', zone: 'z', host: 'https://h' }) }
      }
      return put(url as never, init as never)
    }) as unknown as typeof fetch)

    const { uploadSessionFile } = await import('../bunny')
    const { SESSION_LEAVES } = await import('../storageKeys')
    await uploadSessionFile(SCOPE, DATE, SESSION_LEAVES.log, { rows: [] })

    expect(put).toHaveBeenCalledTimes(1)
    expect(String(put.mock.calls[0][0])).toBe(`https://h/z/${SCOPED}`)
  })

  it('two boats on one day write to different keys — the collision this removes', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/storage/credentials')) {
        return { ok: true, json: async () => ({ accessKey: 'k', zone: 'z', host: 'https://h' }) }
      }
      seen.push(String(url))
      return { ok: true, status: 201 }
    }) as unknown as typeof fetch)

    const { uploadSessionFile } = await import('../bunny')
    const { SESSION_LEAVES } = await import('../storageKeys')
    await uploadSessionFile({ teamId: 't', boatId: 'b1' }, DATE, SESSION_LEAVES.log, { n: 1 })
    await uploadSessionFile({ teamId: 't', boatId: 'b2' }, DATE, SESSION_LEAVES.log, { n: 2 })

    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
  })
})

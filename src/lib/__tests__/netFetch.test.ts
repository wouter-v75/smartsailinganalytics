import { describe, it, expect, vi, afterEach } from 'vitest'
import { why, retryingFetch } from '../../../scripts/lib/netFetch'

// ─────────────────────────────────────────────────────────────────────────────
// "TypeError: fetch failed" is undici's answer to every transport problem, and
// on 8 October it stopped the Road 2 self-test dead after thirteen passing
// checks — a Supabase keep-alive socket that had been closed at the far end
// while the slow localhost POSTs ran. The script blamed the invitations table.
// ─────────────────────────────────────────────────────────────────────────────

afterEach(() => vi.unstubAllGlobals())

describe('why', () => {
  it('digs the real code out of a nested cause', () => {
    const e = new TypeError('fetch failed')
    ;(e as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    expect(why(e)).toBe('fetch failed ← ECONNRESET')
  })

  it('follows an AggregateError into its first address failure', () => {
    // What a refused port looks like: one error per address family.
    const inner = Object.assign(new Error('connect ECONNREFUSED ::1:3000'), { code: 'ECONNREFUSED' })
    const agg = Object.assign(new Error('AggregateError'), { errors: [inner] })
    const e = Object.assign(new TypeError('fetch failed'), { cause: agg })
    expect(why(e)).toMatch(/ECONNREFUSED/)
  })

  it('does not loop for ever on a cause that points at itself', () => {
    const e = new Error('round') as Error & { cause?: unknown }
    e.cause = e
    expect(why(e)).toBe('round')
  })

  it('still says something for a thrown non-error', () => {
    expect(why('just a string')).toBe('just a string')
  })
})

describe('retryingFetch', () => {
  it('opens a new connection after a dead socket, and returns the second reply', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }),
      }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await retryingFetch('https://example.invalid/rest/v1/invitations')
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a reply — a script that retries a refusal cannot test refusals', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"nope"}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await retryingFetch('https://example.invalid/x')
    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up with the reason, not with "fetch failed"', async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('x'), { code: 'EAI_AGAIN' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(retryingFetch('https://example.invalid/x')).rejects.toThrow(/EAI_AGAIN/)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

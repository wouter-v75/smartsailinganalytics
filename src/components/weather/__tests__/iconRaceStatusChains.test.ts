import { describe, it, expect, vi, afterEach } from 'vitest'
// @ts-expect-error — plain JS module, no types
import { fetchIconRaceStatus, ICONRACE_STATUS_FILES } from '../openMeteo'

const calls: string[] = []
const mockFetch = (ok: boolean, body: unknown = {}) =>
  vi.fn(async (url: string) => { calls.push(url); return { ok, json: async () => body } as never })

afterEach(() => { calls.length = 0; vi.unstubAllGlobals() })

describe('Icon-Race status is per CHAIN, not per domain', () => {
  it('lists a file for each chain the box can publish', () => {
    // The box writes one status file per chain because they carry different
    // CYCLES — sharing one file means each chain erases the other's, and the
    // Admin table then describes a run that is not happening.
    expect(ICONRACE_STATUS_FILES).toContain('status.json')
    expect(ICONRACE_STATUS_FILES).toContain('status_usa.json')
    expect(new Set(ICONRACE_STATUS_FILES).size).toBe(ICONRACE_STATUS_FILES.length)
  })

  it('defaults to status.json, so the existing chain is unchanged', async () => {
    vi.stubGlobal('fetch', mockFetch(true, { cycle: '2026102200' }))
    await fetchIconRaceStatus()
    expect(calls[0]).toContain('icon-race%2Fstatus.json')
    expect(calls[0]).not.toContain('status_usa')
  })

  it('asks for the named file when given one', async () => {
    vi.stubGlobal('fetch', mockFetch(true, { cycle: '2026102212' }))
    await fetchIconRaceStatus('status_usa.json')
    expect(calls[0]).toContain('icon-race%2Fstatus_usa.json')
  })

  it('returns null for a chain that is not running rather than throwing', async () => {
    // A venue out of season simply 404s. That has to read as "nothing to show",
    // not as an error, or an idle chain would break the whole table.
    vi.stubGlobal('fetch', mockFetch(false))
    expect(await fetchIconRaceStatus('status_usa.json')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await fetchIconRaceStatus('status_usa.json')).toBeNull()
  })

  it('each chain keeps its own cycle', async () => {
    const med = { cycle: '2026102200', overall: 'DONE' }
    const usa = { cycle: '2026102212', overall: 'RUNNING' }
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      ({ ok: true, json: async () => (url.includes('usa') ? usa : med) } as never)))
    const [a, b] = await Promise.all(ICONRACE_STATUS_FILES.map((f: string) => fetchIconRaceStatus(f)))
    expect(a.cycle).toBe('2026102200')
    expect(b.cycle).toBe('2026102212')
    expect(a.cycle).not.toBe(b.cycle)
  })
})

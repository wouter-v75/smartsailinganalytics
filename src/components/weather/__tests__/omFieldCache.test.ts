import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchWindField } from '../windField'

// Open-Meteo bills a multi-coordinate request PER LOCATION (measured 2026-09-11),
// so a wind field is a third to a half of the 600/min free budget. These pin the
// cache and the rate-limit handling that keep one field from being paid twice.

const N = 144                                   // METNO field: 12 x 12
const pts = () => Array.from({ length: N }, () => ({
  hourly: {
    time: ['2026-09-11T10:00', '2026-09-11T11:00'],
    wind_speed_10m: [5, 6],
    wind_direction_10m: [200, 210],
  },
}))
const ok = () => ({ ok: true, status: 200, json: async () => pts() })
const limited = (reason: string) => ({ ok: false, status: 429, json: async () => ({ error: true, reason }) })
// each test uses its own point, so the module cache cannot leak between tests
const field = (lat: number) =>
  fetchWindField({ modelKey: 'METNO', lat, lon: 10.35, height: 10, timezone: 'UTC' } as any)

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('Open-Meteo field cache', () => {
  it('fetches the same field ONCE when two views ask for it', async () => {
    const f = vi.fn(async () => ok())
    globalThis.fetch = f as unknown as typeof fetch
    const [a, b] = await Promise.all([field(59.01), field(59.01)])
    expect(f).toHaveBeenCalledTimes(1)
    expect(a.frames.length).toBe(2)
    expect(b.frames.length).toBe(2)
    await field(59.01)                            // and again later, within the TTL
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('requests the 12 x 12 grid METNO is configured for', async () => {
    const f = vi.fn(async () => ok())
    globalThis.fetch = f as unknown as typeof fetch
    await field(59.02)
    const url = String((f.mock.calls[0] as any[])[0])
    const lats = new URL(url).searchParams.get('latitude')!.split(',')
    expect(lats.length).toBe(N)
  })

  it('never caches a failure — the next caller tries again', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce(ok())
    globalThis.fetch = f as unknown as typeof fetch
    await expect(field(59.03)).rejects.toThrow(/Open-Meteo 500/)
    const r = await field(59.03)
    expect(r.frames.length).toBe(2)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('waits out a PER-MINUTE limit once, then succeeds', async () => {
    vi.useFakeTimers()
    const f = vi.fn()
      .mockResolvedValueOnce(limited('Minutely API request limit exceeded. Please try again in one minute.'))
      .mockResolvedValueOnce(ok())
    globalThis.fetch = f as unknown as typeof fetch
    const p = field(59.04)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f).toHaveBeenCalledTimes(1)           // still waiting — a minute, not 4 s
    await vi.advanceTimersByTimeAsync(1_500)
    const r = await p
    expect(f).toHaveBeenCalledTimes(2)
    expect(r.frames.length).toBe(2)
  })

  it('gives up at once on an HOURLY limit — it will not clear in time', async () => {
    const f = vi.fn(async () => limited('Hourly API request limit exceeded.'))
    globalThis.fetch = f as unknown as typeof fetch
    await expect(field(59.05)).rejects.toThrow(/Hourly API request limit/)
    expect(f).toHaveBeenCalledTimes(1)
  })
})

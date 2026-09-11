import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchSurfaceModel } from '../openMeteo'

// The console error that started this: "[weather] METNO HTTP 429 (gave up after
// retries)". The old backoff totalled ~4.2 s against a 60 s window, so it could
// never succeed. A per-minute limit is now waited out once, visibly.

const body = {
  latitude: 59.9, longitude: 10.7, elevation: 0,
  hourly: { time: ['2026-09-11T10:00', '2026-09-11T11:00'], wind_speed_10m: [7, 8], wind_direction_10m: [200, 205] },
}
const ok = () => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body })
const limited = (reason: string) => ({ ok: false, status: 429, json: async () => ({ error: true, reason }) })
const call = (onThrottle?: (t: { seconds: number; reason: string }) => void) =>
  fetchSurfaceModel({ modelKey: 'METNO', latitude: 59.9, longitude: 10.7, timezone: 'UTC', onThrottle } as any)

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('surface fetch under Open-Meteo rate limits', () => {
  it('waits out a per-minute limit ONCE, says so, and recovers', async () => {
    vi.useFakeTimers()
    const f = vi.fn()
      .mockResolvedValueOnce(limited('Minutely API request limit exceeded. Please try again in one minute.'))
      .mockResolvedValueOnce(ok())
    globalThis.fetch = f as unknown as typeof fetch
    const throttles: Array<{ seconds: number }> = []
    const p = call((t) => throttles.push(t))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(throttles).toEqual([expect.objectContaining({ seconds: 61 })])   // reported before waiting
    expect(f).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(52_000)
    const r: any = await p
    expect(f).toHaveBeenCalledTimes(2)
    expect(r?.hourly?.wind_speed_10m).toEqual([7, 8])
  })

  it('gives up at once on an hourly limit, without pretending to wait', async () => {
    const f = vi.fn(async () => limited('Hourly API request limit exceeded.'))
    globalThis.fetch = f as unknown as typeof fetch
    const throttles: unknown[] = []
    const r = await call((t) => throttles.push(t))
    expect(r).toBeNull()
    expect(throttles).toEqual([])
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('does not wait twice if the minute is still exhausted', async () => {
    vi.useFakeTimers()
    const minute = 'Minutely API request limit exceeded. Please try again in one minute.'
    const f = vi.fn(async () => limited(minute))
    globalThis.fetch = f as unknown as typeof fetch
    const p = call()
    await vi.advanceTimersByTimeAsync(62_000)
    const r = await p
    expect(r).toBeNull()
    expect(f).toHaveBeenCalledTimes(2)          // one wait, one retry, then honest failure
  })
})

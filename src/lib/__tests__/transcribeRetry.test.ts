// The 3 Sept debrief upload died on net::ERR_NETWORK_IO_SUSPENDED — Chrome tearing
// down an in-flight chunk when the machine slept — and took the whole 17-minute run
// with it. postChunk must ride out that class of failure without restarting.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// @ts-expect-error — debriefAudio is plain JS, no declaration file
import { postChunk } from '../debriefAudio'

const ok = (text: string) => ({ ok: true, status: 200, json: async () => ({ text }) })
const fail = (status: number, error: string) => ({ ok: false, status, json: async () => ({ error }) })

const chunk = () => new Blob(['audio'], { type: 'audio/mpeg' })

// Run the call while fast-forwarding through the backoff sleeps. The handler is
// attached before the timers run, so a rejection is never briefly unhandled.
async function run<T>(p: Promise<T>): Promise<T> {
  const settled = p.then((v) => () => v, (e) => () => { throw e })
  await vi.runAllTimersAsync()
  return (await settled)()
}

describe('postChunk', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('retries a dropped connection and keeps the chunk', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(ok('  hoist on the primary  '))
    vi.stubGlobal('fetch', fetchMock)

    await expect(run(postChunk(chunk(), 0, 'bias'))).resolves.toBe('hoist on the primary')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after the last attempt with an error that names the cause', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(run(postChunk(chunk(), 2, 'bias'))).rejects.toThrow(/connection dropped while sending part 3/)
    expect(fetchMock).toHaveBeenCalledTimes(5) // first try + 4 backoffs
  })

  it('retries a 503 from the provider', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fail(503, 'upstream busy'))
      .mockResolvedValueOnce(ok('the MH0 cable arrives tonight'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(run(postChunk(chunk(), 0, 'bias'))).resolves.toBe('the MH0 cable arrives tonight')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a bad request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fail(400, 'prompt too long'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(run(postChunk(chunk(), 0, 'bias'))).rejects.toThrow('prompt too long')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry the route\'s own 55 s timeout — the same chunk would blow it again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fail(504, 'transcription >55s (aborted) — send shorter chunks'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(run(postChunk(chunk(), 0, 'bias'))).rejects.toThrow(/send shorter chunks/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// What a device remembers about its own uplink and its own encoder.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map<string, unknown>()
vi.mock('../prefsStore', () => ({
  getPref: async (k: string) => store.get(k),
  setPref: async (k: string, v: unknown) => { store.set(k, v) },
}))

import {
  recordUpload, recordEncode, uplinkBps, encodeBps, measuredThroughput, forgetCachedStats,
  likelyEngine, measurementSummary,
} from '../uploadStats'

const MB = 1024 * 1024

beforeEach(() => { store.clear(); forgetCachedStats() })

describe('uploadStats', () => {
  it('has no opinion until something has been measured', async () => {
    expect(await uplinkBps()).toBeNull()
    expect(await encodeBps('webcodecs')).toBeNull()
  })

  it('remembers an upload and reports it in bytes per second', async () => {
    await recordUpload(20 * MB, 4)
    expect((await uplinkBps())!).toBeCloseTo(5 * MB, -3)
  })

  it('ignores the log upload, which measures handshake and not bandwidth', async () => {
    // Every push sends a few MB of log first, over in a moment. Believing it
    // would let a 4 MB transfer decide how a 2 GB one is handled.
    await recordUpload(100 * 1024, 2)
    await recordUpload(10 * MB, 0.3)
    expect(await uplinkBps()).toBeNull()
  })

  it('keeps the two ENGINES apart — they differ by 5-20×', async () => {
    // A laptop that normally uses WebCodecs and falls back once to software
    // must not carry that one slow sample into every later decision.
    await recordEncode(100 * MB, 2, 'webcodecs')     // 50 MB/s
    await recordEncode(100 * MB, 50, 'ffmpeg')       // 2 MB/s
    expect((await encodeBps('webcodecs'))!).toBeCloseTo(50 * MB, -5)
    expect((await encodeBps('ffmpeg'))!).toBeCloseTo(2 * MB, -5)
  })

  it('learns nothing from a transcode whose engine is unknown', async () => {
    await recordEncode(100 * MB, 2, null)
    expect(await encodeBps('webcodecs')).toBeNull()
    expect(await encodeBps('ffmpeg')).toBeNull()
  })

  it('survives a restart — the second clip of a day is decided on evidence', async () => {
    await recordUpload(20 * MB, 4)
    forgetCachedStats()                              // a new page load
    expect((await uplinkBps())!).toBeCloseTo(5 * MB, -3)
  })

  it('answers both questions at once for the engine that will run', async () => {
    await recordUpload(20 * MB, 4)
    await recordEncode(100 * MB, 2, 'webcodecs')
    const m = await measuredThroughput('webcodecs')
    expect(m.uplinkBps).toBeGreaterThan(0)
    expect(m.encodeBps).toBeGreaterThan(0)
    // …and nothing for the engine that has never run here.
    expect((await measuredThroughput('ffmpeg')).encodeBps).toBeNull()
  })

  it('a store that cannot be written still works for this session', async () => {
    // The in-memory cache is updated BEFORE the persist is attempted, so a
    // private window — where IndexedDB is refused — still gets an adaptive
    // decision for as long as the tab is open. It simply starts over next time.
    vi.resetModules()
    vi.doMock('../prefsStore', () => ({
      getPref: async () => { throw new Error('IndexedDB unavailable') },
      setPref: async () => { throw new Error('IndexedDB unavailable') },
    }))
    const broken = await import('../uploadStats')
    broken.forgetCachedStats()
    await expect(broken.recordUpload(20 * MB, 4)).resolves.toBeUndefined()
    expect((await broken.uplinkBps())!).toBeCloseTo(5 * MB, -3)   // this session
    broken.forgetCachedStats()                                     // a new page load
    expect(await broken.uplinkBps()).toBeNull()                    // nothing persisted
    vi.doUnmock('../prefsStore')
  })

  it('a read that throws is "no measurement", never a guess', async () => {
    // Which is what makes the failure safe: chooseStrategy with no numbers
    // picks the transcode, exactly as the app behaved before any of this.
    vi.resetModules()
    vi.doMock('../prefsStore', () => ({
      getPref: async () => { throw new Error('nope') },
      setPref: async () => {},
    }))
    const broken = await import('../uploadStats')
    broken.forgetCachedStats()
    expect(await broken.uplinkBps()).toBeNull()
    expect(await broken.encodeBps('webcodecs')).toBeNull()
    vi.doUnmock('../prefsStore')
  })

  it('ignores a stored value of the wrong shape rather than trusting it', async () => {
    store.set('uplinkThroughput', { nonsense: true })
    forgetCachedStats()
    expect(await uplinkBps()).toBeNull()
  })
})

describe('likelyEngine — what will actually run, not what is allowed', () => {
  it('falls back to the probe before anything has ever been encoded', async () => {
    expect(await likelyEngine(true)).toBe('webcodecs')
    expect(await likelyEngine(false)).toBe('ffmpeg')
  })

  it('believes the engine that RAN over the probe that says hardware', async () => {
    // generateProxy falls back to software on ANY throw, so a device whose
    // probe says "hardware" can still be encoding in software every time.
    // Predicting with the hardware figure would be optimistic by 5-20×, in the
    // direction that skips a proxy the link actually needed.
    await recordEncode(100 * MB, 50, 'ffmpeg')
    forgetCachedStats()
    expect(await likelyEngine(true)).toBe('ffmpeg')
  })

  it('remembers the engine even when the sample was too small to learn a rate', async () => {
    // The fallback HAVING HAPPENED is the fact that matters most for the next
    // prediction, independently of whether the timing was usable.
    await recordEncode(50 * 1024, 0.2, 'ffmpeg')     // far too small to time
    expect(await encodeBps('ffmpeg')).toBeNull()      // learned no rate
    expect(await likelyEngine(true)).toBe('ffmpeg')   // but learned the engine
  })

  it('summarises what the device has learned, for the readiness check', async () => {
    await recordUpload(20 * MB, 4)
    await recordEncode(100 * MB, 2, 'webcodecs')
    const m = await measurementSummary()
    expect(m.uplinkBps!).toBeCloseTo(5 * MB, -3)
    expect(m.hardwareBps!).toBeCloseTo(50 * MB, -5)
    expect(m.softwareBps).toBeNull()
    expect(m.lastEngine).toBe('webcodecs')
  })
})

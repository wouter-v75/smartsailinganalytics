// Which route a clip takes, decided from measurements rather than assumed.
//
// The numbers in these cases are the real ones: the 27 Nov test clips, the
// proxy bitrate the encoder is actually given, and the two links this has been
// run on — Kent field wifi, where a 23.6 MB PUT died twice, and a London flat.

import { describe, it, expect } from 'vitest'
import {
  chooseStrategy, predictProxyBytes, addSample, estimate, usableSample,
  DIRECT_MAX_BYTES, PROXY_BITRATE_BPS,
} from '../uploadStrategy'

const MB = 1024 * 1024
// Bytes/sec for a given megabit/sec link.
const mbit = (m: number) => (m * 1e6) / 8

describe('predictProxyBytes', () => {
  it('predicts from the bitrate the encoder is given, before spending the CPU', () => {
    // 35 s at 4.8 Mbit + 128 kbit audio.
    const p = predictProxyBytes(35)!
    expect(p).toBeGreaterThan(20e6)
    expect(p).toBeLessThan(23e6)
    expect(PROXY_BITRATE_BPS).toBe(4_800_000)
  })

  it('refuses to guess without a duration', () => {
    for (const d of [null, undefined, 0, -1, NaN]) {
      expect(predictProxyBytes(d as number)).toBeNull()
    }
  })
})

describe('chooseStrategy', () => {
  it('transcodes when nothing has been measured — the old behaviour, unchanged', () => {
    // A first upload on an unknown link is the worst moment to gamble.
    const d = chooseStrategy({ sourceBytes: 200 * MB, durationSec: 120 })
    expect(d.strategy).toBe('transcode')
    expect(d.why).toMatch(/no measurement/i)
  })

  it('transcodes a 4K card file over dock wifi — the case this exists for', () => {
    // 2 GB, 3 minutes, 2 Mbit up. Direct would be over two hours.
    const d = chooseStrategy({
      sourceBytes: 2000 * MB, durationSec: 180, height: 2160,
      uplinkBps: mbit(2), encodeBps: 8 * MB,
    })
    expect(d.strategy).toBe('transcode')
  })

  it('sends a modest clip as it is on a fast link', () => {
    // 100 MB, 60 s, 200 Mbit up, software encoder at 2 MB/s of source.
    const d = chooseStrategy({
      sourceBytes: 100 * MB, durationSec: 60, height: 1080,
      uplinkBps: mbit(200), encodeBps: 2 * MB,
    })
    expect(d.strategy).toBe('direct')
    expect(d.why).toMatch(/faster than the encoder/i)
  })

  it('still transcodes on a fast link when the encoder is much faster still', () => {
    // Hardware encoder at 80 MB/s of source against a 20 Mbit link: encoding is
    // nearly free and the proxy is a fifth of the bytes.
    const d = chooseStrategy({
      sourceBytes: 400 * MB, durationSec: 120, height: 1080,
      uplinkBps: mbit(20), encodeBps: 80 * MB,
    })
    expect(d.strategy).toBe('transcode')
    expect(d.estTranscodeSec!).toBeLessThan(d.estDirectSec!)
  })

  it('needs the link to be CLEARLY faster, not faster by a hair', () => {
    // Being wrong about the uplink costs a long upload on a bad link; being
    // wrong about the encoder costs some CPU on a good one. Not symmetrical.
    const marginal = chooseStrategy({
      sourceBytes: 100 * MB, durationSec: 60, height: 1080,
      uplinkBps: 10 * MB, encodeBps: 11.5 * MB,
    })
    expect(marginal.strategy).toBe('transcode')
  })

  it('never sends a very large file as it is, however fast the link looks', () => {
    // One lucky sample from a 4 MB log upload can make cafe wifi look like a
    // datacentre. Acting on that with a 2 GB file is an upload that never ends.
    const d = chooseStrategy({
      sourceBytes: DIRECT_MAX_BYTES + 1, durationSec: 600, height: 2160,
      uplinkBps: mbit(10_000), encodeBps: 1 * MB,
    })
    expect(d.strategy).toBe('transcode')
    expect(d.why).toMatch(/too big to send as it is/i)
  })

  it('sends a clips:day cut straight through — it is already a review copy', () => {
    // 720p at the proxy's own bitrate. Re-encoding it is pure loss, and this is
    // most of what the watch folder ever sees.
    const d = chooseStrategy({
      sourceBytes: 20 * MB, durationSec: 35, height: 720,
      uplinkBps: mbit(2), encodeBps: 50 * MB,
    })
    expect(d.strategy).toBe('direct')
    expect(d.why).toMatch(/already a 720p review copy/i)
  })

  it('does NOT call a big 720p file a review copy', () => {
    // 720p but at four times the proxy bitrate — a re-encode really does save
    // bytes, so the height alone must not decide it.
    const d = chooseStrategy({
      sourceBytes: 90 * MB, durationSec: 35, height: 720,
      uplinkBps: mbit(2), encodeBps: 50 * MB,
    })
    expect(d.strategy).toBe('transcode')
  })

  it('reports both estimates even when it cannot choose between them', () => {
    const d = chooseStrategy({ sourceBytes: 50 * MB, durationSec: 30, uplinkBps: 5 * MB })
    expect(d.estDirectSec).toBeCloseTo(10, 0)
    expect(d.estTranscodeSec).toBeNull()   // no encoder measurement yet
  })

  it('the 27 Nov test clip: 23.6 MB in 35 s, both links', () => {
    const clip = { sourceBytes: 23.6e6, durationSec: 35, height: 1080 }
    // Kent field wifi — the PUT died twice at this size. Encoding first halves
    // the bytes and is the right call.
    const slow = chooseStrategy({ ...clip, uplinkBps: mbit(1.5), encodeBps: 3 * MB })
    expect(slow.strategy).toBe('transcode')
    // London flat. The "proxy" came out the same size as the original, so the
    // encode bought nothing at all and the maths should see that.
    const fast = chooseStrategy({ ...clip, uplinkBps: mbit(100), encodeBps: 3 * MB })
    expect(fast.strategy).toBe('direct')
  })
})

describe('the throughput estimate', () => {
  it('starts from the first sample rather than from zero', () => {
    const e = addSample(null, 5 * MB)
    expect(estimate(e)).toBeCloseTo(5 * MB, 0)
  })

  it('refuses to be talked into optimism by one lucky sample', () => {
    // The whole reason for taking the slower of the two averages.
    let e = addSample(null, 1 * MB)
    e = addSample(e, 1 * MB)
    e = addSample(e, 50 * MB)       // one burst
    expect(estimate(e)!).toBeLessThan(10 * MB)
  })

  it('follows a link that has genuinely changed', () => {
    let e = addSample(null, 1 * MB)
    for (let n = 0; n < 12; n++) e = addSample(e, 20 * MB)
    expect(estimate(e)!).toBeGreaterThan(10 * MB)
  })

  it('drops to a slow link quickly — the expensive direction', () => {
    let e = addSample(null, 20 * MB)
    e = addSample(e, 0.5 * MB)
    // min(fast, slow) means one bad sample pulls the answer down at once,
    // which is the right asymmetry: optimism is what costs an upload.
    expect(estimate(e)!).toBeLessThan(14 * MB)
  })

  it('ignores a zero or nonsense rate instead of poisoning the average', () => {
    const base = addSample(null, 4 * MB)
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(estimate(addSample(base, bad))).toBeCloseTo(estimate(base)!, 0)
    }
  })

  it('has no answer before it has a sample', () => {
    expect(estimate(null)).toBeNull()
    expect(estimate({ fast: 0, slow: 0, samples: 0 })).toBeNull()
  })
})

describe('usableSample', () => {
  it('ignores a transfer too small or too short to mean anything', () => {
    // The first thing every push uploads is a small log file — exactly the
    // shape of sample that measures handshake rather than bandwidth.
    expect(usableSample(100 * 1024, 2)).toBe(false)
    expect(usableSample(10 * MB, 0.3)).toBe(false)
  })

  it('accepts a real one', () => {
    expect(usableSample(6.7e6, 3.2)).toBe(true)
    expect(usableSample(4 * MB, 1.0)).toBe(true)
  })
})

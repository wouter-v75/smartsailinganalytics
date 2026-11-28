// Which route a clip takes, decided from measurements rather than assumed.
//
// The numbers in these cases are the real ones: the 27 Nov test clips, the
// proxy bitrate the encoder is actually given, and the two links this has been
// run on — Kent field wifi, where a 23.6 MB PUT died twice, and a London flat.

import { describe, it, expect } from 'vitest'
import {
  chooseStrategy, predictProxyBytes, addSample, estimate, usableSample,
  DIRECT_MAX_BYTES, PROXY_BITRATE_BPS, crossoverUplinkBps, DIRECT_MARGIN,
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

  it('the 27 Nov test clip goes direct on BOTH links — its proxy saved nothing', () => {
    // 23.6 MB in 35 s. This case used to assert `transcode` on the slow link
    // with the comment "encoding first halves the bytes", alongside a second
    // assertion that the proxy "came out the same size as the original". Both
    // cannot be true of one clip, and it is the second that was measured: at
    // 35 s the predicted proxy is 21.6 MB, 8 % smaller, so the encode buys
    // four seconds of upload on Kent wifi in exchange for the whole encode and
    // a 720p file in place of a 1080p one.
    const clip = { sourceBytes: 23.6e6, durationSec: 35, height: 1080 }
    for (const uplink of [mbit(1.5), mbit(100)]) {
      const d = chooseStrategy({ ...clip, uplinkBps: uplink, encodeBps: 3 * MB })
      expect(d.strategy).toBe('direct')
      expect(d.why).toContain('no smaller')
    }
  })

  it('but a CARD FILE on the same wifi still transcodes — that is what it is for', () => {
    // The point the case above was reaching for, with a clip that really does
    // shrink: 2 minutes of 4K at 180 Mbit is 1.3 GB, and its proxy is 70 MB.
    // Kent wifi would take five hours over the original and half an hour over
    // the proxy, so the bytes are unambiguously the constraint.
    const d = chooseStrategy({
      sourceBytes: 1350 * MB, durationSec: 120, height: 2160,
      uplinkBps: mbit(1.5), encodeBps: 3 * MB,
    })
    expect(d.strategy).toBe('transcode')
    expect(predictProxyBytes(120)! / (1350 * MB)).toBeLessThan(0.1)
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

describe('crossoverUplinkBps — where the answer flips', () => {
  // A 200 MB, 2-minute 1080p clip: the readout's sample case.
  const clip = { sourceBytes: 200 * MB, durationSec: 120 }

  it('scales with the encoder, so a HARDWARE encoder almost never gives way', () => {
    // This is the finding that corrects the obvious intuition. A fast encoder
    // makes transcoding cheap, so the link has to be extraordinary before
    // sending 200 MB raw beats sending 70 MB after a few seconds of CPU.
    const hw = crossoverUplinkBps({ ...clip, encodeBps: 18 * MB })!
    expect((hw * 8) / 1e6).toBeCloseTo(136, 0)       // Mbit/s — faster than most fibre uplinks

    const sw = crossoverUplinkBps({ ...clip, encodeBps: 1 * MB })!
    expect((sw * 8) / 1e6).toBeCloseTo(8, 0)         // software: ordinary broadband clears it
    expect(sw).toBeLessThan(hw)
  })

  it('agrees with chooseStrategy on both sides of its own threshold', () => {
    // The whole point of publishing a threshold is that it is the SAME
    // threshold. A readout that disagreed with the decision would be worse
    // than no readout.
    const encodeBps = 8 * MB
    const x = crossoverUplinkBps({ ...clip, encodeBps })!
    const at = (uplinkBps: number) =>
      chooseStrategy({ ...clip, height: 1080, uplinkBps, encodeBps }).strategy
    expect(at(x * 1.02)).toBe('direct')
    expect(at(x * 0.98)).toBe('transcode')
  })

  it('is zero when the proxy would save nothing — no link is slow enough to justify it', () => {
    // 10 s of 1080p at 2 Mbit: the predicted proxy is LARGER than the source,
    // so the encode is pure cost. That is the 27 Nov clip whose proxy came out
    // the same size as the original.
    const p = predictProxyBytes(10)!
    expect(crossoverUplinkBps({ sourceBytes: p, durationSec: 10, encodeBps: 8 * MB })).toBe(0)
    // And it is zero across the whole no-gain band, not only at P === S. This
    // is the half DIRECT_MARGIN got wrong on its own: at P/S = 0.9 the margin
    // left a positive threshold of E·0.35, so below ~16 Mbit/s a clip whose
    // proxy saved 10 % was still sent off to spend the entire encode.
    expect(crossoverUplinkBps({ sourceBytes: p / 0.9, durationSec: 10, encodeBps: 8 * MB })).toBe(0)
    expect(DIRECT_MARGIN - 0.9).toBeGreaterThan(0)
  })

  it('answers null rather than guessing when the encoder is unmeasured', () => {
    expect(crossoverUplinkBps({ ...clip, encodeBps: null })).toBeNull()
    expect(crossoverUplinkBps({ ...clip, encodeBps: 0 })).toBeNull()
    expect(crossoverUplinkBps({ sourceBytes: 200 * MB, encodeBps: 8 * MB })).toBeNull() // no duration
  })
})

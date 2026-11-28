// src/lib/uploadStrategy.ts
// ─────────────────────────────────────────────────────────────────────────────
// TRANSCODE FIRST, OR SEND THE FILE AS IT IS? Decided from the measured link,
// not assumed.
//
// Until now every clip was encoded to 720p in the browser before it was sent.
// That is right when bytes are the bottleneck — a 2 GB card file over dock wifi
// becomes 60 MB, and that is the difference between arriving and not. It is
// pure cost when they are not: on a laptop on good wifi it spends minutes of
// CPU, produces a worse copy than Bunny would make from the full-quality
// source, and saves bytes nobody was waiting on. On the 35 s test clip of
// 27 Nov the "proxy" came out the same size as the original and saved nothing
// at all.
//
// WHAT THE REST OF THE INDUSTRY DOES, and why this is not simply "upload the
// original like everyone else":
//
//   • Mux, Cloudflare Stream, Vimeo, Frame.io and Wistia take the original and
//     transcode server-side. Browser transcoding is the minority choice and is
//     taken for one reason — when the uplink is the constraint.
//   • What they invest in instead is the TRANSFER: chunked, resumable, and
//     adaptive. Mux Uploader has a `dynamicChunkSize` that "adapts larger or
//     smaller based on network conditions"; Cloudflare asks for 5 MiB chunks on
//     a poor link and 50 MiB on a good one. Neither publishes the algorithm.
//   • BUT Bunny's free encoding "may take anywhere from several hours to
//     multiple days" under load. So "upload the original and let the ladder
//     make a 720p rung" is right for quality and wrong for watchability: the
//     team would wait hours to see the day.
//
// That last point is what makes the local answer different from the industry
// one, and it is why this stays a CHOICE rather than becoming "always send the
// original". What makes a clip watchable here is the STORAGE copy — a
// progressive MP4, playable the moment its bytes land, whichever form it is in.
// Both strategies produce one. So the only question left is which gets the team
// watching sooner, and that is arithmetic.
//
// THE ARITHMETIC. With S = source bytes, P = proxy bytes, U = uplink bytes/sec
// and E = encode throughput in bytes of SOURCE per second:
//
//     transcode then send:  S/E + P/U
//     send as it is:        S/U
//
// so sending as-is is faster exactly when
//
//     S/U < S/E + P/U   ⇔   (S − P)/U < S/E   ⇔   U > E·(1 − P/S)
//
// Sending as-is also wins on quality and leaves the full-resolution file in the
// cloud as the archive, so a tie goes to it. A margin biases the other way all
// the same: being wrong about the uplink costs a long upload on a bad link,
// while being wrong about the encoder costs some CPU on a good one, and those
// are not equally bad.
//
// Pure. Every input is measured by the caller and passed in; nothing here
// touches the network, the clock or storage.
// ─────────────────────────────────────────────────────────────────────────────

/** Target bitrate of the 720p proxy, bits/sec — must match video-proxy.ts. */
export const PROXY_BITRATE_BPS = 4_800_000

/**
 * How big the proxy WILL be, before making it.
 *
 * The encoder is given a target bitrate, so duration alone predicts the size to
 * within the usual VBR slop. Predicting it is what lets the decision be made
 * BEFORE spending the CPU — measuring it afterwards would be too late to be of
 * any use.
 *
 * Audio is copied rather than re-encoded where possible, so it is counted at a
 * nominal 128 kbps rather than ignored.
 */
export function predictProxyBytes(durationSec: number | null | undefined): number | null {
  if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0) return null
  return Math.round(((PROXY_BITRATE_BPS + 128_000) / 8) * durationSec)
}

export interface StrategyInput {
  /** Size of the file as it stands. */
  sourceBytes: number
  /** Clip length, for predicting the proxy. */
  durationSec?: number | null
  /** Source height — a 720p-or-smaller file has nothing to gain from a re-encode. */
  height?: number | null
  /** Measured uplink, bytes/sec. Null when nothing has been measured yet. */
  uplinkBps?: number | null
  /**
   * Measured encode throughput in bytes of SOURCE per second. Null when this
   * device has never transcoded anything.
   */
  encodeBps?: number | null
}

export type Strategy = 'direct' | 'transcode'

export interface Decision {
  strategy: Strategy
  /** One line, for the progress message and the log. */
  why: string
  /** Seconds, for the two routes. Null where an input was missing. */
  estDirectSec: number | null
  estTranscodeSec: number | null
}

/**
 * Being wrong about the uplink is worse than being wrong about the encoder, so
 * the link has to be this much better than break-even before the proxy is
 * skipped. 1.25 = "clearly faster", not "faster by a hair".
 */
export const DIRECT_MARGIN = 1.25

/**
 * Never send a file bigger than this as it is, however fast the link looks.
 *
 * Not for speed — the arithmetic already handles speed. It is for the estimate
 * being WRONG: a single good sample from a 4 MB log upload can make a flat
 * cafe wifi look like a datacentre, and acting on that with a 2 GB card file
 * means an upload that cannot finish. Above the ceiling the proxy is always
 * worth making, and 2 GB of 4K is exactly the case browser transcoding exists
 * for.
 */
export const DIRECT_MAX_BYTES = 600 * 1024 * 1024

/**
 * Below this much saving the transcode is not worth making, whatever the link.
 *
 * 0.83 rather than 1.0 because a proxy within a fifth of the source saves
 * nothing a slow link would notice while still costing the whole encode, and
 * because the predicted size carries VBR slop in both directions. It is the
 * same ratio the old `sourceBytes <= proxyBytes * 1.2` rule used, now applied
 * without the 720p condition that limited it.
 */
export const NO_GAIN_RATIO = 0.83

export function chooseStrategy(i: StrategyInput): Decision {
  const { sourceBytes, durationSec, height, uplinkBps, encodeBps } = i
  const proxyBytes = predictProxyBytes(durationSec)

  const estDirectSec = uplinkBps && uplinkBps > 0 ? sourceBytes / uplinkBps : null
  const estTranscodeSec =
    uplinkBps && uplinkBps > 0 && encodeBps && encodeBps > 0 && proxyBytes != null
      ? sourceBytes / encodeBps + proxyBytes / uplinkBps
      : null

  // NOTHING TO GAIN: the predicted proxy is not meaningfully smaller than the
  // source, so the transcode has no upside at ANY link speed. Transcoding costs
  // S/E + P/U against direct's S/U, so with P ≈ S direct is faster by exactly
  // the encode, produces a better file, and leaves the full-resolution archive
  // in the cloud. There is no trade-off here for DIRECT_MARGIN to bias.
  //
  // This generalises the rule it replaces, which required `height <= 720` and
  // so only caught clips:day output. A long calm 1080p clip at a low bitrate
  // has the same property and used to fall through to the arithmetic — where,
  // below ~16 Mbit/s, it was sent off to spend CPU saving no bytes at all. The
  // crossover test is what surfaced that: `crossoverUplinkBps` came back at
  // E·(1.25 − 1) rather than zero for a clip whose proxy equalled its source.
  if (proxyBytes != null && proxyBytes >= sourceBytes * NO_GAIN_RATIO) {
    const alreadySmall = !!height && height > 0 && height <= 720
    return {
      strategy: 'direct',
      why: alreadySmall
        ? 'already a 720p review copy — nothing to re-encode'
        : 'the proxy would be no smaller than the source — nothing to re-encode',
      estDirectSec, estTranscodeSec,
    }
  }

  if (sourceBytes > DIRECT_MAX_BYTES) {
    return {
      strategy: 'transcode',
      why: `${Math.round(sourceBytes / 1e6)} MB is too big to send as it is`,
      estDirectSec, estTranscodeSec,
    }
  }

  // Nothing measured: keep doing what has always been done. A first upload on
  // an unknown link is the worst moment to gamble on it being fast.
  if (estDirectSec == null || estTranscodeSec == null) {
    return {
      strategy: 'transcode',
      why: 'no measurement of this connection yet — encoding first, as before',
      estDirectSec, estTranscodeSec,
    }
  }

  if (estDirectSec * DIRECT_MARGIN < estTranscodeSec) {
    return {
      strategy: 'direct',
      why: `the link is faster than the encoder — sending as it is ` +
        `(~${Math.round(estDirectSec)}s against ~${Math.round(estTranscodeSec)}s)`,
      estDirectSec, estTranscodeSec,
    }
  }
  return {
    strategy: 'transcode',
    why: `encoding first is quicker here ` +
      `(~${Math.round(estTranscodeSec)}s against ~${Math.round(estDirectSec)}s)`,
    estDirectSec, estTranscodeSec,
  }
}

// ── measuring the two throughputs ───────────────────────────────────────────
// A dual exponentially-weighted average, fast and slow, taking the LOWER of the
// two as the answer. It is what adaptive-bitrate players do with segment
// download times (hls.js keeps a fast and a slow EWMA and prefers the
// conservative one), and the reasoning carries over: the fast average follows a
// link that has genuinely changed — walking off a boat onto 5G — while the slow
// one refuses to be talked into optimism by a single lucky sample. Taking the
// minimum means a burst of speed has to persist before it is believed.
//
// `navigator.connection` is deliberately not used. It is absent in Safari,
// reports a coarse bucket rather than a rate, and describes the DOWNLINK, which
// is not the number any of this depends on.

export interface Ewma {
  fast: number
  slow: number
  samples: number
}

/** Weight per sample. 0.4 ≈ the last 2-3 samples; 0.1 ≈ the last 10-15. */
const FAST_ALPHA = 0.4
const SLOW_ALPHA = 0.1

export function addSample(prev: Ewma | null, bytesPerSec: number): Ewma {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return prev || { fast: 0, slow: 0, samples: 0 }
  if (!prev || prev.samples === 0) return { fast: bytesPerSec, slow: bytesPerSec, samples: 1 }
  return {
    fast: prev.fast + FAST_ALPHA * (bytesPerSec - prev.fast),
    slow: prev.slow + SLOW_ALPHA * (bytesPerSec - prev.slow),
    samples: prev.samples + 1,
  }
}

/** The conservative read: the lower of the two averages. */
export function estimate(e: Ewma | null | undefined): number | null {
  if (!e || !e.samples) return null
  const v = Math.min(e.fast, e.slow)
  return v > 0 ? v : null
}

/**
 * Is a sample worth believing?
 *
 * A transfer over in well under a second is mostly handshake and buffering, and
 * a tiny one says more about latency than bandwidth. Both would otherwise push
 * the estimate around hard — and the first thing every push uploads is a small
 * log file, which is exactly the shape of sample that lies.
 */
export function usableSample(bytes: number, seconds: number): boolean {
  return bytes >= 256 * 1024 && seconds >= 0.75 && Number.isFinite(seconds)
}

/**
 * The uplink at which this device would STOP transcoding, bytes/sec.
 *
 * Worth exposing because the answer is counter-intuitive and was got wrong
 * here: a hardware encoder is so fast that transcoding nearly always wins, and
 * sending as-is is mostly a rescue for a device that has fallen back to
 * software. Measured on a 200 MB / 2-minute 1080p clip:
 *
 *      1 MB/s of source (software)  →  as-is above    8 Mbit/s
 *      2 MB/s           (software)  →                15 Mbit/s
 *      8 MB/s           (hardware)  →                60 Mbit/s
 *     18 MB/s           (hardware)  →               136 Mbit/s
 *
 * so a laptop with WebCodecs will keep making proxies on all but a datacentre
 * link, and that is the right answer rather than a missed optimisation — a
 * nearly-free encode that cuts the bytes by two thirds is simply worth doing.
 * Without this printed somewhere, "it always transcodes" reads as broken.
 *
 * Direct is chosen when `U > E·(DIRECT_MARGIN − P/S)`, so the threshold scales
 * with the encoder and falls to zero once the predicted proxy saves nothing.
 */
export function crossoverUplinkBps(i: {
  sourceBytes: number
  durationSec?: number | null
  encodeBps?: number | null
}): number | null {
  const { sourceBytes, durationSec, encodeBps } = i
  const proxyBytes = predictProxyBytes(durationSec)
  if (!encodeBps || encodeBps <= 0 || proxyBytes == null || !sourceBytes) return null
  // Agrees with chooseStrategy's NO_GAIN rule, which short-circuits before the
  // arithmetic: a proxy that saves nothing is never worth the CPU, so there is
  // no link slow enough to justify it and the threshold is zero.
  if (proxyBytes >= sourceBytes * NO_GAIN_RATIO) return 0
  const factor = DIRECT_MARGIN - proxyBytes / sourceBytes
  return factor <= 0 ? 0 : encodeBps * factor
}

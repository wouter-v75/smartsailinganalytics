// src/lib/uploadChunk.ts
// ─────────────────────────────────────────────────────────────────────────────
// HOW BIG A TUS CHUNK SHOULD BE, from the measured link.
//
// THE BUG THIS EXISTS FOR. tus-js-client 3.x defaults `chunkSize` to
// `Infinity` — "the entire file will be sent in one request" — and Flow B never
// set it. So the archive copy of a day's card footage went up as a SINGLE PATCH
// of several gigabytes. The resume record made it look resumable, and across
// attempts it is, but within that one request nothing is: a drop at 90 % throws
// away 90 % of the transfer, and the retry re-sends from whatever offset Bunny
// admits to having, which after an aborted stream is not reliably the 90 %.
// A multi-hour single request is also the shape most likely to be killed by a
// proxy, a sleep, or a browser's own limits.
//
// WHAT THE INDUSTRY DOES, and it is the one part of uploading they all invest
// in rather than publish an algorithm for:
//
//   • Mux's UpChunk defaults to 30 MB and adapts between 256 KB and 512 MB.
//   • Cloudflare Stream REQUIRES 5 MiB or more, recommends up to 50 MiB,
//     refuses over 200 MiB, and wants a multiple of 256 KiB.
//   • Mux Uploader exposes `dynamicChunkSize`, described only as adapting
//     "larger or smaller based on network conditions".
//
// THE RULE HERE. A chunk should take a FEW SECONDS to send. That is the whole
// idea, and everything else follows from it:
//
//   • too small and the upload is latency-bound — a round trip per chunk, and
//     on a satellite or a dock 4G link the round trip is the cost;
//   • too large and a drop costs more than it needs to, and progress moves in
//     steps too coarse to tell a stalled upload from a slow one.
//
// So: target TARGET_CHUNK_SECONDS at the measured rate, clamp, align. With no
// measurement it takes the floor rather than a guess, because an unmeasured
// link is more likely to be bad than good — the laptop on a boat is the case
// this whole subsystem exists for.
//
// Pure. The caller measures and passes in.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long one chunk should take to send.
 *
 * Five seconds is short enough that a drop costs little and progress feels
 * live, and long enough that the per-request round trip is a small share of it
 * even on a link with 500 ms of latency.
 */
export const TARGET_CHUNK_SECONDS = 5

/**
 * Smallest chunk worth sending, and the default when nothing is known.
 *
 * 5 MiB is Cloudflare's hard minimum for their own TUS endpoint. Bunny
 * publishes no such floor — this is borrowed, not measured against Bunny — but
 * it is the right shape of number: below it the round trips dominate.
 */
export const MIN_CHUNK_BYTES = 5 * 1024 * 1024

/**
 * Largest chunk. 64 MiB is above Cloudflare's recommended 50 MiB and well
 * below their 200 MiB refusal, and at any plausible uplink it is more than
 * TARGET_CHUNK_SECONDS of data — so on a fast link the ceiling, not the
 * target, is what binds, which is the intended behaviour: past this size a
 * bigger chunk buys nothing and only raises the cost of a drop.
 */
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024

/**
 * Chunk sizes are aligned to 256 KiB.
 *
 * Cloudflare requires this of their endpoint. Bunny does not document any such
 * requirement, so this is DEFENSIVE rather than necessary — it costs nothing,
 * and an aligned chunk is the one shape every TUS server in use has been
 * tested against.
 */
export const CHUNK_ALIGN = 256 * 1024

/**
 * The chunk size for one upload, in bytes.
 *
 * `uplinkBps` is the measured rate (see uploadStats). `fileBytes` caps it: a
 * chunk larger than the file is just the file, and asking for one makes the
 * progress bar a single step.
 */
export function chunkSizeFor(i: {
  fileBytes: number
  uplinkBps?: number | null
}): number {
  const { fileBytes, uplinkBps } = i
  const target =
    uplinkBps && uplinkBps > 0
      ? uplinkBps * TARGET_CHUNK_SECONDS
      : MIN_CHUNK_BYTES // unmeasured: assume the worst, not the best
  const clamped = Math.min(MAX_CHUNK_BYTES, Math.max(MIN_CHUNK_BYTES, target))
  const aligned = Math.floor(clamped / CHUNK_ALIGN) * CHUNK_ALIGN
  // A file smaller than one chunk goes in one chunk. Never return 0.
  if (fileBytes > 0 && fileBytes < aligned) return fileBytes
  return Math.max(CHUNK_ALIGN, aligned)
}

/** For the log — "24.5 MiB chunks, ~5s each". */
export function describeChunking(chunkBytes: number, uplinkBps?: number | null): string {
  const mib = (chunkBytes / (1024 * 1024)).toFixed(1)
  if (!uplinkBps || uplinkBps <= 0) return `${mib} MiB chunks (link not measured yet)`
  return `${mib} MiB chunks, ~${Math.max(1, Math.round(chunkBytes / uplinkBps))}s each`
}

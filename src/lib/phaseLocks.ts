// src/lib/phaseLocks.ts
// ─────────────────────────────────────────────────────────────────────────────
// One transcode at a time, one upload at a time — so that two clips can OVERLAP.
//
// Uploading a day's clips was strictly serial: encode clip 1, upload clip 1,
// encode clip 2, upload clip 2. Two different resources sat idle in turn — the
// uplink while the CPU encoded, the CPU while the uplink sent — and on a day of
// twenty clips that is most of the wall-clock. Overlapping them (encode clip
// N+1 while clip N uploads) roughly halves it when the two take similar time.
//
// WHY A LOCK IS REQUIRED BEFORE ANY OVERLAP IS SAFE, and not merely tidier:
// ffmpeg.wasm is a SINGLE INSTANCE per page with one virtual filesystem, shared
// by every caller (see ffmpegInstance in video-proxy.ts). Two transcodes at once
// would write each other's input and output files and emit each other's
// progress. So concurrency without this is not slower-but-fine, it is wrong.
//
// The upload lock is a choice rather than a necessity: parallel uploads share
// one uplink, so they finish no sooner in total and every one of them is slower
// — which matters because a clip is watchable the moment ITS bytes land, so
// finishing one beats making progress on five. It also keeps the failure
// smaller on a bad connection, where a dropped PUT costs everything it had sent.
//
// FIFO, because the caller has already put the clips in the order the team
// wants them (uploadOrder.ts: starts, then roundings, then manoeuvres) and a
// lock that reordered them would quietly undo that.
//
// Pure: module-level state, no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

export interface PhaseLock {
  /** Run `fn` with the lock held, releasing it even if `fn` throws. */
  run<T>(fn: () => Promise<T>, onWait?: () => void): Promise<T>
  /** Is someone holding it right now? For a "waiting for…" message. */
  busy(): boolean
  /** How many are queued behind the holder. */
  waiting(): number
}

export function createPhaseLock(): PhaseLock {
  let held = false
  const queue: (() => void)[] = []

  const acquire = async (onWait?: () => void): Promise<void> => {
    if (!held) { held = true; return }
    // Tell the caller it is QUEUED rather than stalled. A progress bar that sits
    // at 0 with no explanation is the thing people read as "stuck".
    onWait?.()
    await new Promise<void>((resolve) => queue.push(resolve))
    held = true
  }

  const release = () => {
    const next = queue.shift()
    if (next) { held = false; next() } else { held = false }
  }

  return {
    async run<T>(fn: () => Promise<T>, onWait?: () => void): Promise<T> {
      await acquire(onWait)
      try { return await fn() } finally { release() }
    },
    busy: () => held,
    waiting: () => queue.length,
  }
}

/**
 * The browser's single ffmpeg instance. Required — see the header.
 */
export const transcodeLock = createPhaseLock()

/**
 * The uplink. One clip's bytes at a time, so each becomes watchable as early as
 * possible instead of five arriving together at the end.
 */
export const uploadLock = createPhaseLock()

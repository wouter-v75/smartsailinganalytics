// src/lib/uplinkPriority.ts
// ─────────────────────────────────────────────────────────────────────────────
// One thing on the uplink matters more than the rest: the day's LOG.
//
// 10 October: a day's movies were uploading and the log sat at 3 %. Nothing was
// broken — the log is a 4 MB PUT sharing a dock wifi with gigabytes of video,
// so it crawled. But the log is what every other device needs FIRST. Until it
// lands, the phone on the dock shows that day with no track, no detections, no
// starts and no way to place a tag; the movies it is queued behind are watchable
// one at a time, later, by people sitting down.
//
// So the log takes the uplink and the video queues yield to it. The same
// argument uploadOrder.ts already makes about clip order — serial uploads mean
// the order decides what the team can see first — applied one level up, between
// kinds of upload rather than within one.
//
// WHAT THIS DOES NOT DO: preempt bytes already in flight. A 2 GB movie halfway
// up stays halfway up; what stops is the NEXT one starting. On a queue of
// twenty clips that is the difference between the log landing after one and
// after twenty, which is the difference that matters. Cancelling an in-flight
// upload would throw away the part already sent, and the uploader has no
// resume.
//
// Pure except for the module-level counter — no React, no I/O.
// ─────────────────────────────────────────────────────────────────────────────

let holders = 0
let waiters: (() => void)[] = []

const release = () => {
  const queued = waiters
  waiters = []
  for (const w of queued) w()
}

/** Is something priority on the uplink right now? */
export const uplinkBusy = (): boolean => holders > 0

/**
 * Claim the uplink for a priority upload. Returns the function that gives it
 * back — call it in a `finally`, or the video queues wait for ever.
 *
 * Re-entrant: two logs at once (a day's log and its event file) both hold it,
 * and the queues resume when the last one lets go.
 */
export function claimUplink(): () => void {
  holders++
  let freed = false
  return () => {
    if (freed) return          // a double release must not free somebody else's claim
    freed = true
    holders = Math.max(0, holders - 1)
    if (holders === 0) release()
  }
}

/** Run `fn` holding the uplink, releasing it however `fn` ends. */
export async function withUplink<T>(fn: () => Promise<T>): Promise<T> {
  const free = claimUplink()
  try { return await fn() } finally { free() }
}

/**
 * Wait until no priority upload is in flight. Resolves immediately when the
 * uplink is free, which is the normal case — this costs the video queues one
 * already-resolved await per item.
 */
export function awaitUplink(): Promise<void> {
  if (holders === 0) return Promise.resolve()
  return new Promise<void>((resolve) => { waiters.push(resolve) })
}

/** Test-only: forget every claim and wake everybody waiting. */
export function resetUplink(): void {
  holders = 0
  release()
}

// Has a resumable upload stopped existing, or did the network just blink?
//
// Bunny expires a TUS upload at the `AuthorizationExpire` it was created with,
// or after roughly 48 hours of inactivity, whichever comes first — ours is
// signed for two hours. After that "requesting the upload returns 404 Not
// Found", and re-signing does NOT help: the docs are explicit that "A new
// signature does not extend the original expiry."
//
// That distinction is the whole file. Our evening originals queue keeps the
// Stream video's guid in localStorage so the next run can resume, and treated
// every failure as transient — so once an upload expired, each run re-signed
// it, got another 404, and kept the guid for ever. The fingerprint of that is a
// Stream video with 0 bytes and status `created` sitting beside a complete
// encode of the same clip, which is exactly what migration 0108 had to repoint
// a row away from.
//
// WHICH WAY TO ERR. Restarting a live upload costs bandwidth and heals itself;
// retrying a dead one never completes. But a marina link blinks constantly, and
// restarting a multi-GB original on every blip would be worse than the stall —
// so this is deliberately NARROW. A network error carries no HTTP response at
// all, so it is correctly not "gone", and only a real 404/410 from Bunny is.

/** The shape tus-js-client's DetailedError exposes; all of it optional. */
interface TusLikeError {
  originalResponse?: {
    getStatus?: (() => number) | number
    status?: number
  } | null
}

function statusOf(err: unknown): number | null {
  const res = (err as TusLikeError | null)?.originalResponse
  if (!res) return null
  // tus exposes it as a method; tolerate a plain property in case a future
  // version or a hand-rolled stub differs.
  const raw = typeof res.getStatus === 'function' ? res.getStatus() : (res.getStatus ?? res.status)
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

/**
 * True when the upload Bunny was holding is gone and no signature will bring it
 * back, so the caller must forget the video guid and start a fresh one.
 *
 * 404 is what Bunny documents for an expired upload. 410 Gone is included
 * because it is the other status that means the same thing and costs nothing to
 * accept.
 */
export function uploadIsGone(err: unknown): boolean {
  const s = statusOf(err)
  return s === 404 || s === 410
}

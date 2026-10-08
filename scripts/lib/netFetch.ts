// A fetch that survives a dead keep-alive socket, and an error message that
// says what actually happened.
//
// 8 October: the Road 2 self-test passed all thirteen refusals, then died on
// the next Supabase call with "could not create a test join code: TypeError:
// fetch failed". Nothing was wrong with the call. Node keeps a connection to
// Supabase alive for reuse; while the slow localhost POSTs were running, that
// idle socket was closed at the other end, and the next request went out down
// a pipe that was no longer there. undici reports every transport failure as
// the same four words, with the real reason — ECONNRESET, ETIMEDOUT, EAI_AGAIN
// — hidden one level down in `cause`.
//
// Both answers live here. A retry, because the second attempt opens a new
// connection and simply works; and `why()`, because "fetch failed" is not a
// diagnosis and a script that prints it has told you nothing.

/** The real reason, dug out of undici's nested causes. */
export function why(e: unknown): string {
  const seen = new Set<unknown>()
  let cur: unknown = e
  const parts: string[] = []
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const o = cur as { message?: string; code?: string; errors?: unknown[]; cause?: unknown }
    if (o.code) parts.push(o.code)
    else if (o.message) parts.push(o.message)
    // AggregateError, as thrown when every address of a host refuses.
    if (Array.isArray(o.errors) && o.errors.length) cur = o.errors[0]
    else cur = o.cause
  }
  return parts.filter((p, i) => p && parts.indexOf(p) === i).join(' ← ') || String(e)
}

/**
 * fetch, retried on a TRANSPORT failure only.
 *
 * A reply is a reply: 4xx and 5xx come straight back, because a script that
 * retries a refusal is a script that cannot test refusals. Only a throw — no
 * reply at all — is retried.
 */
export const retryingFetch: typeof fetch = async (input, init) => {
  const tries = 3
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(input as never, init as never)
    } catch (e) {
      last = e
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)))
    }
  }
  throw new Error(`network failure after ${tries} tries: ${why(last)}`)
}

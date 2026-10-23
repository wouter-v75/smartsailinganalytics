// Wall-clock time in a named zone ↔ the UTC instant it names.
//
// Extracted from sailScanParse.ts, which had the only correct implementation
// in the repo, so that the observation adapters do not grow a second one. A
// clock read in the wrong zone is the single most expensive mistake in this
// project — wrong calendar day, wrong log rows, wrong overlay — and it is
// invisible in the value itself, so there should be exactly one place where
// the conversion happens.
//
// DST-aware and independent of the server's own timezone: Vercel runs in UTC
// and the laptop does not, and neither should change what a feed's "06:50"
// means.

/** Offset (ms) of an IANA zone at a given UTC instant. */
export function tzOffsetMs(atUtcMs: number, tz: string): number {
  const d = new Date(atUtcMs)
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p: Record<string, string> = {}
  for (const part of dtf.formatToParts(d)) p[part.type] = part.value
  let hour = +p.hour
  if (hour === 24) hour = 0
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second)
  return asUTC - atUtcMs
}

/**
 * Interpret Y/M/D h:m:s as wall-clock time in `tz` and return the UTC instant.
 *
 * The offset is looked up at the naive guess and then subtracted, which is
 * right everywhere except the hour either side of a DST transition — where a
 * wall time is ambiguous (clocks back) or does not exist (clocks forward) and
 * no answer is correct. Observations are five minutes apart, so at worst one
 * row of one night lands an hour out, which the staleness window and the
 * "never from the future" check both tolerate.
 */
export function wallClockToUtcMs(
  Y: number, Mo: number, D: number, h: number, mi: number, s: number, tz: string,
): number {
  const guess = Date.UTC(Y, Mo - 1, D, h, mi, s)
  return guess - tzOffsetMs(guess, tz)
}

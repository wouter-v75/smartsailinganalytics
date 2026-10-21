// src/lib/inviteNearMiss.ts
// ─────────────────────────────────────────────────────────────────────────────
// "I sent the invitation last week" and "there is no invitation for that
// address" cannot both be true. So the address that was INVITED is not the
// address being asked about — and one mistyped character is invisible in a
// form, in a sent mail, and in a verdict that only says "no row".
//
// Chris Taylor, 21 October 2026, is the case this was written for: a
// consultant invite to Baraka that never arrived.
//
// Lives here rather than in the script so it can be tested — importing a
// script runs its top-level argument parsing, which calls process.exit.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far apart two strings are, up to a cap.
 *
 * Levenshtein, bounded: anything past `cap` is reported as cap + 1, because
 * the only question here is "is this nearly the same address", and a long
 * distance needs no precision.
 */
function editDistance(a: string, b: string, cap = 4): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    prev = row
    if (Math.min(...row) > cap) return cap + 1
  }
  return prev[b.length]
}

/** The name-like pieces of a local part: chris.taylor → ['chris', 'taylor']. */
const tokens = (local: string): string[] =>
  local.split(/[._+-]+/).filter((t) => t.length >= 4)

/**
 * Is this address nearly the one we were asked about?
 *
 * Two different kinds of "nearly", because typos and house styles are not the
 * same thing:
 *
 *   TYPO       a few characters out — tailor for taylor, doylesail for
 *              doylesails. Bounded edit distance catches these.
 *   SHORT NAME c.taylor for chris.taylor, ctaylor, cjtaylor. Four characters
 *              of edit distance, so no sane cap catches it — but the SURNAME
 *              survives intact, so a shared name-like token does.
 *
 * The second rule has to be the narrow one or it flags the whole company:
 * a token must be at least four characters and must appear in the other local
 * part, which is why jane.wilkinson and svea at the same sailmaker do not
 * match chris.taylor.
 */
export function nearMiss(asked: string, found: string): { near: boolean; why: string } | null {
  if (!asked || !found) return null
  // Identical is not NEAR. It also cannot happen where this is used — it is
  // reached only when the asked address has no invitation — so an exact match
  // means the caller asked something else.
  if (asked === found) return null

  const [aLocal, aDomain] = asked.split('@')
  const [fLocal, fDomain] = found.split('@')
  if (!aDomain || !fDomain || !aLocal || !fLocal) return null

  if (aDomain === fDomain && aLocal !== fLocal) {
    const d = editDistance(aLocal, fLocal)
    if (d <= 3) return { near: true, why: `same domain, ${d} character(s) different in the name` }
    // The surname, carried whole through a shortened first name.
    const shared = tokens(aLocal).find((t) => fLocal.includes(t))
      || tokens(fLocal).find((t) => aLocal.includes(t))
    if (shared) return { near: true, why: `same domain, and both names contain "${shared}"` }
  }
  if (aLocal === fLocal && aDomain !== fDomain) {
    const d = editDistance(aDomain, fDomain)
    if (d <= 3) return { near: true, why: `same name, ${d} character(s) different in the domain` }
  }
  const whole = editDistance(asked, found)
  if (whole <= 2) return { near: true, why: `${whole} character(s) different` }
  return null
}

/**
 * The lines to print when the address asked about has no invitation at all.
 *
 * PURE — the caller does the query. Partly so this can be tested, and partly
 * because typing a Supabase client as a parameter resolves its generics to
 * `never` and the rows come back untyped.
 */
export function describeNearMisses(
  email: string,
  rows: { email: unknown; role: unknown; created_at: unknown }[],
  fmt: (iso: string) => string = (x) => x
): string[] {
  if (!rows.length) {
    return ['and no invitation to ANY address in that team, so none was ever made']
  }
  const out = [
    `the team's last ${rows.length} invited address(es), newest first —`,
    'a near miss here is the answer:',
  ]
  let flagged = 0
  for (const r of rows) {
    const addr = String(r.email ?? '').toLowerCase()
    const hit = nearMiss(email, addr)
    if (hit) flagged++
    out.push(`${hit ? '⚠' : ' '} ${addr.padEnd(34)} ${String(r.role ?? '').padEnd(12)}`
      + `${fmt(String(r.created_at ?? ''))}${hit ? `  ← ${hit.why}` : ''}`)
  }
  if (flagged) {
    out.push('')
    out.push('Fix it by inviting the RIGHT address; the mistyped invite can be left')
    out.push('to expire, or revoked on the team page. Nothing was sent to him.')
  }
  return out
}

// src/lib/squadCodes.ts
// ─────────────────────────────────────────────────────────────────────────────
// Is a squad join code still usable?
//
// ONE PLACE, because the same three questions are asked twice: here, to decide
// whether to show a copy button, and inside redeem_squad_code() (0076), to
// decide whether to honour it. A badge that says "live" over a code the
// database will refuse is worse than no badge — the manager sends it, the
// other team gets an error, and neither can see why.
//
// The order matters for the REASON, not the verdict: withdrawn is a decision
// somebody took, expiry is the clock, and exhaustion means it worked. Telling
// them apart is the difference between "mint another" and "ask what happened".
// ─────────────────────────────────────────────────────────────────────────────

export interface SquadCode {
  id: string
  token: string
  note?: string | null
  max_uses: number
  used_count: number
  expires_at: string
  revoked_at?: string | null
}

export type CodeState = 'live' | 'withdrawn' | 'expired' | 'used-up'

export function codeState(c: SquadCode, now: number = Date.now()): CodeState {
  if (c.revoked_at) return 'withdrawn'
  const exp = new Date(c.expires_at).getTime()
  // An unparseable date is treated as expired, never as live: failing closed on
  // a capability is the only safe direction.
  if (!Number.isFinite(exp) || exp <= now) return 'expired'
  if (c.used_count >= c.max_uses) return 'used-up'
  return 'live'
}

export const isLive = (c: SquadCode, now?: number): boolean => codeState(c, now) === 'live'

/** What to show beside the token. Empty for a live one — it needs no label. */
export function codeNote(c: SquadCode, now?: number): string {
  const s = codeState(c, now)
  if (s === 'withdrawn') return 'withdrawn'
  if (s === 'expired') return 'expired'
  if (s === 'used-up') return 'used up'
  return ''
}

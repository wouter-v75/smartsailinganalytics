// src/lib/welcome-invite.ts
// Is this invitation still usable, and if not, which way is it dead?
//
// Four answers rather than a boolean, because the person reading the page needs
// a different sentence for each: a used link means "sign in", an expired one
// means "use Forgot password, your membership is fine", a revoked one means
// "ask your manager", and a missing one usually means a mangled copy-paste.
//
// Pure, so the four cases can be tested without a database.

export type InviteState = 'valid' | 'used' | 'expired' | 'revoked' | 'missing'

export interface InviteLike {
  used_count?: number | null
  max_uses?: number | null
  expires_at?: string | null
  revoked_at?: string | null
}

export function classifyInvite(inv: InviteLike | null | undefined, now = Date.now()): InviteState {
  if (!inv) return 'missing'
  if (inv.revoked_at) return 'revoked'
  // Revoked beats expired beats used: that is the order in which somebody can
  // do something about it.
  const expires = inv.expires_at ? Date.parse(inv.expires_at) : NaN
  if (Number.isFinite(expires) && expires < now) return 'expired'
  const used = Number(inv.used_count ?? 0)
  const max = Number(inv.max_uses ?? 1)
  if (Number.isFinite(used) && Number.isFinite(max) && used >= max) return 'used'
  return 'valid'
}

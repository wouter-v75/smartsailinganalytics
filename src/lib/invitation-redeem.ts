// Shared invitation-redemption logic. Used by both POST /api/invitations/[token]
// (called from /join/[token] when user is already authed) and /auth/callback
// (called inline after exchangeCodeForSession, which is why we can't go via
// fetch — the just-set cookies aren't visible to a same-handler fetch).
//
// Behaviour:
//   - Concurrency-safe used_count bump using lt() filter.
//   - Auto-approve happens when:
//       inv.auto_approve === true   AND
//       inv.email matches the user's signup email (case-insensitive)
//     Otherwise (open link, email mismatch) → status stays 'pending' and we
//     set requested_team_id/role/boat_id so the admin approval form prefills.
//   - Always sets the requested_* hints (cleared later when admin approves).

import { getServiceSupabase } from './supabase/server'

interface RedeemArgs {
  token: string
  user: { id: string; email?: string | null }
}

export type RedeemResult =
  | { ok: true; auto_approved: boolean; team_id: string }
  | { ok: false; error: string; status?: number }

interface InviteRow {
  id: string
  team_id: string
  email: string | null
  role: string
  boat_id: string | null
  valid_from: string | null
  valid_to: string | null
  data_from: string | null
  data_to: string | null
  auto_approve: boolean
  max_uses: number
  used_count: number
  expires_at: string
  revoked_at: string | null
  created_by_user_id: string | null
}

function classifyStatus(
  inv: InviteRow
): 'valid' | 'expired' | 'revoked' | 'exhausted' {
  if (inv.revoked_at) return 'revoked'
  if (new Date(inv.expires_at).getTime() < Date.now()) return 'expired'
  if (inv.used_count >= inv.max_uses) return 'exhausted'
  return 'valid'
}

export async function redeemInvitation({
  token,
  user,
}: RedeemArgs): Promise<RedeemResult> {
  const service = getServiceSupabase()
  const { data: inv } = await service
    .from('invitations')
    .select(
      'id, team_id, email, role, boat_id, valid_from, valid_to, data_from, data_to, auto_approve, max_uses, used_count, expires_at, revoked_at, created_by_user_id'
    )
    .eq('token', token)
    .maybeSingle<InviteRow>()

  if (!inv) return { ok: false, error: 'not found', status: 404 }

  const cls = classifyStatus(inv)
  if (cls !== 'valid') return { ok: false, error: cls, status: 410 }

  // Concurrency guard.
  const { data: bumped, error: bumpErr } = await service
    .from('invitations')
    .update({ used_count: inv.used_count + 1 })
    .eq('id', inv.id)
    .lt('used_count', inv.max_uses)
    .select()
    .single()
  if (bumpErr || !bumped) {
    return { ok: false, error: 'exhausted', status: 410 }
  }

  // Audit
  await service.from('events').insert({
    user_id: user.id,
    action: 'invitation.redeem',
    details: {
      invitation_id: inv.id,
      team_id: inv.team_id,
      auto_approve_intent: inv.auto_approve,
    },
  })

  // Auto-approve only if invite is targeted AND signup email matches.
  const inviteeEmail = inv.email?.trim().toLowerCase()
  const userEmail = user.email?.trim().toLowerCase() || null
  const eligibleAutoApprove =
    inv.auto_approve && inviteeEmail !== null && inviteeEmail === userEmail

  if (eligibleAutoApprove) {
    // Create membership.
    const { error: memErr } = await service.from('memberships').insert({
      user_id: user.id,
      team_id: inv.team_id,
      boat_id: inv.boat_id,
      role: inv.role,
      valid_from: inv.valid_from,
      valid_to: inv.valid_to,
      data_from: inv.data_from,
      data_to: inv.data_to,
    })
    if (memErr && !String(memErr.message).includes('duplicate')) {
      return { ok: false, error: memErr.message, status: 500 }
    }
    // Flip status to active and clear hints.
    await service
      .from('users')
      .update({
        status: 'active',
        approved_at: new Date().toISOString(),
        approved_by: inv.created_by_user_id,
        requested_team_id: null,
        requested_role: null,
        requested_boat_id: null,
      })
      .eq('id', user.id)
    return { ok: true, auto_approved: true, team_id: inv.team_id }
  }

  // Manual-approval path: set the hints so the admin approval form prefills.
  await service
    .from('users')
    .update({
      requested_team_id: inv.team_id,
      requested_role: inv.role,
      requested_boat_id: inv.boat_id,
    })
    .eq('id', user.id)
  return { ok: true, auto_approved: false, team_id: inv.team_id }
}

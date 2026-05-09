// Public-ish invitation lookup by token.
//
// GET — returns minimal info to render the /join page:
//   { team_name, role, boat_name?, auto_approve, expires_at,
//     remaining_uses, status: 'valid' | 'expired' | 'revoked' | 'exhausted' }
//
// POST → redeem. Caller MUST be authenticated. Two flows:
//   - auto_approve invitation (email-targeted): create membership, flip
//     status='active' if user was pending.
//   - non-auto invitation (open link): set requested_team_id on the user;
//     team_manager will approve from their queue and create the membership.
//
// Both paths increment used_count.
//
// Service-role is used for the writes because the user's RLS may not yet
// permit insert into memberships (they may not be a team member yet).

import { NextRequest, NextResponse } from 'next/server'
import {
  getServerSupabase,
  getServiceSupabase,
} from '../../../../lib/supabase/server'

interface InviteSnapshot {
  id: string
  team_id: string
  email: string | null
  role: string
  boat_id: string | null
  valid_from: string | null
  valid_to: string | null
  auto_approve: boolean
  max_uses: number
  used_count: number
  expires_at: string
  revoked_at: string | null
  created_by_user_id: string | null
}

function classifyStatus(inv: InviteSnapshot):
  | 'valid'
  | 'expired'
  | 'revoked'
  | 'exhausted' {
  if (inv.revoked_at) return 'revoked'
  if (new Date(inv.expires_at).getTime() < Date.now()) return 'expired'
  if (inv.used_count >= inv.max_uses) return 'exhausted'
  return 'valid'
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  const service = getServiceSupabase()
  const { data: inv, error } = await service
    .from('invitations')
    .select(
      'id, team_id, email, role, boat_id, valid_from, valid_to, auto_approve, max_uses, used_count, expires_at, revoked_at, created_by_user_id'
    )
    .eq('token', params.token)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!inv) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const [{ data: team }, boatQ] = await Promise.all([
    service.from('teams').select('name').eq('id', inv.team_id).maybeSingle(),
    inv.boat_id
      ? service.from('boats').select('name').eq('id', inv.boat_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  return NextResponse.json({
    team_name: team?.name || null,
    role: inv.role,
    boat_name: boatQ.data?.name || null,
    auto_approve: inv.auto_approve,
    expires_at: inv.expires_at,
    remaining_uses: Math.max(0, inv.max_uses - inv.used_count),
    status: classifyStatus(inv),
  })
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  const ssr = getServerSupabase()
  const {
    data: { user },
  } = await ssr.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauth' }, { status: 401 })
  }

  const service = getServiceSupabase()
  const { data: inv } = await service
    .from('invitations')
    .select(
      'id, team_id, email, role, boat_id, valid_from, valid_to, auto_approve, max_uses, used_count, expires_at, revoked_at, created_by_user_id'
    )
    .eq('token', params.token)
    .maybeSingle<InviteSnapshot>()

  if (!inv) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const status = classifyStatus(inv)
  if (status !== 'valid') {
    return NextResponse.json({ error: status }, { status: 410 })
  }

  // Concurrency guard: re-check used_count via an UPDATE … WHERE … RETURNING
  // pattern so two redemptions can't both squeeze through.
  const { data: bumped, error: bumpErr } = await service
    .from('invitations')
    .update({ used_count: inv.used_count + 1 })
    .eq('id', inv.id)
    .lt('used_count', inv.max_uses)
    .select()
    .single()
  if (bumpErr || !bumped) {
    return NextResponse.json({ error: 'exhausted' }, { status: 410 })
  }

  // Audit always.
  await service.from('events').insert({
    user_id: user.id,
    action: 'invitation.redeem',
    details: {
      invitation_id: inv.id,
      team_id: inv.team_id,
      auto_approve: inv.auto_approve,
    },
  })

  if (inv.auto_approve) {
    // Targeted invite: create membership and (if pending) activate.
    const { error: memErr } = await service.from('memberships').insert({
      user_id: user.id,
      team_id: inv.team_id,
      boat_id: inv.boat_id,
      role: inv.role,
      valid_from: inv.valid_from,
      valid_to: inv.valid_to,
    })
    if (memErr) {
      // Already a member? swallow; otherwise surface.
      if (!String(memErr.message).includes('duplicate')) {
        return NextResponse.json({ error: memErr.message }, { status: 500 })
      }
    }
    await service
      .from('users')
      .update({
        status: 'active',
        approved_at: new Date().toISOString(),
        approved_by: inv.created_by_user_id,
      })
      .eq('id', user.id)
      .eq('status', 'pending')
    return NextResponse.json({
      ok: true,
      auto_approve: true,
      team_id: inv.team_id,
    })
  }

  // Open link: set requested_team_id + role + boat so the admin approval
  // form pre-fills with what the team_manager intended.
  await service
    .from('users')
    .update({
      requested_team_id: inv.team_id,
      requested_role: inv.role,
      requested_boat_id: inv.boat_id,
    })
    .eq('id', user.id)
  return NextResponse.json({
    ok: true,
    auto_approve: false,
    team_id: inv.team_id,
  })
}

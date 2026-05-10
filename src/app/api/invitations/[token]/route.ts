// Public-ish invitation lookup + redeem.
//
//   GET  → minimal snapshot for /join/[token] and /signup?invite= pages.
//   POST → redeem (caller must be authenticated; uses shared helper).

import { NextRequest, NextResponse } from 'next/server'
import {
  getServerSupabase,
  getServiceSupabase,
} from '../../../../lib/supabase/server'
import { redeemInvitation } from '../../../../lib/invitation-redeem'

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
}

function classifyStatus(
  inv: InviteSnapshot
): 'valid' | 'expired' | 'revoked' | 'exhausted' {
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
      'id, team_id, email, role, boat_id, valid_from, valid_to, auto_approve, max_uses, used_count, expires_at, revoked_at'
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
    status: classifyStatus(inv as InviteSnapshot),
    // Email surfaced so the signup form can pre-fill it for targeted invites.
    email: inv.email,
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
  const result = await redeemInvitation({
    token: params.token,
    user: { id: user.id, email: user.email ?? null },
  })
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status ?? 500 }
    )
  }
  return NextResponse.json({
    ok: true,
    auto_approve: result.auto_approved,
    team_id: result.team_id,
  })
}

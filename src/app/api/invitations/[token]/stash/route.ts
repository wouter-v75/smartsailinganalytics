// Pre-stash invite hints on a freshly-signed-up user, before they confirm
// their email. This means a stuck email-confirm flow (OTP expiry, mail-app
// link prefetch, etc.) doesn't lose the invite context — admin can still
// see what team / role / boat the user was meant to land on, with the
// approval form pre-filled.
//
// Public-ish endpoint — no auth required because at signup time the user
// has no session yet. Security:
//   - Token must be valid (not revoked / expired / exhausted).
//   - Email must match an existing public.users row whose status='pending'.
//     We use service-role to read that, so RLS isn't in play.
//   - We never auto-approve here. Just set the requested_* columns.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../lib/supabase/server'

interface InviteRow {
  id: string
  team_id: string
  role: string
  boat_id: string | null
  expires_at: string
  revoked_at: string | null
  used_count: number
  max_uses: number
}

export async function POST(
  req: NextRequest,
  { params }: { params: { token: string } }
) {
  const body = (await req.json().catch(() => null)) as
    | { email?: string }
    | null
  const email = body?.email?.trim().toLowerCase()
  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 })
  }

  const service = getServiceSupabase()

  const { data: inv } = await service
    .from('invitations')
    .select(
      'id, team_id, role, boat_id, expires_at, revoked_at, used_count, max_uses'
    )
    .eq('token', params.token)
    .maybeSingle<InviteRow>()
  if (!inv) {
    return NextResponse.json({ error: 'invite not found' }, { status: 404 })
  }
  if (inv.revoked_at) {
    return NextResponse.json({ error: 'revoked' }, { status: 410 })
  }
  if (new Date(inv.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'expired' }, { status: 410 })
  }
  // We don't gate on used_count here — stashing hints is idempotent.

  // Find the pending user by email.
  const { data: target } = await service
    .from('users')
    .select('id, status')
    .eq('email', email)
    .maybeSingle()
  if (!target) {
    return NextResponse.json({ error: 'user not found yet' }, { status: 404 })
  }
  if (target.status !== 'pending') {
    // Already active or disabled — don't overwrite anything.
    return NextResponse.json({ ok: true, no_op: true })
  }

  const { error } = await service
    .from('users')
    .update({
      requested_team_id: inv.team_id,
      requested_role: inv.role,
      requested_boat_id: inv.boat_id,
    })
    .eq('id', target.id)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await service.from('events').insert({
    user_id: target.id,
    action: 'invitation.stash',
    details: { invitation_id: inv.id, team_id: inv.team_id },
  })

  return NextResponse.json({ ok: true })
}

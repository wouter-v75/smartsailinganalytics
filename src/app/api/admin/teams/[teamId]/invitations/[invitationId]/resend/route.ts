// Re-send the invitation email. Only valid for email-targeted, non-revoked,
// non-expired, non-used invitations.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../../../lib/supabase/admin-guard'
import { sendInviteEmail } from '../../../../../../../../lib/email'

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string; invitationId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const service = getServiceSupabase()
  const { data: inv } = await service
    .from('invitations')
    .select('id, email, role, boat_id, token, expires_at, revoked_at, used_count, max_uses')
    .eq('id', params.invitationId)
    .eq('team_id', params.teamId)
    .maybeSingle()

  if (!inv) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  if (!inv.email) {
    return NextResponse.json(
      { error: 'open links have no email recipient' },
      { status: 400 }
    )
  }
  if (inv.revoked_at) {
    return NextResponse.json({ error: 'revoked' }, { status: 410 })
  }
  if (new Date(inv.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'expired' }, { status: 410 })
  }
  if (inv.used_count >= inv.max_uses) {
    return NextResponse.json({ error: 'used up' }, { status: 410 })
  }

  const [{ data: team }, { data: boat }, { data: inviter }] = await Promise.all([
    service.from('teams').select('name').eq('id', params.teamId).maybeSingle(),
    inv.boat_id
      ? service.from('boats').select('name').eq('id', inv.boat_id).maybeSingle()
      : Promise.resolve({ data: null as { name: string } | null }),
    service.from('users').select('name').eq('id', guard.userId).maybeSingle(),
  ])

  const origin = req.nextUrl.origin
  const result = await sendInviteEmail({
    to: inv.email,
    team_name: team?.name || 'the team',
    role: inv.role,
    boat_name: boat?.name || null,
    invite_url: `${origin}/join/${inv.token}`,
    inviter_name: inviter?.name || null,
  })

  await service.from('events').insert({
    user_id: guard.userId,
    action: result.ok ? 'invitation.resent' : 'invitation.resend_failed',
    details: {
      invitation_id: inv.id,
      to: inv.email,
      error: result.ok ? null : result.error,
    },
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

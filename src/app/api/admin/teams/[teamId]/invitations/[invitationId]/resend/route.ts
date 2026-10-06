// Re-send the invitation email.
//
// Since an email-targeted invite now provisions the member on creation (see the
// invitations POST route), "used up" is the NORMAL state here — the check that
// refused it would have made Resend useless. Re-provisioning is idempotent, so
// this simply makes sure the account, status and membership are in place and
// sends the same "your membership is set up" email with a fresh password link:
// a resend is precisely the case where someone could not get in.

import { NextRequest, NextResponse } from 'next/server'
import { getServiceSupabase } from '../../../../../../../../lib/supabase/server'
import { requireTeamManager } from '../../../../../../../../lib/supabase/admin-guard'
import { sendMembershipReadyEmail } from '../../../../../../../../lib/email'
import { provisionTeamMember } from '../../../../../../../../lib/provision-member'

export async function POST(
  req: NextRequest,
  { params }: { params: { teamId: string; invitationId: string } }
) {
  const guard = await requireTeamManager(params.teamId)
  if (!guard.ok) return guard.response

  const service = getServiceSupabase()
  const { data: inv } = await service
    .from('invitations')
    .select('id, email, role, boat_id, token, expires_at, revoked_at, used_count, max_uses, valid_from, valid_to, data_from, data_to')
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
  const [{ data: team }, { data: boat }, { data: inviter }] = await Promise.all([
    service.from('teams').select('name').eq('id', params.teamId).maybeSingle(),
    inv.boat_id
      ? service.from('boats').select('name').eq('id', inv.boat_id).maybeSingle()
      : Promise.resolve({ data: null as { name: string } | null }),
    service.from('users').select('name').eq('id', guard.userId).maybeSingle(),
  ])

  const origin = req.nextUrl.origin
  const siteUrl = process.env.SSA_SITE_URL || 'https://ssa.wvsailing.co.uk'

  const prov = await provisionTeamMember(service, {
    email: inv.email,
    teamId: params.teamId,
    role: inv.role,
    boatId: inv.boat_id || null,
    validFrom: inv.valid_from || null,
    validTo: inv.valid_to || null,
    dataFrom: inv.data_from || null,
    dataTo: inv.data_to || null,
    approvedBy: guard.userId,
  })
  if (!prov.ok) {
    return NextResponse.json({ error: prov.error || 'could not set up the member' }, { status: 500 })
  }

  // A resend is somebody saying "that link did not work for me", so give them
  // one that does: unspend the invitation and push its expiry out again. The
  // link itself is the same token — the mail they already have starts working
  // too, which is one fewer thing to explain on the phone.
  const DAYS = 14
  await service
    .from('invitations')
    .update({
      used_count: 0,
      expires_at: new Date(Date.now() + DAYS * 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq('id', inv.id)

  const result = await sendMembershipReadyEmail({
    to: inv.email,
    team_name: team?.name || 'the team',
    role: inv.role,
    boat_name: boat?.name || null,
    site_url: siteUrl,
    // Always offer the password link on a resend — they are asking again because
    // they could not get in.
    set_password_url: `${origin}/welcome/${inv.token as string}`,
    inviter_name: inviter?.name || null,
  })

  await service.from('events').insert({
    user_id: guard.userId,
    action: result.ok ? 'invitation.resent' : 'invitation.resend_failed',
    details: {
      invitation_id: inv.id,
      to: inv.email,
      member_user_id: prov.userId,
      account_created: prov.created,
      error: result.ok ? null : result.error,
    },
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

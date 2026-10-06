// Road 2: somebody scanned the team's QR code and wants in.
//
// They choose their own password here and then WAIT — the account is created
// `pending`, with no membership, so it can sign in to nothing until a team
// manager approves it. That is the difference from Road 1: an emailed invite
// went to one address the manager typed, which is itself the proof of who they
// are; a QR code on a boat is seen by whoever is standing there.
//
// NO SUPABASE EMAIL IS SENT. The account is created through the admin API with
// the address pre-confirmed, exactly as Road 1 does, because Supabase's own
// mailer refuses to deliver to anybody outside the project's team unless custom
// SMTP is configured — the failure that cost 29 September. Everything this road
// sends goes through Resend: one provider, one dashboard.
//
// The address is NOT verified by this road. It does not need to be: nothing is
// granted until a human who knows the crew presses Approve, and the approval
// email goes to that address, so a typo surfaces as "I never got it" rather
// than as access.

import { NextResponse, type NextRequest } from 'next/server'
import { getServiceSupabase } from '../../../../../lib/supabase/server'
import { classifyInvite } from '../../../../../lib/welcome-invite'
import { checkPassword } from '../../../../../lib/auth-pages'
import { normaliseEmail, nameFromEmail } from '../../../../../lib/provision-member'
import { recordAuthEvent } from '../../../../../lib/authEvents'
import { sendAccessRequestEmail } from '../../../../../lib/email'

interface Body { name?: string; email?: string; password?: string; confirm?: string }

export async function POST(
  req: NextRequest,
  { params }: { params: { token: string } }
) {
  const origin = req.nextUrl.origin
  const siteUrl = process.env.SSA_SITE_URL || origin
  const body = (await req.json().catch(() => null)) as Body | null
  const email = normaliseEmail(body?.email || '')
  const service = getServiceSupabase()

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
  }
  const bad = checkPassword(body?.password ?? null, body?.confirm ?? null)
  if (bad) return NextResponse.json({ error: bad }, { status: 400 })

  const { data: inv } = await service
    .from('invitations')
    .select('id, team_id, email, role, boat_id, used_count, max_uses, expires_at, revoked_at')
    .eq('token', params.token)
    .maybeSingle()

  const state = classifyInvite(inv)
  if (state !== 'valid') {
    const says: Record<string, string> = {
      missing: 'That code does not match an invitation. Ask your team manager for a new one.',
      expired: 'That code has expired. Ask your team manager for a new one.',
      revoked: 'That code was withdrawn. Ask your team manager for a new one.',
      used: 'That code has been used as many times as it was meant for. Ask your team manager for a new one.',
    }
    return NextResponse.json({ error: says[state] || says.missing }, { status: 410 })
  }
  const invite = inv as {
    id: string; team_id: string; email: string | null; role: string; boat_id: string | null
    used_count: number; max_uses: number
  }

  // An address that already has an account does not get a second one, and does
  // not get its password reset by a stranger holding the QR code.
  const { data: existing } = await service
    .from('users').select('id, status').ilike('email', email).maybeSingle()
  if (existing?.id) {
    return NextResponse.json({
      error: 'That address already has an SSA account. Sign in first, then open this link again to ask to join the team.',
      sign_in: true,
    }, { status: 409 })
  }

  const name = String(body?.name || '').trim() || nameFromEmail(email)
  const created = await service.auth.admin.createUser({
    email,
    password: body!.password as string,
    email_confirm: true,
    user_metadata: { name },
  })
  const userId = created?.data?.user?.id as string | undefined
  if (created?.error || !userId) {
    await recordAuthEvent(service, {
      action: 'join.failed',
      details: { to: email, team_id: invite.team_id, invitation_id: invite.id,
                 error: created?.error?.message || 'no user id returned' },
    })
    return NextResponse.json(
      { error: 'Could not create the account. Your team manager has been told; try again, or ask them to invite you by email.' },
      { status: 500 }
    )
  }

  // Pending, with what they asked for recorded so the manager's Approve button
  // has a role and a boat to apply. handle_new_user() has already mirrored the
  // auth row into public.users, so this is an update.
  await service.from('users').update({
    name,
    status: 'pending',
    requested_team_id: invite.team_id,
    requested_role: invite.role,
    requested_boat_id: invite.boat_id,
  }).eq('id', userId)

  // Spend one use, with the same guard the redeem path uses so a QR code
  // photographed by twenty people cannot go past its limit.
  await service.from('invitations')
    .update({ used_count: invite.used_count + 1 })
    .eq('id', invite.id)
    .lt('used_count', invite.max_uses)

  await recordAuthEvent(service, {
    action: 'join.requested',
    details: { to: email, team_id: invite.team_id, invitation_id: invite.id, member_user_id: userId },
  })

  // Tell the managers. A request nobody is told about is a person waiting for
  // ever, which is the failure this whole road exists to avoid.
  const [{ data: team }, { data: managers }] = await Promise.all([
    service.from('teams').select('name').eq('id', invite.team_id).maybeSingle(),
    service.from('memberships')
      .select('user_id, users:users(email, name)')
      .eq('team_id', invite.team_id).eq('role', 'team_manager'),
  ])
  const to = (managers || [])
    .map((m: { users?: { email?: string | null } | { email?: string | null }[] | null }) => {
      const u = Array.isArray(m.users) ? m.users[0] : m.users
      return u?.email || null
    })
    .filter((e: string | null): e is string => !!e)

  if (!to.length) {
    await recordAuthEvent(service, {
      action: 'join.notify_failed',
      details: { to: email, team_id: invite.team_id, error: 'the team has no manager with an email address' },
    })
  } else {
    const sent = await sendAccessRequestEmail({
      to,
      team_name: (team?.name as string) || 'your team',
      applicant_name: name,
      applicant_email: email,
      role: invite.role,
      approve_url: `${siteUrl}/admin/teams/${invite.team_id}`,
    })
    if (!sent.ok) {
      await recordAuthEvent(service, {
        action: 'join.notify_failed',
        details: { to: email, team_id: invite.team_id, error: sent.error },
      })
    }
  }

  return NextResponse.json({
    ok: true,
    message: 'Your request has gone to the team manager. You will get an email when it is approved.',
  })
}

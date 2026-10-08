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
//
// AN ADDRESS THAT ALREADY HAS AN ACCOUNT takes the second branch below. A user
// is allowed to be in several teams at once — (Warp, coach) and (Baraka GP,
// tl1) are two memberships on one login, which is what the schema has always
// supported — and this used to refuse them with advice that was a dead end
// ("sign in first, then open this link again" sent them round a loop). They
// now prove who they are with the password they ALREADY have and the request is
// filed against their existing account. What stays true is the thing that guard
// was really for: a stranger holding the QR code cannot reset anybody's
// password. We never write a password for an account we did not just create.

import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServerSupabase, getServiceSupabase } from '../../../../../lib/supabase/server'
import { classifyInvite } from '../../../../../lib/welcome-invite'
import { checkConsent, checkPassword } from '../../../../../lib/auth-pages'
import { normaliseEmail, nameFromEmail } from '../../../../../lib/provision-member'
import { recordAuthEvent } from '../../../../../lib/authEvents'
import { redeemInvitation } from '../../../../../lib/invitation-redeem'
import { sendAccessRequestEmail } from '../../../../../lib/email'

interface Body {
  name?: string; email?: string; password?: string; confirm?: string
  privacy_accepted?: boolean; recording_consent?: boolean
}

interface Invite {
  id: string; team_id: string; email: string | null; role: string; boat_id: string | null
  used_count: number; max_uses: number
}

// Tell the managers. A request nobody is told about is a person waiting for
// ever, which is the failure this whole road exists to avoid. Shared by both
// branches: a second-team request needs telling exactly as a new one does.
async function notifyManagers(
  service: SupabaseClient,
  args: { invite: Invite; email: string; name: string; siteUrl: string }
) {
  const { invite, email, name, siteUrl } = args
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
    return
  }
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

async function teamName(service: SupabaseClient, teamId: string) {
  const { data } = await service.from('teams').select('name').eq('id', teamId).maybeSingle()
  return (data?.name as string) || 'this team'
}

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
    // Checked here, not only in the form: a tick box is advice to a browser,
    // and this is the last point before an account exists.
    || checkConsent(body?.privacy_accepted, body?.recording_consent)
  if (bad) return NextResponse.json({ error: bad }, { status: 400 })
  const password = body!.password as string

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
  const invite = inv as Invite

  const { data: existing } = await service
    .from('users').select('id, name, status').ilike('email', email).maybeSingle()

  if (existing?.id) {
    return joinOnExistingAccount({
      service, invite, email, password, siteUrl, token: params.token,
      existing: existing as { id: string; name: string | null; status: string },
      typedName: String(body?.name || '').trim(),
    })
  }

  const name = String(body?.name || '').trim() || nameFromEmail(email)
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // handle_new_user() (migration 0078) reads these off the metadata and
    // stamps the timestamps server-side. Anything missing or malformed reads as
    // NO — the COALESCE defaults are deliberately the refusing ones — so the
    // check above is what makes these true, not the other way round.
    user_metadata: { name, privacy_accepted: true, recording_consent: true },
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

  await notifyManagers(service, { invite, email, name, siteUrl })

  return NextResponse.json({
    ok: true,
    message: 'Your request has gone to the team manager. You will get an email when it is approved.',
  })
}

/**
 * The address already has an SSA account, and this is a request to join ANOTHER
 * team with it.
 *
 * Three things are refused before the password is even looked at: being in the
 * team already, a disabled account, and — further down — a password that is not
 * theirs. Nothing here writes a password or a membership: the most it does is
 * file the same `requested_*` hints a brand-new account gets, so one manager
 * pressing Approve is still what grants access.
 */
async function joinOnExistingAccount(args: {
  service: SupabaseClient
  invite: Invite
  existing: { id: string; name: string | null; status: string }
  email: string
  password: string
  siteUrl: string
  token: string
  typedName: string
}) {
  const { service, invite, existing, email, password, siteUrl, token } = args
  const name = existing.name || args.typedName || nameFromEmail(email)

  // Already aboard. Said plainly, because "your request has gone to the
  // manager" would be a lie and they would wait for an email that never comes.
  const { data: already } = await service
    .from('memberships').select('id')
    .eq('user_id', existing.id).eq('team_id', invite.team_id).limit(1)
  if (already && already.length) {
    return NextResponse.json({
      error: `You are already in ${await teamName(service, invite.team_id)} with this address. `
        + 'Sign in with your usual password — there is nothing to join.',
      sign_in: true,
    }, { status: 409 })
  }

  if (existing.status === 'disabled') {
    await recordAuthEvent(service, {
      action: 'join.refused',
      details: { to: email, team_id: invite.team_id, invitation_id: invite.id,
                 member_user_id: existing.id, error: 'the account is disabled' },
    })
    return NextResponse.json({
      error: 'That address has an SSA account that has been switched off. A team manager or '
        + 'administrator has to switch it back on before it can join anything — ask yours.',
    }, { status: 403 })
  }

  // Prove it is them, with the password they already have. getServerSupabase()
  // and not a bare client on purpose: a correct password means they ARE signed
  // in from here on, so the page they land on is their own and the second team
  // appears the moment it is approved, with nothing further to type.
  const sb = getServerSupabase()
  let signInErr = (await sb.auth.signInWithPassword({ email, password })).error
  if (signInErr && /not confirmed/i.test(signInErr.message)) {
    // An account whose address was never confirmed can never sign in, and
    // cannot be confirmed by email either — Supabase's mailer will not deliver
    // to it. Confirming grants nothing on its own; the password is still what
    // is being checked, and we check it again immediately.
    await service.auth.admin.updateUserById(existing.id, { email_confirm: true })
    signInErr = (await sb.auth.signInWithPassword({ email, password })).error
  }
  if (signInErr) {
    await recordAuthEvent(service, {
      action: 'join.password_mismatch',
      details: { to: email, team_id: invite.team_id, invitation_id: invite.id,
                 member_user_id: existing.id, error: signInErr.message },
    })
    return NextResponse.json({
      error: 'That address already has an SSA account, and that is not its password. Put in the '
        + 'password you use for SSA to join this team with the same account — or use '
        + '"Forgot password?" on the sign-in page if it has gone.',
      sign_in: true,
    }, { status: 401 })
  }

  // One implementation of redeeming, shared with the signed-in button on
  // /join/<token>: it spends the use under the same `lt` guard, auto-approves
  // only a targeted invite to this very address, and otherwise files the hints.
  const redeemed = await redeemInvitation({ token, user: { id: existing.id, email } })
  if (!redeemed.ok) {
    const says: Record<string, string> = {
      expired: 'That code has expired. Ask your team manager for a new one.',
      revoked: 'That code was withdrawn. Ask your team manager for a new one.',
      exhausted: 'That code has been used as many times as it was meant for. Ask your team manager for a new one.',
      'not found': 'That code does not match an invitation. Ask your team manager for a new one.',
    }
    await recordAuthEvent(service, {
      action: 'join.failed',
      details: { to: email, team_id: invite.team_id, invitation_id: invite.id,
                 member_user_id: existing.id, error: redeemed.error },
    })
    return NextResponse.json(
      { error: says[redeemed.error] || `Could not use that code (${redeemed.error}).` },
      { status: redeemed.status ?? 500 }
    )
  }

  const team = await teamName(service, invite.team_id)

  if (redeemed.auto_approved) {
    await recordAuthEvent(service, {
      action: 'join.auto_approved',
      details: { to: email, team_id: invite.team_id, invitation_id: invite.id,
                 member_user_id: existing.id, existing_account: true },
    })
    return NextResponse.json({
      ok: true,
      joined: true,
      existing_account: true,
      message: `You are in ${team}. It has been added to the account you already had — `
        + 'switch between teams from the menu behind your name.',
    })
  }

  await recordAuthEvent(service, {
    action: 'join.requested',
    details: { to: email, team_id: invite.team_id, invitation_id: invite.id,
               member_user_id: existing.id, existing_account: true },
  })
  await notifyManagers(service, { invite, email, name, siteUrl })

  return NextResponse.json({
    ok: true,
    existing_account: true,
    message: `Your request to join ${team} has gone to its team manager, against the SSA account `
      + 'you already have. You will get an email when it is approved, and the new team will then '
      + 'appear in the menu behind your name — your password does not change.',
  })
}

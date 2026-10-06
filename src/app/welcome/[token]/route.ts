// Road 1: the manager invited you, so choose a password and you are in.
//
// ONE SCREEN, ONE SUBMIT, and no email to confirm — the invite went to that
// address, so reading it proves what a confirmation would prove, twice over.
// By the time this link is clicked `provisionTeamMember` has already created
// the account (address pre-confirmed), made it active and inserted the
// membership. All that is missing is a password.
//
// WHY THIS DOES NOT USE SUPABASE'S RECOVERY LINK ANY MORE.
//
// The previous version minted a Supabase `recovery` token through
// admin.generateLink and verified it with verifyOtp. That was already the
// second attempt — the first used the PKCE `?code=`, which CANNOT work for
// somebody who has never had a session in any browser, because there is no
// code_verifier to exchange it against. Both failed in the field:
//
//   · 1 October, gwenael.leguen@gmail.com — "the recovery link has expired or
//     already been used", instantly, on a link under a minute old. It was the
//     PKCE exchange failing and being discarded.
//   · The same day, with that fixed: "Email link is invalid or has expired" on
//     a link under two minutes old. auth.users.last_sign_in_at was stamped by
//     nobody — Apple's link preview had fetched it, and verifyOtp is
//     single-use, so the preview spent it.
//
// Serving a form on GET fixed the preview problem. What it could not fix is
// the clock: a Supabase OTP expires in an hour by default, and that is a
// project setting, not something this code can choose. An invite that lands
// while somebody is sailing is dead before they read it.
//
// So Road 1 now carries OUR OWN token: the `invitations` row that already
// exists for this person, with its own expiry (days, not an hour), its own
// single use, and its own revocation. Nothing here touches Supabase's mailer,
// its OTPs, or PKCE. The password is set with the service key and the person is
// signed in immediately with the password they just chose — which is the one
// sign-in that cannot fail, because we have just been told what it is.
//
// A GET spends nothing, so a mail scanner, a link preview and an over-eager tap
// all leave the token intact.

import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getServerSupabase } from '../../../lib/supabase/server'
import {
  PAGE_HEADERS, checkPassword, messagePage, passwordFormPage,
} from '../../../lib/auth-pages'
import { classifyInvite, type InviteState } from '../../../lib/welcome-invite'
import { recordAuthEvent } from '../../../lib/authEvents'

const html = (body: string, status = 200) =>
  new NextResponse(body, { status, headers: PAGE_HEADERS })

function service() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

interface Invite {
  id: string
  email: string | null
  team_id: string
  used_count: number
  max_uses: number
  expires_at: string
  revoked_at: string | null
}

/** What to say when the link cannot be used — always with a way forward. */
function deadEnd(state: InviteState, origin: string): string {
  const body = state === 'used'
    ? 'That link has already been used to set a password. If that was you, sign in; if it was not, use "Forgot password?" to take the account back.'
    : state === 'expired'
      ? 'That invitation has expired. Your membership is still set up — use "Forgot password?" on the sign-in page to choose a password.'
      : state === 'revoked'
        ? 'That invitation was withdrawn. Ask your team manager to send a new one.'
        : 'That link does not match an invitation. Check you copied the whole of it, or ask your team manager to send a new one.'
  return messagePage({
    heading: 'This link cannot be used',
    body,
    linkHref: `${origin}/login`,
    linkText: 'Go to the sign-in page',
  })
}

async function load(token: string): Promise<{ invite: Invite | null; state: InviteState }> {
  const sb = service()
  if (!sb) return { invite: null, state: 'missing' }
  const { data } = await sb
    .from('invitations')
    .select('id, email, team_id, used_count, max_uses, expires_at, revoked_at')
    .eq('token', token)
    .maybeSingle<Invite>()
  return { invite: data ?? null, state: classifyInvite(data) }
}

/** The team's name, for the one line that says what they are joining. */
async function teamName(teamId: string): Promise<string | null> {
  const sb = service()
  if (!sb) return null
  const { data } = await sb.from('teams').select('name').eq('id', teamId).maybeSingle()
  return (data?.name as string) || null
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  const origin = new URL(_req.url).origin
  const { invite, state } = await load(params.token)
  if (!invite || state !== 'valid') {
    // Somebody is standing in front of a link that does not work. The manager
    // who sent it cannot see that unless it is written down here.
    const sb = service()
    if (sb) {
      await recordAuthEvent(sb, {
        action: 'welcome.link_dead',
        details: { to: invite?.email ?? null, team_id: invite?.team_id ?? null, state,
                   invitation_id: invite?.id ?? null },
      })
    }
    return html(deadEnd(state, origin), state === 'missing' ? 404 : 410)
  }

  const team = await teamName(invite.team_id)
  return html(passwordFormPage({
    hidden: { token: params.token },
    email: invite.email,
    heading: 'Welcome to SSA',
    intro: team ? `Choose a password and you are in — ${team} is already set up for you.` : null,
  }))
}

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } }
) {
  const origin = new URL(request.url).origin
  const form = await request.formData().catch(() => null)
  const str = (k: string) => {
    const v = form?.get(k)
    return typeof v === 'string' && v ? v : null
  }

  const { invite, state } = await load(params.token)
  if (!invite || state !== 'valid') return html(deadEnd(state, origin), state === 'missing' ? 404 : 410)

  // The password is checked BEFORE the token is spent. A mistyped confirmation
  // must cost a retype, not the invitation.
  const bad = checkPassword(str('password'), str('confirm'))
  if (bad) {
    return html(passwordFormPage({
      hidden: { token: params.token },
      email: invite.email, heading: 'Welcome to SSA', error: bad,
    }))
  }
  const password = str('password') as string

  const sb = service()
  if (!sb || !invite.email) {
    return html(messagePage({
      heading: 'Something is missing',
      body: 'This invitation has no address on it, so there is no account to set a password for. Ask your team manager to send a new one.',
      linkHref: `${origin}/login`, linkText: 'Go to the sign-in page',
    }), 500)
  }

  // The account was created when the invite was sent, so it is found by address.
  const { data: person } = await sb
    .from('users').select('id, status').ilike('email', invite.email).maybeSingle()
  if (!person?.id) {
    return html(messagePage({
      heading: 'No account for this invitation',
      body: 'The invitation is valid but the account behind it is gone. Ask your team manager to invite you again.',
      linkHref: `${origin}/login`, linkText: 'Go to the sign-in page',
    }), 410)
  }
  if (person.status === 'disabled') {
    return html(messagePage({
      heading: 'That account is disabled',
      body: 'A global administrator disabled this account. It has to be reactivated before a password can be set.',
      linkHref: `${origin}/login`, linkText: 'Go to the sign-in page',
    }), 403)
  }

  const { error: pwErr } = await sb.auth.admin.updateUserById(person.id as string, { password })
  if (pwErr) {
    return html(passwordFormPage({
      hidden: { token: params.token },
      email: invite.email, heading: 'Welcome to SSA', error: pwErr.message,
    }))
  }

  // Spend the invitation only once the password is actually set — and with the
  // same `lt` guard the open-link redeem uses, so two submits cannot both win.
  await sb.from('invitations')
    .update({ used_count: invite.used_count + 1 })
    .eq('id', invite.id)
    .lt('used_count', invite.max_uses)

  // Signed in straight away, with the password they chose a moment ago. No
  // magic link, no OTP, nothing that can be consumed by a scanner: this is the
  // one sign-in that cannot fail, because we have just been told the secret.
  const supabase = getServerSupabase()
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email: invite.email, password,
  })
  if (signInErr) {
    await recordAuthEvent(sb, {
      action: 'welcome.signin_failed',
      details: { to: invite.email, team_id: invite.team_id, invitation_id: invite.id,
                 member_user_id: person.id as string, error: signInErr.message },
    })
    // The password IS set — do not leave them thinking it failed.
    return html(messagePage({
      heading: 'Password set',
      body: `Your password is saved, but signing you in here did not work (${signInErr.message}). Go to the sign-in page and use it.`,
      linkHref: `${origin}/login`, linkText: 'Go to the sign-in page',
    }))
  }

  await recordAuthEvent(sb, {
    action: 'welcome.password_set',
    details: { to: invite.email, team_id: invite.team_id, invitation_id: invite.id,
               member_user_id: person.id as string },
  })

  // 303, not 307: a 307 out of a POST makes the browser re-POST to the
  // destination, which lands on a page that only answers GET.
  return NextResponse.redirect(`${origin}/`, 303)
}

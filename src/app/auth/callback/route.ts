// OAuth / email-link callback.
//
// TWO WAYS IN, and they are not interchangeable:
//
//   ?token_hash=…&type=recovery   an emailed link. Verified here with
//                                 verifyOtp, which needs nothing from the
//                                 browser — the proof is in the link.
//   ?code=…                       a flow this browser STARTED (sign-in with a
//                                 provider, or "Forgot password?" pressed on
//                                 this device). PKCE, so exchanging it needs
//                                 the code_verifier cookie that was written
//                                 when the flow began.
//
// Why both. The first-login link is minted server-side by
// provision-member.firstLoginLink → admin.generateLink, for somebody who has
// never had a session anywhere. There is no code_verifier in their browser and
// there never was, so exchangeCodeForSession CANNOT succeed — it fails every
// time, for every invited person. Worse, the failure used to be discarded:
//
//     const { data } = await supabase.auth.exchangeCodeForSession(code)
//
// …no error check, then redirect to /auth/reset-password regardless, where a
// page with no session says "The recovery link has expired or already been
// used." So an invitee clicked Set password and was told, instantly, that a
// link minted seconds earlier had expired. It had not. It was never exchangeable
// in the first place. (gwenael.leguen@gmail.com, 1 October 2026.)
//
// So the failure is now CARRIED, as ?authError=…, and the landing page says
// which of the two happened instead of guessing at expiry.
//
// After either, if an invite token rode along, redeem it INLINE — calling the
// shared helper rather than fetching our own /api/invitations/[token]. An
// internal fetch cannot see the cookies we just set (Next.js gotcha), which is
// what used to stop auto-approve working.

import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { getServerSupabase } from '../../../lib/supabase/server'
import { redeemInvitation } from '../../../lib/invitation-redeem'

const OTP_TYPES: EmailOtpType[] = ['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email']

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const rawType = searchParams.get('type')
  const inviteToken = searchParams.get('invite')
  const next = searchParams.get('next') ?? '/'

  let user: { id: string; email?: string | null } | null = null
  let authError: string | null = null

  const supabase = getServerSupabase()

  if (tokenHash && rawType && (OTP_TYPES as string[]).includes(rawType)) {
    // The emailed path. Nothing is needed from this browser, so it works in
    // whichever one the person happens to open their mail in — which for an
    // invitee is the whole point.
    const { data, error } = await supabase.auth.verifyOtp({
      type: rawType as EmailOtpType,
      token_hash: tokenHash,
    })
    if (error) authError = error.message
    else if (data?.user) user = { id: data.user.id, email: data.user.email ?? null }
  } else if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) authError = error.message
    else if (data?.user) user = { id: data.user.id, email: data.user.email ?? null }
  } else {
    authError = 'the link carried no sign-in token'
  }

  if (inviteToken && user) {
    try {
      await redeemInvitation({ token: inviteToken, user })
    } catch {
      // Non-fatal — the user can go to /join/<token> later.
    }
  }

  const to = new URL(`${origin}${next}`)
  if (!user && authError) to.searchParams.set('authError', authError)
  return NextResponse.redirect(to.toString())
}

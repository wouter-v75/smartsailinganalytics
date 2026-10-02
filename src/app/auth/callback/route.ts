// OAuth / email-link callback.
//
// TWO WAYS IN, and they are not interchangeable:
//
//   ?token_hash=…&type=recovery   an emailed or messaged link. Verified with
//                                 verifyOtp, which needs nothing from the
//                                 browser — the proof is in the link. Because
//                                 of that it is also usable by anything that
//                                 merely FETCHES the link, which is the whole
//                                 of the problem below.
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
// ── AND THE TOKEN IS NOT SPENT ON A GET ─────────────────────────────────────
//
// The same day, with the PKCE half fixed, the next invitee's link still died —
// "Email link is invalid or has expired", on a link under two minutes old. It
// had not expired either. It had been USED: auth.users.last_sign_in_at was
// stamped 1 min 49 s after the link was minted, by nobody. The link had been
// sent to an iPhone, and Apple's preview service fetched it to build the little
// card under the message. verifyOtp is single-use, so the preview spent it and
// the human got the leftovers.
//
// Every messaging and mail product does this — iMessage, WhatsApp, Slack,
// Gmail — and corporate mail scanners (Outlook Safe Links, Proofpoint) go
// further and follow every link in every message on purpose. A one-click link
// that signs you in on GET cannot survive any of them. It is not a matter of
// sending it the right way.
//
// So GET no longer verifies anything for the emailed path. It serves a FORM,
// and the verification happens on the POST. Bots fetch; they do not fill in
// password fields.
//
// And since a form has to be submitted anyway, it is the set-password form
// rather than a bare "continue" button: address prefilled and read-only,
// password, confirm, done. One screen, one submit, and they land signed in —
// instead of a tap, a redirect, and a second page asking for the same thing.
// The invite was sent to that address, so proving they can read it proves what
// the old confirm-then-reset dance was proving twice.
//
// The ?code= path keeps verifying on GET. It is not exposed to this: a code
// arrives as a redirect from the provider, in the browser that began the flow,
// and is never a link anybody shares or a scanner sees.
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

const isOtpType = (t: string | null): t is EmailOtpType =>
  !!t && (OTP_TYPES as string[]).includes(t)

/** `<` and `&` only — these go into attribute values, which are quoted. */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Passwords are 8+ here, as on /signup and /auth/reset-password.
 *  NOT exported: a Next route file may only export route handlers, and an extra
 *  export fails the generated-types check rather than anything in this file. */
const MIN_PASSWORD = 8

/** Types where the person is about to choose a password. */
const SETS_PASSWORD = new Set<string>(['recovery', 'invite', 'signup'])

/**
 * The page that stands between a link preview and somebody's account.
 *
 * Deliberately plain and dependency-free: it is served by a route handler, not
 * rendered by the app, so it cannot reach the design system — and it works with
 * JavaScript off, because it is a plain form POST and that is the point.
 *
 * `email` is DISPLAY ONLY. It rides in the link so the field can be filled in
 * for them, and it is `readonly` and not submitted; the account that actually
 * gets the new password is whichever one the TOKEN resolves to. Trusting the
 * query string here would let a changed link point a valid token at a different
 * address on screen.
 */
function passwordPage(args: {
  tokenHash: string; type: string; next: string; invite: string | null
  email: string | null; error: string | null
}): string {
  const hidden = [
    `<input type="hidden" name="token_hash" value="${esc(args.tokenHash)}">`,
    `<input type="hidden" name="type" value="${esc(args.type)}">`,
    `<input type="hidden" name="next" value="${esc(args.next)}">`,
    args.invite ? `<input type="hidden" name="invite" value="${esc(args.invite)}">` : '',
    args.email ? `<input type="hidden" name="shown_email" value="${esc(args.email)}">` : '',
  ].join('')

  const setting = SETS_PASSWORD.has(args.type)
  const title = setting ? 'Choose a password' : 'Continue'
  const emailRow = args.email
    ? `<label for="email">Email</label>
       <input id="email" type="email" value="${esc(args.email)}" readonly autocomplete="username">`
    : ''
  const fields = setting
    ? `${emailRow}
       <label for="pw">Password</label>
       <input id="pw" name="password" type="password" required minlength="${MIN_PASSWORD}"
              autocomplete="new-password" autofocus>
       <label for="pw2">Confirm password</label>
       <input id="pw2" name="confirm" type="password" required minlength="${MIN_PASSWORD}"
              autocomplete="new-password">
       <p class="hint">At least ${MIN_PASSWORD} characters. You will be signed in straight away.</p>`
    : '<p class="hint">This link signs you in, and it only works once.</p>'

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title} · Smart Sailing Analytics</title>
<style>
  :root { color-scheme: dark }
  /* Without this the form's own padding adds to its 100% width and eats the
     body's gutter, so the card runs edge-to-edge on a phone — which is where
     an invited person opens the link. */
  *, *::before, *::after { box-sizing: border-box }
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
         background:#0A1929; color:#E2E8F0;
         font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; padding:24px }
  form { width:100%; max-width:380px; background:#0F2A45; border:1px solid #1E3A5A;
         border-radius:14px; padding:26px 24px }
  h1 { margin:0 0 18px; font-size:19px; font-weight:800; color:#38BDF8 }
  label { display:block; margin:0 0 5px; font-size:11px; font-weight:700;
          letter-spacing:.04em; text-transform:uppercase; color:#94A3B8 }
  input { width:100%; min-height:46px; margin:0 0 15px;
          padding:0 12px; border:1px solid #1E3A5A; border-radius:9px;
          background:#0A1929; color:#E2E8F0; font-size:16px }
  input[readonly] { color:#94A3B8; background:#0C2136 }
  .hint { margin:0 0 18px; font-size:12px; color:#64748B }
  .err { margin:0 0 16px; padding:9px 11px; border:1px solid #7F1D1D; border-radius:8px;
         background:rgba(127,29,29,.28); color:#FCA5A5; font-size:12.5px }
  button { width:100%; min-height:48px; border:0; border-radius:10px; cursor:pointer;
           background:#38BDF8; color:#06203A; font-size:15px; font-weight:700 }
  button:hover { background:#7DD3FC }
</style>
</head><body>
  <form method="POST">
    ${hidden}
    <h1>${title}</h1>
    ${args.error ? `<p class="err">${esc(args.error)}</p>` : ''}
    ${fields}
    <button type="submit">${setting ? 'Set password and sign in' : 'Continue'}</button>
  </form>
</body></html>`
}

/** Verify, redeem any invite that rode along, and send them on. */
async function finish(args: {
  origin: string
  tokenHash: string | null
  type: string | null
  code: string | null
  invite: string | null
  next: string
  /** Shared with the caller, so a password can be set on the session this
   *  creates. A second client would not have the cookies. */
  supabase?: ReturnType<typeof getServerSupabase>
  /**
   * 303 when this redirect ends a POST, 307 otherwise.
   *
   * NextResponse.redirect defaults to 307, which PRESERVES THE METHOD. Out of a
   * POST handler that means the browser re-POSTs to the destination — so
   * submitting the password form sent the browser to POST "/", the middleware
   * bounced that to POST /login, and the person got a bare 400/405 from a page
   * that only answers GET. They had set their password successfully and were
   * looking at an error. 303 is the one redirect that says "now go and GET
   * this instead", which is exactly what a form submission needs.
   */
  status?: 303 | 307
}): Promise<{ response: NextResponse; redirectedWithError: boolean }> {
  const supabase = args.supabase ?? getServerSupabase()
  let user: { id: string; email?: string | null } | null = null
  let authError: string | null = null

  if (args.tokenHash && isOtpType(args.type)) {
    const { data, error } = await supabase.auth.verifyOtp({
      type: args.type,
      token_hash: args.tokenHash,
    })
    if (error) authError = error.message
    else if (data?.user) user = { id: data.user.id, email: data.user.email ?? null }
  } else if (args.code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(args.code)
    if (error) authError = error.message
    else if (data?.user) user = { id: data.user.id, email: data.user.email ?? null }
  } else {
    authError = 'the link carried no sign-in token'
  }

  if (args.invite && user) {
    try {
      await redeemInvitation({ token: args.invite, user })
    } catch {
      // Non-fatal — the user can go to /join/<token> later.
    }
  }

  const to = new URL(`${args.origin}${args.next}`)
  if (!user && authError) to.searchParams.set('authError', authError)
  return {
    response: NextResponse.redirect(to.toString(), args.status ?? 307),
    redirectedWithError: !user,
  }
}

const htmlResponse = (body: string) =>
  new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Never let a shared cache hold a page carrying somebody's token.
      'Cache-Control': 'no-store, max-age=0',
      'Referrer-Policy': 'no-referrer',
    },
  })

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const tokenHash = searchParams.get('token_hash')
  const rawType = searchParams.get('type')
  const next = searchParams.get('next') ?? '/'
  const invite = searchParams.get('invite')

  // The emailed path: show the form, spend nothing. A preview fetch, a mail
  // scanner and an over-eager tap all land here and leave the token intact.
  if (tokenHash && isOtpType(rawType)) {
    return htmlResponse(passwordPage({
      tokenHash, type: rawType, next, invite,
      email: searchParams.get('email'), error: null,
    }))
  }

  // PKCE, or nothing usable at all — unchanged.
  return (await finish({
    origin, tokenHash: null, type: null,
    code: searchParams.get('code'), invite, next,
  })).response
}

/** The submit. This is where the emailed token is spent and the password set. */
export async function POST(request: NextRequest) {
  const { origin } = new URL(request.url)
  const form = await request.formData().catch(() => null)
  const str = (k: string) => {
    const v = form?.get(k)
    return typeof v === 'string' && v ? v : null
  }
  const tokenHash = str('token_hash')
  const type = str('type')
  const next = str('next') ?? '/'
  const invite = str('invite')
  const password = str('password')
  const confirm = str('confirm')
  const shownEmail = str('shown_email')

  const wantsPassword = !!tokenHash && !!type && SETS_PASSWORD.has(type)

  // Check the password BEFORE spending the token. A mistyped confirmation must
  // cost a re-type, not the link — which is exactly how somebody ends up locked
  // out with no way back and no email arriving to give them one.
  if (wantsPassword) {
    const bad = !password || password.length < MIN_PASSWORD
      ? `Password must be at least ${MIN_PASSWORD} characters.`
      : password !== confirm
        ? 'The two passwords do not match.'
        : null
    if (bad) {
      return htmlResponse(passwordPage({
        tokenHash: tokenHash!, type: type!, next, invite, email: shownEmail, error: bad,
      }))
    }
  }

  const supabase = getServerSupabase()
  const done = await finish({ origin, tokenHash, type, code: null, invite, next, supabase, status: 303 })

  // Only now, with a session on this response, can the password be set. If the
  // token turned out to be spent or expired, `finish` has already redirected
  // with the reason and there is no session to set it on.
  if (wantsPassword && !done.redirectedWithError) {
    const { error } = await supabase.auth.updateUser({ password: password! })
    if (error) {
      return htmlResponse(passwordPage({
        tokenHash: tokenHash!, type: type!, next, invite, email: shownEmail,
        error: error.message,
      }))
    }
  }
  return done.response
}

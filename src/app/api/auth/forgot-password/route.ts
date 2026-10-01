// "Forgot password?" — sent by US, through Resend.
//
// WHY THIS ROUTE EXISTS. The login page used to call
// supabase.auth.resetPasswordForEmail, which sends over Supabase's BUILT-IN
// SMTP. That is rate-limited to a handful of messages an hour and is documented
// as a convenience for development, not a mail service. Two people lost a day to
// it inside three days — a signup confirmation that never arrived on 29
// September, and a reset that never arrived on 1 October — and from the outside
// both look identical to "the user mistyped their address", because nothing
// fails: the call returns ok and no mail is ever delivered.
//
// Everything else this app sends already goes through Resend. So the reset does
// too: one provider, one dashboard, one place to look when something does not
// land. Supabase's mailer is now out of every path a member can hit.
//
// The link is the same one an invite carries — /auth/callback with a
// hashed_token — so it lands on the page that asks for a password and signs them
// in, and it survives being previewed by whatever the person reads mail in.
//
// SAYS NOTHING ABOUT WHO EXISTS. Every outcome returns the same 200 and the same
// words. An endpoint that answers faster, or differently, for a known address is
// a way to enumerate a team's membership, and this one is unauthenticated by
// necessity.

import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { firstLoginLink, normaliseEmail } from '../../../../lib/provision-member'
import { sendPasswordResetEmail } from '../../../../lib/email'

/** Per address, not per IP: the point is to stop one mailbox being flooded. */
const MIN_GAP_MS = 60_000
const recent = new Map<string, number>()

/** Keeps the map from growing without bound on a long-lived server. */
function sweep(now: number) {
  if (recent.size < 500) return
  for (const [k, t] of Array.from(recent)) if (now - t > MIN_GAP_MS) recent.delete(k)
}

export async function POST(request: NextRequest) {
  const { origin } = new URL(request.url)
  const body = await request.json().catch(() => null)
  const email = normaliseEmail((body as { email?: string } | null)?.email || '')

  // The same answer whatever happens below, including for a blank or malformed
  // address. Built once so no branch can accidentally differ.
  const ok = () =>
    NextResponse.json({
      ok: true,
      message: 'If that address has an account, a link to choose a new password is on its way.',
    })

  if (!email || !email.includes('@')) return ok()

  const now = Date.now()
  sweep(now)
  const last = recent.get(email)
  if (last && now - last < MIN_GAP_MS) return ok()
  recent.set(email, now)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('[forgot-password] service credentials missing')
    return ok()
  }
  const service = createClient(url, key, { auth: { persistSession: false } })

  // generateLink MINTS without sending — which is the whole point. It fails for
  // an address with no account, and that failure is swallowed deliberately.
  const link = await firstLoginLink(service, email, origin)
  if (!link) return ok()

  const sent = await sendPasswordResetEmail({ to: email, reset_url: link, site_url: origin })
  if (!sent.ok) {
    // Loud in the log, silent to the caller. A reset that vanishes is exactly
    // the failure this route was written to end, so it must not vanish quietly
    // on our side either.
    console.error(`[forgot-password] Resend refused for ${email}: ${sent.error}`)
  }
  return ok()
}

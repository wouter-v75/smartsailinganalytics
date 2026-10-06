// Resend wrapper. Server-side only — uses RESEND_API_KEY.
//
// We don't pull in the official `resend` npm package because it's a few
// hundred kB; a single fetch() call to their HTTP API does what we need.
// Returns { ok: true, id } on success, { ok: false, error } on failure.

interface SendArgs {
  to: string | string[]
  subject: string
  html: string
  text?: string
}

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: string; notConfigured?: true }

/**
 * `notConfigured` is kept apart from every other failure on purpose.
 *
 * A refusal from Resend is about ONE message: an address bounced, a domain is
 * not verified, a rate limit was hit. A missing key is about EVERY message —
 * nothing will leave this environment until somebody sets it, and telling the
 * manager to "let them know another way" would be advice for the wrong problem
 * repeated once per person. The callers say so differently because it is a
 * different thing.
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
}: SendArgs): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM
  if (!apiKey || !from) {
    return {
      ok: false,
      notConfigured: true,
      error: 'no email can be sent from this environment: RESEND_API_KEY / RESEND_FROM are not set',
    }
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text: text ?? html.replace(/<[^>]+>/g, ''),
      }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        error: j?.message || `resend ${res.status}`,
      }
    }
    return { ok: true, id: j.id || '' }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) }
  }
}

// ─── Specific email templates ─────────────────────────────────────────────

interface InviteEmailArgs {
  to: string
  team_name: string
  role: string
  boat_name?: string | null
  invite_url: string
  inviter_name?: string | null
}

export async function sendInviteEmail(args: InviteEmailArgs) {
  const subject = `${args.inviter_name || 'SSA'} invited you to join ${args.team_name}`
  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#1e293b">
      <h2 style="color:#0f172a;margin:0 0 16px">You've been invited to ${escape(args.team_name)} on SSA</h2>
      <p style="line-height:1.5">
        ${args.inviter_name ? `<strong>${escape(args.inviter_name)}</strong> has` : 'A team manager has'}
        invited you to join <strong>${escape(args.team_name)}</strong>
        as <strong>${escape(args.role)}</strong>${
          args.boat_name ? ` on <strong>${escape(args.boat_name)}</strong>` : ''
        }.
      </p>
      <p style="margin:24px 0">
        <a href="${args.invite_url}"
           style="display:inline-block;background:#2563eb;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">
          Accept invite &rarr;
        </a>
      </p>
      <p style="font-size:13px;color:#64748b;line-height:1.5">
        Or copy this link into your browser:<br/>
        <a href="${args.invite_url}" style="color:#2563eb;word-break:break-all">${args.invite_url}</a>
      </p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
      <p style="font-size:12px;color:#94a3b8">
        Shared Sailing Analytics · You can ignore this email if it wasn't expected.
      </p>
    </div>
  `
  return sendEmail({ to: args.to, subject, html })
}

interface MembershipReadyArgs {
  to: string
  team_name: string
  role: string
  boat_name?: string | null
  site_url: string
  /** Only for an account we just created: a one-click "choose a password" link. */
  set_password_url?: string | null
  inviter_name?: string | null
}

// Sent when a manager invites by email — Road 1. By the time this lands, the
// account exists, the address is confirmed and the membership is in place, so
// it says "you are set up", not "accept this invite".
//
// `set_password_url` is /welcome/<token>: OUR invitation token, not a Supabase
// recovery OTP. It lives as long as the invitation does rather than an hour, it
// cannot be spent by a link preview (the page is a form; only the POST counts),
// and the person is signed in on submit with the password they just chose.
// Somebody who already has an account gets no button at all — they have a
// password, and the mail says to use it.
export async function sendMembershipReadyEmail(args: MembershipReadyArgs) {
  const where = args.boat_name ? ` on <strong>${escape(args.boat_name)}</strong>` : ''
  const subject = `Your SSA membership for ${args.team_name} is set up`
  const cta = args.set_password_url
    ? `<p style="margin:24px 0">
         <a href="${args.set_password_url}"
            style="display:inline-block;background:#2563eb;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">
           Set your password &rarr;
         </a>
       </p>
       <p style="font-size:13px;color:#64748b;line-height:1.5">
         One screen: choose a password, confirm it, and you are in. Nothing to
         confirm afterwards and nobody to wait for. The link is yours alone and
         works once &mdash; if it has already been used, or you leave it a
         fortnight, &ldquo;Forgot password?&rdquo; on the sign-in page does the
         same job, because your membership is already set up either way.
       </p>`
    : `<p style="margin:24px 0">
         <a href="${args.site_url}"
            style="display:inline-block;background:#2563eb;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">
           Open SSA &rarr;
         </a>
       </p>
       <p style="font-size:13px;color:#64748b;line-height:1.5">
         Log in with the password you already use for SSA.
       </p>`
  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#1e293b">
      <h2 style="color:#0f172a;margin:0 0 16px">Your membership for ${escape(args.team_name)} is set up</h2>
      <p style="line-height:1.5">
        ${args.inviter_name ? `<strong>${escape(args.inviter_name)}</strong> has added you` : 'You have been added'}
        to <strong>${escape(args.team_name)}</strong> as <strong>${escape(args.role)}</strong>${where}.
        Nothing to accept and nothing to confirm — go to
        <a href="${args.site_url}" style="color:#2563eb">${escape(args.site_url.replace(/^https?:\/\//, ''))}</a>
        and log in.
      </p>
      ${cta}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
      <p style="font-size:12px;color:#94a3b8">
        Shared Sailing Analytics &middot; If you were not expecting this, reply to this email and we will remove the account.
      </p>
    </div>
  `
  return sendEmail({ to: args.to, subject, html })
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface PasswordResetArgs {
  to: string
  /** The /auth/callback link, already minted. */
  reset_url: string
  site_url: string
}

/**
 * Password reset — sent by US, through Resend, not by Supabase.
 *
 * Supabase's own resetPasswordForEmail goes out over its built-in SMTP, which is
 * rate-limited to a handful of messages an hour and documented as unsuitable for
 * production. Two people lost a day to it: a confirmation that never arrived on
 * 29 September and a reset that never arrived on 1 October. Everything else this
 * app sends already goes through Resend, so the reset does too — one provider,
 * one place to look when something does not land.
 */
export async function sendPasswordResetEmail(args: PasswordResetArgs) {
  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#1e293b">
      <h2 style="color:#0f172a;margin:0 0 16px">Choose a new password</h2>
      <p style="line-height:1.5">
        Somebody asked to reset the password for this address on SSA. Press the button
        to choose a new one — you will be signed in straight afterwards.
      </p>
      <p style="margin:24px 0">
        <a href="${args.reset_url}"
           style="display:inline-block;background:#2563eb;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">
          Choose a new password &rarr;
        </a>
      </p>
      <p style="font-size:13px;color:#64748b;line-height:1.5">
        The link works once and expires after about an hour. If you did not ask for
        this, ignore this message — nothing has changed, and your current password
        still works.
      </p>
      <p style="font-size:13px;color:#64748b;line-height:1.5">
        <a href="${args.site_url}" style="color:#2563eb">${escape(args.site_url.replace(/^https?:\/\//, ''))}</a>
      </p>
    </div>`
  return sendEmail({ to: args.to, subject: 'Choose a new password for SSA', html })
}

// ─── Road 2: the QR code ──────────────────────────────────────────────────

interface AccessRequestArgs {
  /** Every manager of the team — they share the job, so they share the mail. */
  to: string[]
  team_name: string
  applicant_name: string
  applicant_email: string
  role: string
  approve_url: string
}

/**
 * Somebody scanned the team's QR code and is waiting.
 *
 * Sent to the managers, not to an admin: the person who can tell whether this
 * is really their bowman is the one who put the code on the boat. It carries
 * the address they typed, because a typo there is the single likeliest reason
 * the approval email never arrives, and it is easier to spot now than later.
 */
export async function sendAccessRequestEmail(args: AccessRequestArgs) {
  const subject = `${args.applicant_name} wants to join ${args.team_name} on SSA`
  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#1e293b">
      <h2 style="color:#0f172a;margin:0 0 16px">Somebody is waiting to join ${escape(args.team_name)}</h2>
      <p style="line-height:1.5">
        <strong>${escape(args.applicant_name)}</strong> (${escape(args.applicant_email)})
        used your team's join code and asked for <strong>${escape(args.role)}</strong> access.
        They have chosen a password already and can do nothing at all until you approve them.
      </p>
      <p style="margin:24px 0">
        <a href="${args.approve_url}"
           style="display:inline-block;background:#2563eb;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">
          Review the request &rarr;
        </a>
      </p>
      <p style="font-size:13px;color:#64748b;line-height:1.5">
        Pending requests are on your team page. Approving sets up their membership and
        emails them; declining clears the request and tells them nothing, so say so
        yourself if they are expecting an answer.
      </p>
      <p style="font-size:13px;color:#64748b;line-height:1.5">
        Check the address above reads correctly. If it is mistyped, decline and have
        them scan again &mdash; the approval email goes to that address.
      </p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
      <p style="font-size:12px;color:#94a3b8">
        Shared Sailing Analytics &middot; If you did not share a join code, revoke it on
        your team page &mdash; anybody holding it can ask to join.
      </p>
    </div>`
  return sendEmail({ to: args.to, subject, html })
}

interface ApprovedArgs {
  to: string
  team_name: string
  role: string
  boat_name?: string | null
  site_url: string
  approver_name?: string | null
}

/**
 * Approved — go and log in.
 *
 * No link to click that does anything: they chose their password when they
 * scanned, so this is the one email in SSA that only needs to say "you're in".
 * Nothing in it can expire, be prefetched, or be spent by a scanner.
 */
export async function sendApprovedEmail(args: ApprovedArgs) {
  const where = args.boat_name ? ` on <strong>${escape(args.boat_name)}</strong>` : ''
  const subject = `You are in: ${args.team_name} on SSA`
  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#1e293b">
      <h2 style="color:#0f172a;margin:0 0 16px">You have been approved</h2>
      <p style="line-height:1.5">
        ${args.approver_name ? `<strong>${escape(args.approver_name)}</strong> has approved` : 'Your team manager has approved'}
        your request to join <strong>${escape(args.team_name)}</strong>
        as <strong>${escape(args.role)}</strong>${where}.
      </p>
      <p style="margin:24px 0">
        <a href="${args.site_url}/login"
           style="display:inline-block;background:#2563eb;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">
          Sign in to SSA &rarr;
        </a>
      </p>
      <p style="font-size:13px;color:#64748b;line-height:1.5">
        Use the password you chose when you scanned the code. Forgotten it already?
        &ldquo;Forgot password?&rdquo; on the sign-in page will sort you out.
      </p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0"/>
      <p style="font-size:12px;color:#94a3b8">Shared Sailing Analytics</p>
    </div>`
  return sendEmail({ to: args.to, subject, html })
}

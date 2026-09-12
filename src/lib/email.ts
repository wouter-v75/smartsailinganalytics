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

export async function sendEmail({
  to,
  subject,
  html,
  text,
}: SendArgs): Promise<
  { ok: true; id: string } | { ok: false; error: string }
> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM
  if (!apiKey || !from) {
    return { ok: false, error: 'RESEND_API_KEY / RESEND_FROM not set' }
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

// Sent when a manager invites by email. By the time this lands, the account
// exists, the address is confirmed and the membership is in place — so it says
// "you are set up, log in", not "accept this invite". Someone who has never had
// an account still needs a password, hence the button.
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
         That link signs you in once so you can choose a password. If it has expired,
         use &ldquo;Forgot password?&rdquo; on the login page — your membership is already set up.
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

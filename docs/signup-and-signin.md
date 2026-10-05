# Sign-up and sign-in: what the manuals say, and what SSA does

A read of Supabase's own auth documentation against SSA's code, written because
the process has cost several days and is harder to follow than it needs to be.

The short version: **one setting in the Supabase dashboard is responsible for
most of the delivery failures, and one page is responsible for most of the
complexity.** Neither is a bug in the code that has been written to work around
them — that code is mostly right, and some of it is better than the
documentation's own advice.

---

## 1. What Supabase's manual actually says

From `apps/docs/content/guides/auth/auth-smtp.mdx` — the custom-SMTP guide:

> **Send messages only to pre-authorized addresses.**
> Unless you configure a custom SMTP server for your project, Supabase Auth
> will refuse to deliver messages to addresses that are not part of the
> project's team. … All other addresses will fail with the error message
> *Email address not authorized.*

> **Significant rate-limits that can change over time.** … **No SLA guarantee
> on message delivery or uptime for the default SMTP service.**
> The default SMTP service is provided as best-effort only and intended for …
> exploring and getting started … toy projects, demos or any non-mission-critical
> application. We urge all customers to set up custom SMTP server for all other
> use cases.

Read that first restriction again, because it is stronger than "rate-limited"
and it is the one that matches what happened here. Without custom SMTP, a
Supabase-sent email **to anybody who is not a member of the Supabase
organisation is refused outright**. It does not bounce to the user. It does not
error in the browser. It simply never arrives — which is indistinguishable from
a mistyped address, and is exactly how 29 September was lost.

The same guide lists Resend first among the providers that work, and the
configuration is a form in the dashboard: host, port, user, password, sender.

On links being consumed before the user clicks them
(`auth/auth-email-templates.mdx`, *Limitations → Email prefetching*):

> Certain email providers may have spam detection or other security features
> that prefetch URL links from incoming emails (e.g. Safe Links in Microsoft
> Defender for Office 365). In this scenario, the `{{ .ConfirmationURL }}` sent
> will be consumed instantly which leads to a "Token has expired or is invalid"
> error.

Their two remedies are an emailed 6-digit code, or **a page carrying a button
that holds the real confirmation link**, so that a GET from a scanner costs
nothing.

And on server-side verification (`auth/passwords.mdx`, PKCE flow): the
documented shape is an `/auth/confirm` route that reads `token_hash` and `type`
from the query and calls `verifyOtp`.

---

## 2. What SSA does today

There are **five** ways a person can arrive at an account, three different ways a
sign-in link is minted, and two different invitation mechanisms that can both be
live for the same person.

| # | Entry point | What it runs | Who sends the email |
|---|---|---|---|
| 1 | `/signup` (self-serve) | `supabase.auth.signUp` → confirm email → `status='pending'` → admin approves | **Supabase's built-in mailer** |
| 2 | `/request-access` | A marketing form. "SSA is invite-only" | — |
| 3 | `/join/<token>` | Open invite link; redeem, or bounce to `/signup?invite=…` | — |
| 4 | Admin invites by email | `provisionTeamMember` — account created, address pre-confirmed, membership inserted, invite row consumed — then a "membership ready" email with a `recovery` link | Resend |
| 5 | `/api/auth/forgot-password` | `generateLink` → same link shape as 4 | Resend |

Four of the five are sound. Everything that goes through Resend works, lands,
and is logged in one dashboard.

**Number 1 is not.** `/signup` still calls `supabase.auth.signUp`, whose
confirmation email is sent by Supabase. If custom SMTP is not configured on the
project — and nothing in this repository suggests it is — that email is
*refused* for every address outside the Supabase organisation. The person is
told "Check your inbox", and nothing is ever coming.

That is the live failure. It is also the one the codebase has already written
three separate workarounds for, each one correct in isolation:

- `lib/email.ts` — "Supabase's own `resetPasswordForEmail` goes out over its
  built-in SMTP, which is rate-limited … Two people lost a day to it."
- `api/auth/forgot-password/route.ts` — the whole route exists to take the
  reset off Supabase's mailer.
- `provision-member.ts` — creates the account with `email_confirm: true`
  precisely so no confirmation email is needed.

Three fixes for one missing dashboard setting, and the one path nobody moved —
public signup — is the one still broken.

---

## 3. What is right, and should not be "simplified"

`/auth/callback` serves a **form** on GET and verifies on POST. That is not
over-engineering; it is Supabase's documented Option 2 for link prefetching,
implemented better than the version in their docs:

- A preview fetch (iMessage, WhatsApp, Outlook Safe Links) gets HTML and spends
  nothing. Only a POST spends the token.
- The password is validated **before** the token is spent, so a mistyped
  confirmation costs a retype rather than the link.
- It redirects with 303, not 307 — a 307 out of a POST makes the browser re-POST
  to the destination, which is how a successful password set landed on an error
  page.
- The address in the link is display-only; the account that gets the password is
  whichever one the token resolves to.

Each of those was paid for. Keep them.

The one wrinkle: `firstLoginLink` falls back to Supabase's `action_link` when no
`hashed_token` comes back. That fallback is the PKCE path which **cannot** work
for an invited person — there is no `code_verifier` in a browser that has never
begun a flow. It is a quiet route back to the 1 October failure. Better to send
no link and let "Forgot password?" do the job, which the email already explains.

---

## 4. The two changes that matter

### 4a. Configure custom SMTP in Supabase — no code, five minutes

Dashboard → Authentication → Emails → SMTP Settings. Take the credentials from
Resend's dashboard (SMTP tab) and use a sender on the domain already verified
there — the same one `RESEND_FROM` uses. Then raise the rate limit: Supabase
imposes 30 messages/hour on a newly configured custom SMTP until you change it
(Authentication → Rate Limits).

This does not change a line of code, and it closes the hole under `/signup`,
under every future Supabase-sent message, and under anything added later by
somebody who does not know the history.

Verification, after saving: a signup from an address outside the Supabase
organisation should receive its confirmation. Before the change, it will not.

### 4b. Decide what the front door is — one page, not two

The marketing site says, in its own words:

> SSA is invite-only, and onboarding is done with you rather than by a signup
> form.

And yet `/signup` is a full self-serve registration: email, password, privacy
consent, recording consent, a confirmation email, a `pending` status, an admin
approval queue, a `requested_team_id` triple on the user row, `/api/invitations/
[token]/stash` to pre-fill the approval form when the OTP expires first, and
`?reason=pending` on the login page to explain the wait.

All of that machinery exists to support a door the product says is closed.

**The proposal: `/signup` becomes a redirect to `/request-access`, and the
manager's invite is the only way an account is created.** What that removes:

| Removed | Why it can go |
|---|---|
| `supabase.auth.signUp` call | the last Supabase-sent email in the app |
| `status='pending'` + approval queue | an invited member is already active — `provisionTeamMember` sets it |
| `requested_team_id` / `_role` / `_boat_id` | only ever filled by self-serve signup |
| `/api/invitations/[token]/stash` | exists solely to survive a signup-confirm OTP expiring |
| `?reason=pending` on `/login` | nobody is pending any more |
| `sendInviteEmail` + `/join/<token>` | keep **only** if open "post it in WhatsApp" links are still wanted |

What remains is one sentence long: **a manager invites an address; the person
receives one email; they choose a password on one screen; they are in.** That is
already built, already tested, and already works — it is flow 4 above.

The open-link flow (`/join/<token>`) is a real feature, not clutter, *if* you
still want to drop a link into a crew WhatsApp group. If you do, keep it and let
it create the account the same way flow 4 does rather than sending people to a
signup form. If you do not, it goes with the rest.

---

## 5. Smaller things found on the way

- `src/middleware.ts` lists `/auth/confirm` as a public path. There is no such
  route — the callback is `/auth/callback`. Harmless, but it reads as though a
  second verification endpoint exists.
- `supabase/config.toml` (local dev only) carries `[auth.rate_limit] email_sent
  = 2`, which is the inbuilt-SMTP default. Local signup testing will hit it
  after two messages in an hour and then silently stop.
- Password minimum is 8 characters in three places — `/signup`, the callback
  form, `/auth/reset-password` — each with its own constant. One shared constant
  would stop them drifting apart.
- `lib/email.ts` posts to Resend's HTTP API directly rather than pulling in
  their SDK, which is a sound call and worth keeping.

---

## 6. The checklist

1. **Supabase dashboard → Auth → Emails → SMTP**: enable, fill in from Resend,
   sender on the verified domain. Then **Auth → Rate Limits**: raise from 30/hour.
2. Send yourself a signup confirmation from an address outside the Supabase
   organisation. It should arrive. (This is the test that proves step 1.)
3. Decide on `/signup`: redirect to `/request-access`, or keep it. Everything in
   §4b follows from that one answer.
4. Decide on `/join/<token>`: keep for open links, or remove.
5. Drop the `action_link` fallback in `firstLoginLink` — it is a link that
   cannot work, sent in place of one that would.

Steps 1 and 2 are worth doing today whatever is decided about 3 and 4: they cost
nothing and they are the reason mail has been going missing.

---

### Sources

- Supabase, *Send emails with custom SMTP* — `guides/auth/auth-smtp`
- Supabase, *Email Templates*, Limitations → Email prefetching — `guides/auth/auth-email-templates`
- Supabase, *Passwords*, PKCE flow → token exchange endpoint — `guides/auth/passwords`
- Supabase, *Send Email Hook* — `guides/auth/auth-hooks/send-email-hook`
  (an alternative to custom SMTP: route every auth email through a function that
  calls Resend. More control, more moving parts; custom SMTP is the smaller step
  and solves the problem at hand.)

Read from the `supabase/supabase` repository, which is where those pages live.

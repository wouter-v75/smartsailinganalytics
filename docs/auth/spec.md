# SSA Auth & Multi-Tenancy — Decisions Memo

Living document. Captures choices we've agreed on so we don't relitigate them every build session.

## Stack

- **Auth & DB**: Supabase, EU region (Frankfurt). US-incorporated company; data resident in the EU under GDPR. Migration to a pure-EU stack (Aiven / Scaleway + Lucia / Better Auth) is left as an option — the schema is plain Postgres and Supabase's auth is straightforward to swap.
- **Auth methods**: passkey (WebAuthn) primary, email + password fallback for lockouts.
- **Email**: **Resend, for everything.** Supabase's own mailer sends nothing in SSA and must not be reintroduced.
  Its documentation is explicit: *"Unless you configure a custom SMTP server for your project, Supabase Auth
  will refuse to deliver messages to addresses that are not part of the project's team … All other addresses
  will fail with the error message* **Email address not authorized**.*"* It is not a rate limit you can wait
  out — it is a refusal, and it is invisible from the app, because the call returns ok and no mail is ever
  sent. That line cost 29 September (a confirmation that never arrived) and 1 October (a reset that never
  arrived), and both looked exactly like a mistyped address.
  Custom SMTP in the Supabase dashboard is still worth configuring as belt-and-braces, so that anything added
  later by somebody who does not know this history fails loudly rather than silently.
- **Hosting**: Next.js on Vercel as today; Supabase reached via the standard `supabase-js` SDK.

## Two roads in, and nothing else

Decided 6 October 2026, after three rebuilds of the invite flow. There is **no signup form**: `/signup` is a
redirect to `/request-access`. Every account is created by a team manager's action, server-side, with the
address pre-confirmed — so no road depends on Supabase sending anything.

### Road 1 — the manager invites an address

1. Manager enters an email on the team page. `provisionTeamMember` creates the account (`email_confirm: true`),
   marks it active, inserts the membership. Nothing is left to approve.
2. Resend sends one email carrying `/welcome/<token>` — **our own `invitations` row**, not a Supabase OTP.
3. One screen: password, confirm. The password is set with the service key and they are signed in immediately
   with it.
4. No confirmation email, no approval, no second screen.

**Why not Supabase's own link.** Two attempts failed in the field and both are instructive. A PKCE `?code=`
cannot be exchanged by somebody who has never had a session in any browser — there is no `code_verifier`, so it
fails for *every* invited person. A `recovery` OTP then worked until a mail client fetched it: verifyOtp is
single-use, previews are GETs, and Apple's spent one 1 min 49 s after it was minted. Serving a form on GET
fixes the preview; it cannot fix the one-hour OTP expiry, which is a project setting. Our own token has our
own expiry (a fortnight), our own single use, and our own revocation.

### Road 2 — the manager shares a QR code

1. Manager creates an open invitation; the panel renders it as a QR code.
2. `/join/<token>` takes a name, an address and a password. The account is created **pending, with no
   membership** — it can sign in to nothing.
3. Resend tells every manager of that team, with a link to the pending queue.
4. Approve creates the membership and flips to active; Resend tells the person, who signs in with the password
   they already chose. Nothing in that email can expire or be spent by a scanner.

The address is not verified, and does not need to be: nothing is granted until a human who knows the crew
approves, and the approval email goes to that address, so a typo surfaces as "I never got it" rather than as
access.

### Errors have an audience

Every step is recorded through `lib/authEvents.ts` with a severity and a human sentence, because the failure
mode that cost the most was a silent one — a manager seeing "invitation created" for mail that never sent.
The person gets a sentence on the page with the way out; the manager sees it in SSA beside the thing it
concerns; the admin gets "Getting in — N things to look at" at the top of the audit log.

`npm run auth:selftest` drives Road 1 against a real invitation row and deletes it again, including the check
that a GET spends nothing.

## Roles

Six roles. One global, five membership-scoped.

The model separates **operations** (manage who's on the team, what boats they sail on) from **technical** (run training, edit data, run SailScan). A real-world owner-skipper who also sails holds two memberships — `team_manager` for ops and `coach`/`tl2` for sailing.

| Role           | Scope         | Notes                                                |
| -------------- | ------------- | ---------------------------------------------------- |
| `admin`        | global        | Platform support. Cross-tenant escape hatch. Day-to-day hands-off. Set on `users.global_role`. |
| `team_manager` | per team      | **Operations**. Manages boats, memberships (incl. coaches), renames team, curates tag lists. Reads all team data; does NOT write data (would need a separate sailing-side membership). |
| `coach`        | per (team, boat) | **Technical**. Runs SailScan / AI, edits any team data, calibrates yacht stripe colours, deletes sessions/photos/videos. No user or boat management. |
| `tl2`          | per (team, boat) | Senior crew. Uploads, edits own, runs SailScan + SquashShots + AI. |
| `tl1`          | per (team, boat) | Junior crew. Uploads, edits own, runs SailScan + SquashShots. **No AI.** Has data-analysis tab. |
| `consultant`   | per (team, boat) **with valid_from / valid_to** | Time-bounded contributor. Same upload + SailScan + SquashShots powers as tl1 within their window. **No AI, no data-analysis tab.** Window closes → loses read + write access (uploaded data persists in team archive). |

Permission matrix lives in `docs/auth/permissions.md`.

## Multi-tenancy

- A user can have **many memberships**: e.g. (Team A, Boat 1, tl2), (Team A, Boat 2, tl2), (Team B, Boat 5, coach).
- Membership row carries the role and (for consultants) `valid_from / valid_to`.
- A user **picks an active membership** in the app. UI scoped to that team/boat.

## Quotas

Per-user, by role. Storage tracked in `user_quota.bytes_used`, ceiling in `bytes_limit`.

| Role           | Default bytes_limit |
| -------------- | --------------------|
| `admin`        | unlimited (`bytes_limit = NULL` or very large) |
| `team_manager` | 5 GB (rare uploader) |
| `coach`        | 50 GB |
| `tl2`          | 10 GB |
| `tl1`          | 5 GB |
| `consultant`   | 5 GB |

- **80 % threshold** → warning banner in app + email to user.
- **100 % threshold** → upload blocked + email to user **and** to admin.
- Reset cycle: none for now (lifetime quota). May add per-season reset later.

## Migration policy for existing data

Hard cutover. Existing IndexedDB / localStorage data is wiped on first login of L1.1. Everything that's currently in the workspace is for testing only.

## Phasing

- **L1.0** (this session) — schema + RLS policies + runbook. User provisions Supabase manually.
- **L1.1** — `supabase-js` install, auth context, login / admin queue pages. (The signup page this once named was removed on 6 October; see the two roads above.)
- **L1.2** — passkey UI (WebAuthn). User can register a passkey. Email/password remains as fallback.
- **L2** — team / boat / membership management UI. Admin assigns roles after approval.
- **L3** — RLS-backed data partitioning. Existing app routes filter by user's active membership.
- **L4** — quota tracking + enforcement + email notifications.
- **L5** — polish, audit log, refinements.

Roughly 4–6 build sessions end-to-end.

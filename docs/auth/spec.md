# SSA Auth & Multi-Tenancy — Decisions Memo

Living document. Captures choices we've agreed on so we don't relitigate them every build session.

## Stack

- **Auth & DB**: Supabase, EU region (Frankfurt). US-incorporated company; data resident in the EU under GDPR. Migration to a pure-EU stack (Aiven / Scaleway + Lucia / Better Auth) is left as an option — the schema is plain Postgres and Supabase's auth is straightforward to swap.
- **Auth methods**: passkey (WebAuthn) primary, email + password fallback for lockouts.
- **Email**: Supabase transactional email (free tier, ~3000/mo). Adequate for our scale.
- **Hosting**: Next.js on Vercel as today; Supabase reached via the standard `supabase-js` SDK.

## User signup & approval

- Manual approval. New users land in `users.status = 'pending'` and cannot log in. They sit in an admin queue.
- Admin (Wouter) reviews each request, sets the user's role / team / boat memberships, and flips status to `'active'`.
- On approval the user receives an email with a passkey-setup link.
- No domain allow-list, no auto-approve.

## Roles

Five roles. Two have global scope; three are membership-scoped (apply only within a (team, boat) context).

| Role         | Scope         | Notes                                                |
| ------------ | ------------- | ---------------------------------------------------- |
| `admin`      | global        | Site manager. Full access. Set on `users.global_role`. |
| `coach`      | per (team,boat) | Manages team data, runs SailScan / AI, can edit others' uploads. |
| `tl2`        | per (team,boat) | Senior crew. Runs SailScan / AI, uploads, edits own. |
| `tl1`        | per (team,boat) | Junior crew. Uploads own + views team data. No SailScan / AI. |
| `consultant` | per (team,boat) **with valid_from / valid_to** | Read-only, time-bounded. Sees only data with `utc BETWEEN valid_from AND valid_to`. |

Permission matrix lives in `docs/auth/permissions.md`.

## Multi-tenancy

- A user can have **many memberships**: e.g. (Team A, Boat 1, tl2), (Team A, Boat 2, tl2), (Team B, Boat 5, coach).
- Membership row carries the role and (for consultants) `valid_from / valid_to`.
- A user **picks an active membership** in the app. UI scoped to that team/boat.

## Quotas

Per-user, by role. Storage tracked in `user_quota.bytes_used`, ceiling in `bytes_limit`.

| Role         | Default bytes_limit |
| ------------ | --------------------|
| `admin`      | unlimited (`bytes_limit = NULL` or very large) |
| `coach`      | 50 GB |
| `tl2`        | 10 GB |
| `tl1`        | 5 GB |
| `consultant` | 5 GB |

- **80 % threshold** → warning banner in app + email to user.
- **100 % threshold** → upload blocked + email to user **and** to admin.
- Reset cycle: none for now (lifetime quota). May add per-season reset later.

## Migration policy for existing data

Hard cutover. Existing IndexedDB / localStorage data is wiped on first login of L1.1. Everything that's currently in the workspace is for testing only.

## Phasing

- **L1.0** (this session) — schema + RLS policies + runbook. User provisions Supabase manually.
- **L1.1** — `supabase-js` install, auth context, signup / login / admin queue pages. User can sign up and log in.
- **L1.2** — passkey UI (WebAuthn). User can register a passkey. Email/password remains as fallback.
- **L2** — team / boat / membership management UI. Admin assigns roles after approval.
- **L3** — RLS-backed data partitioning. Existing app routes filter by user's active membership.
- **L4** — quota tracking + enforcement + email notifications.
- **L5** — polish, audit log, refinements.

Roughly 4–6 build sessions end-to-end.

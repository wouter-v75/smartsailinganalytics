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
- **L1.1** — `supabase-js` install, auth context, signup / login / admin queue pages. User can sign up and log in.
- **L1.2** — passkey UI (WebAuthn). User can register a passkey. Email/password remains as fallback.
- **L2** — team / boat / membership management UI. Admin assigns roles after approval.
- **L3** — RLS-backed data partitioning. Existing app routes filter by user's active membership.
- **L4** — quota tracking + enforcement + email notifications.
- **L5** — polish, audit log, refinements.

Roughly 4–6 build sessions end-to-end.

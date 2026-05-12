# SSA Permission Matrix

Authoritative reference. Implemented in `supabase/migrations/0002_rls_policies.sql` (database side) and enforced again in the app UI to hide features users can't reach.

## Role definitions

| Role           | Scope            | Created by | Time-windowed? |
| -------------- | ---------------- | ---------- | -------------- |
| `admin`        | global           | manual SQL update on `users.global_role` | No |
| `team_manager` | per team         | admin assigns membership | No |
| `coach`        | per (team, boat) | admin assigns membership | No |
| `tl2`          | per (team, boat) | admin assigns membership | No |
| `tl1`          | per (team, boat) | admin assigns membership | No |
| `consultant`   | per (team, boat) | admin assigns membership | **Yes — `valid_from` / `valid_to`** |
| `guest`        | per (team, boat) | admin assigns membership | Optional |

A user can hold multiple memberships and switches between them in the app.

## Feature-level UI gating (added in 0008)

| Feature                                    | admin | team_manager | coach | tl2 | tl1 | consultant | guest |
| ------------------------------------------ | :---: | :----------: | :---: | :-: | :-: | :--------: | :---: |
| **SailScan tab**                           | ✅    | ✅           | ✅    | ✅  | ❌  | ⏱         | ❌    |
| **SquashShots tab**                        | ✅    | ✅           | ✅    | ✅  | ✅  | ⏱         | ❌    |
| Analytics tab — **GPS map**                | ✅    | ✅           | ✅    | ✅  | ✅  | ⏱         | ✅    |
| Analytics tab — **charts, polar, AI**      | ✅    | ✅           | ✅    | ✅  | ❌  | ⏱         | ❌    |
| Header **AI search**                       | ✅    | ✅           | ✅    | ✅  | ❌  | ❌         | ❌    |
| Photos tab — see SailScan-tagged photos    | ✅    | ✅           | ✅    | ✅  | ❌  | ⏱         | ❌    |
| Sessions list — **only latest day**        | full  | full         | full  | full| full| full       | latest-only |

Consultants get full access within their `valid_from`/`valid_to` window; outside it, RLS denies all reads automatically.

## Resource × role matrix

Legend: ✅ allowed · ❌ forbidden · ⏱ allowed only inside `valid_from … valid_to`.

### User profiles & approvals

| Action                                 | admin | coach | tl2 | tl1 | consultant |
| -------------------------------------- | :---: | :---: | :-: | :-: | :--------: |
| See own profile                        | ✅    | ✅    | ✅  | ✅  | ✅         |
| See teammates' profile (name, email)   | ✅    | ✅    | ✅  | ✅  | ⏱         |
| Edit own profile                       | ✅    | ✅    | ✅  | ✅  | ✅         |
| Approve pending users                  | ✅    | ❌    | ❌  | ❌  | ❌         |
| Suspend / disable users                | ✅    | ❌    | ❌  | ❌  | ❌         |

### Teams & boats

| Action                       | admin | coach | tl2 | tl1 | consultant |
| ---------------------------- | :---: | :---: | :-: | :-: | :--------: |
| Create team                  | ✅    | ❌    | ❌  | ❌  | ❌         |
| Rename / delete team         | ✅    | ❌    | ❌  | ❌  | ❌         |
| View team metadata           | ✅    | ✅    | ✅  | ✅  | ⏱         |
| Create boat in team          | ✅    | ✅    | ❌  | ❌  | ❌         |
| Edit / delete boat           | ✅    | ✅    | ❌  | ❌  | ❌         |
| View boat metadata           | ✅    | ✅    | ✅  | ✅  | ⏱         |

### Memberships (who's in a team)

| Action                       | admin | coach | tl2 | tl1 | consultant |
| ---------------------------- | :---: | :---: | :-: | :-: | :--------: |
| See own memberships          | ✅    | ✅    | ✅  | ✅  | ✅         |
| See team's memberships       | ✅    | ✅    | ❌  | ❌  | ❌         |
| Add / remove memberships     | ✅    | ❌    | ❌  | ❌  | ❌         |
| Change role of a membership  | ✅    | ❌    | ❌  | ❌  | ❌         |
| Set consultant time window   | ✅    | ❌    | ❌  | ❌  | ❌         |

Coaches can request membership changes via admin out-of-band; the system does not let them mutate memberships directly.

### Sessions, photos, videos, mast_settings, tag_lists (added in L3.A, refined in 0007)

Tables ship in `supabase/migrations/0003_data_schema.sql`. RLS policies enforce the matrix below via the `has_boat_access` / `has_team_role` / `is_admin` helpers from 0002. Consultant uploads (added in 0007) are gated by their `valid_from`/`valid_to` window — when the window closes, RLS denies both reads and writes, so they can no longer see or edit anything they contributed (data stays in the team archive).

team_manager is intentionally **not** in the upload list. A team_manager who also sails holds a second membership (typically `tl2` or `coach`) for that role.

| Action                              | admin | team_manager | coach | tl2 | tl1 | consultant |
| ----------------------------------- | :---: | :----------: | :---: | :-: | :-: | :--------: |
| Upload photo / video / log to boat  | ✅    | ❌           | ✅    | ✅  | ✅  | ⏱         |
| View own uploads                    | ✅    | ✅           | ✅    | ✅  | ✅  | ⏱         |
| View teammates' uploads (same boat) | ✅    | ✅           | ✅    | ✅  | ✅  | ⏱         |
| View other boats' uploads (same team) | ✅  | ✅           | ✅    | ❌  | ❌  | ❌         |
| Edit own uploads                    | ✅    | ❌           | ✅    | ✅  | ✅  | ⏱         |
| Edit others' uploads                | ✅    | ❌           | ✅    | ❌  | ❌  | ❌         |
| Delete uploads                      | ✅    | ❌           | ✅    | ❌  | ❌  | ❌         |

### Analyses (SailScan, SquashShots, AI commentary)

These are UI-level gates (the DB doesn't know about features). Enforced in client components via the active membership's role.

| Action                              | admin | team_manager | coach | tl2 | tl1 | consultant |
| ----------------------------------- | :---: | :----------: | :---: | :-: | :-: | :--------: |
| Run SailScan on a photo             | ✅    | ❌           | ✅    | ✅  | ✅  | ⏱         |
| Run SquashShots                     | ✅    | ❌           | ✅    | ✅  | ✅  | ⏱         |
| Run AI commentary / video AI        | ✅    | ❌           | ✅    | ✅  | ❌  | ❌         |
| Access **Data Analysis** tab        | ✅    | ✅           | ✅    | ✅  | ✅  | ❌         |
| View existing analyses              | ✅    | ✅           | ✅    | ✅  | ✅  | ⏱         |
| Edit / approve a SailScan result    | ✅    | ❌           | ✅    | ✅  | ✅  | ❌         |
| Calibrate yacht stripe colours      | ✅    | ❌           | ✅    | ✅  | ❌  | ❌         |

Rationale: tl1 + consultant can take pictures and run SailScan / SquashShots (cheap inference). AI commentary stays gated to coach + tl2 (more expensive, requires interpretation skill). Consultants are deliberately blocked from the data-analysis tab — they're external advisors and should view through the lens the team curates for them, not browse the raw archive.

### Quotas & storage

| Action                          | admin | coach | tl2 | tl1 | consultant |
| ------------------------------- | :---: | :---: | :-: | :-: | :--------: |
| See own quota                   | ✅    | ✅    | ✅  | ✅  | ✅         |
| See others' quota               | ✅    | ❌    | ❌  | ❌  | ❌         |
| Override a user's `bytes_limit` | ✅    | ❌    | ❌  | ❌  | ❌         |
| Reset 80 / 100 % warning flags  | ✅    | ❌    | ❌  | ❌  | ❌         |

Default `bytes_limit` per role: see [`spec.md § Quotas`](./spec.md#quotas).

### Audit / events

| Action                           | admin | coach | tl2 | tl1 | consultant |
| -------------------------------- | :---: | :---: | :-: | :-: | :--------: |
| Append events for self           | ✅    | ✅    | ✅  | ✅  | ✅         |
| View own events                  | ✅    | ✅    | ✅  | ✅  | ✅         |
| View team's events               | ✅    | ❌    | ❌  | ❌  | ❌         |
| Edit / delete events             | ✅    | ❌    | ❌  | ❌  | ❌         |

## Notes on the consultant time-window

`memberships.valid_from` / `valid_to` define the *active* window. Outside that window, every helper function (`is_team_member`, `has_team_role`, `has_boat_access`) returns false, which means RLS denies SELECT on every team-scoped resource. The app should reflect this by hiding teams whose membership is expired in the team-switcher.

When data tables (sessions, photos, videos) land in L3, we'll add a *secondary* time filter: consultants only see rows whose timestamp `utc` falls inside the `valid_from / valid_to` window. So even within an active membership, consultants can't browse data outside their contracted period.

## What "active user" means

An "active" user is one with `users.status = 'active'`. The helper `is_active_user()` is used by event-insert policies to make sure pending / disabled users can't append to the audit log. Most queries don't need this — RLS denies them anyway because they have no memberships and `is_admin()` returns false.

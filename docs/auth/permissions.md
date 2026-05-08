# SSA Permission Matrix

Authoritative reference. Implemented in `supabase/migrations/0002_rls_policies.sql` (database side) and enforced again in the app UI to hide features users can't reach.

## Role definitions

| Role         | Scope            | Created by | Time-windowed? |
| ------------ | ---------------- | ---------- | -------------- |
| `admin`      | global           | manual SQL update on `users.global_role` | No |
| `coach`      | per (team, boat) | admin assigns membership | No |
| `tl2`        | per (team, boat) | admin assigns membership | No |
| `tl1`        | per (team, boat) | admin assigns membership | No |
| `consultant` | per (team, boat) | admin assigns membership | **Yes — `valid_from` / `valid_to`** |

A user can hold multiple memberships and switches between them in the app.

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

### Sessions, photos, videos (tracked in app, not yet in DB at L1.0)

These tables don't exist yet — they'll be added in L3 when we move data off IndexedDB. Including the matrix here so we don't have to relitigate later.

| Action                              | admin | coach | tl2 | tl1 | consultant |
| ----------------------------------- | :---: | :---: | :-: | :-: | :--------: |
| Upload photo / video / log to boat  | ✅    | ✅    | ✅  | ✅  | ❌         |
| View own uploads                    | ✅    | ✅    | ✅  | ✅  | ⏱         |
| View teammates' uploads (same boat) | ✅    | ✅    | ✅  | ✅  | ⏱         |
| View other boats' uploads (same team) | ✅  | ✅    | ❌  | ❌  | ❌         |
| Edit own uploads                    | ✅    | ✅    | ✅  | ✅  | ❌         |
| Edit others' uploads                | ✅    | ✅    | ❌  | ❌  | ❌         |
| Delete uploads                      | ✅    | ✅    | ❌  | ❌  | ❌         |

### Analyses (SailScan, AI commentary, etc.)

| Action                              | admin | coach | tl2 | tl1 | consultant |
| ----------------------------------- | :---: | :---: | :-: | :-: | :--------: |
| Run SailScan on a photo             | ✅    | ✅    | ✅  | ❌  | ❌         |
| Run AI commentary / video AI        | ✅    | ✅    | ✅  | ❌  | ❌         |
| View existing analyses              | ✅    | ✅    | ✅  | ✅  | ⏱         |
| Edit / approve a SailScan result    | ✅    | ✅    | ✅  | ❌  | ❌         |
| Calibrate yacht stripe colours      | ✅    | ✅    | ✅  | ❌  | ❌         |

Rationale: TL1 is junior — can record data, but not consume scarce AI resources.

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

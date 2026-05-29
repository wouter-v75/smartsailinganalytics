# SSA Campaign Spine — Data Schema (design doc)

**Status:** draft for review · **Scope:** the session-centric data model that turns SSA from a video/data sharing tool into a campaign engine for the 72ft programme.

This document defines the *entities, fields, and relationships* only. No SQL yet — once the model is agreed it becomes migration `0014+` in the existing `supabase/migrations/` series, following the conventions already in `0003_data_schema.sql`.

---

## 1. Principles carried from the brief

- **One spine, session-centric.** Everything hangs off a day's `session`; within a session, the unit of test is a `run`.
- **The debrief is the hinge.** A clip + data run (observation) → a `clip_note` → an `action` (coordination) → eventually a tuning-guide entry (knowledge). The schema must make the chain `clip ↔ run ↔ config ↔ action` first-class — that linkage *is* the product, not a generic task list.
- **Additive, not greenfield.** SSA already has most of the spine. We extend it.
- **Heavy compute stays out.** The analysis engine is a separate service that reads/writes one table (`datasets`) over the shared auth layer. SSA never runs VPP correlation itself.

---

## 2. What already exists (we build on this)

These are live in `supabase/migrations/` today and must be reused, not duplicated:

| Table | Role in the new model | Notes |
|---|---|---|
| `teams` | Org root | |
| `boats` | The yacht. Has `length_m`. | Single-boat programme → most rows carry one `boat_id`. |
| `memberships` | user × (team, boat) × role + valid window | Drives all RLS. Roles: `coach, tl1, tl2, consultant, guest`; plus global `admin`. |
| `users` | Identity | |
| **`sessions`** | **= the brief's "Session object"** | One row per `(boat, date)`. Already holds `log_data`, `xml_data`, `tz_offset_minutes`, `title`. **We extend it.** |
| **`videos`** | **= the brief's "Clip"** | Tied to `session_id`. **We add `run_id`.** |
| `photos` | SailScan stills | Stays as-is; can optionally gain `run_id` later. |
| `mast_settings` | Per-session rig snapshot (JSONB, one per session) | See decision D2 — relationship to per-run `configs`. |
| `tag_lists` | Tag vocabulary per (team, boat) | Unchanged. |
| `events` | Audit log | Unchanged. |

**RLS pattern (must be matched by every new table):** denormalise `team_id` + `boat_id` onto every row; gate `SELECT` with `has_boat_access(team_id, boat_id)`, `INSERT/UPDATE/DELETE` with `has_team_role(...)` / `own_or_coach(...)`, `is_admin()` bypass. `created_by_user_id` + `created_at`/`updated_at` (with `touch_updated_at` trigger) on every table.

---

## 3. New + extended entities

### 3.1 `sessions` — EXTEND
Add columns (no new table):

| Column | Type | Purpose |
|---|---|---|
| `conditions` | `JSONB` | Day conditions: wind range, direction, sea state, current, tide, venue notes. Free-shape; auto-seeded from log where possible. |
| `objective` | `TEXT` | The day's test plan / intent in one field (the "run plan that produced them" at the day level; individual runs link to backlog items). |

`UNIQUE(boat_id, date)` stays.

### 3.2 `runs` — NEW (the unit of test)
A single test run inside a session (e.g. "Upwind speed run 3, J2 + full main, 12–14 kt"). Clips, datasets, configs, and manoeuvres attach here.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `session_id` | `UUID FK → sessions` `ON DELETE CASCADE` | |
| `team_id`, `boat_id` | `UUID` | denorm for RLS |
| `seq` | `INTEGER` | run number within the session (ordering) |
| `label` | `TEXT` | "Upwind run 3" |
| `mode` | `TEXT` | `upwind \| reach \| downwind \| start \| manoeuvre \| transit` |
| `start_utc`, `end_utc` | `TIMESTAMPTZ` | the run's window — used to **slice** `sessions.log_data`, not to copy it |
| `objective` | `TEXT` | what this run tested |
| `backlog_item_id` | `UUID FK → backlog_items` (nullable) | the plan item this run addresses → "the run plan that produced them" |
| `conditions` | `JSONB` | per-run snapshot (TWS/TWD/sea); auto-fillable from the log window |
| `notes` | `TEXT` | |
| `created_by_user_id`, `created_at`, `updated_at` | | |

Index: `(session_id, seq)`, `(team_id, boat_id)`.

### 3.3 `configs` — NEW (per-run setup log)
Rake, tension, ballast/cant, sail combo, rudder toe — the settings behind each run's dataset. Critical with no tuning partner; feeds the tuning guide.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `run_id` | `UUID FK → runs` `ON DELETE CASCADE` | `UNIQUE(run_id)` — one config per run |
| `session_id`, `team_id`, `boat_id` | `UUID` | denorm |
| `sail_config` | `TEXT` | headline combo, e.g. "Full main + J2 + staysail" — promoted out of JSON for fast filtering/trending |
| `keel_cant_deg` | `NUMERIC` | canting-keel angle (programme-specific, trended) |
| `rudder_toe_deg` | `NUMERIC` | twin-rudder toe (programme-specific, trended) |
| `rake_mm` / `forestay_mm` | `NUMERIC` | the always-charted rig numbers |
| `settings` | `JSONB` | everything else (shroud tensions, ballast, deflectors…) — class-agnostic, documented shape |
| `notes` | `TEXT` | |
| `created_by_user_id`, `created_at`, `updated_at` | | |

> The handful of typed columns are the ones we *trend across sessions*; `settings` JSONB keeps the rest flexible (same philosophy as `mast_settings`).

### 3.4 `datasets` — NEW (and the analysis-engine boundary)
Computed summaries and pushed-back analysis for a run (or session). **This is the one table the separate analysis engine writes to.**

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `run_id` | `UUID FK → runs` (nullable — may be session-level) | |
| `session_id`, `team_id`, `boat_id` | `UUID` | denorm |
| `kind` | `TEXT` | `run-summary \| polar-observed \| mode-map \| flying-shape \| vpp-correlation` (extensible) |
| `window_start_utc`, `window_end_utc` | `TIMESTAMPTZ` | the slice this summarises |
| `source` | `TEXT` | `ssa-auto` (computed in-app) \| `analysis-engine` (pushed by the external service) |
| `metrics` | `JSONB` | headline numbers: avg/max BSP, TWS, TWA, VMG, polar %, target %, manoeuvre count |
| `payload` | `JSONB` | richer analysis output (observed-vs-predicted curves, mode map, shapes) |
| `created_at`, `updated_at` | | |

Raw log rows are **not** copied here — they live once in `sessions.log_data`; a dataset stores the *window pointer + computed result*.

### 3.5 `clip_notes` — NEW (debrief annotations)
Timestamped notes on a clip. The raw material of the debrief; promotes into actions.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `video_id` | `UUID FK → videos` `ON DELETE CASCADE` | |
| `session_id`, `team_id`, `boat_id` | `UUID` | denorm |
| `t_offset_ms` | `INTEGER` | timestamp within the clip the note pins to |
| `body` | `TEXT` | the observation |
| `promoted_to_id` | `UUID FK → backlog_items` (nullable) | set when this note becomes an action |
| `author_user_id`, `created_at` | | |

### 3.6 `backlog_items` — NEW (the ONE backlog: actions + FMEA + plan)
Per decision D1, a single table discriminated by `kind`/`category`. Action items, FMEA entries, department tasks, programme milestones (July sail order, worlds) are all rows here; the "filtered views" are just `WHERE` clauses. The differentiator vs Jira is the `source_*` provenance links.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `team_id`, `boat_id` | `UUID` | denorm |
| `kind` | `TEXT` | `action \| fmea \| task \| deliverable \| milestone` |
| `category` | `TEXT` | department filter: `boatspeed \| boathandling \| reliability \| rig \| sails \| shore \| logistics …` |
| `title` | `TEXT` | |
| `body` | `TEXT` | |
| `status` | `TEXT` | `open \| in_progress \| done \| parked \| wontfix` |
| `priority` | `SMALLINT` | 1–5 |
| `owner_user_id` | `UUID FK → users` (nullable) | |
| `target_session_id` | `UUID FK → sessions` (nullable) | the session an action is aimed at — the brief's "target session" |
| `due_date` | `DATE` (nullable) | programme-layer milestones (mid-July sail order, Sept 1 worlds) |
| `is_milestone` | `BOOLEAN` | immovable programme-layer item (vs iteration-layer task) |
| `source_note_id` | `UUID FK → clip_notes` (nullable) | provenance: born from a debrief note |
| `source_run_id` | `UUID FK → runs` (nullable) | …or a run |
| `source_clip_id` | `UUID FK → videos` (nullable) | …or a clip |
| `meta` | `JSONB` | kind-specific extras — for FMEA: `{severity, occurrence, detection, rpn}` |
| `created_by_user_id`, `created_at`, `updated_at` | | |

The **two-layer plan** is just `is_milestone`/`due_date`/`kind='milestone'` (programme layer) vs everything else (iteration layer), filtered by `category` per department. **FMEA tracker** = `WHERE kind='fmea'`.

### 3.7 `manoeuvre_events` — NEW (boathandling, made measurable)
One row per tack/gybe/etc., with the loss/recovery metrics; trend across sessions.

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID PK` | |
| `run_id` | `UUID FK → runs` (nullable) | |
| `session_id`, `team_id`, `boat_id` | `UUID` | denorm |
| `video_id` | `UUID FK → videos` (nullable) | link to the clip if one exists |
| `utc` | `TIMESTAMPTZ` | when it happened |
| `clip_offset_ms` | `INTEGER` (nullable) | position in the clip |
| `kind` | `TEXT` | `tack \| gybe \| roundup \| bearaway` |
| `vmg_loss` | `NUMERIC` | VMG lost (boat lengths) |
| `time_lost_s` | `NUMERIC` | seconds vs reference |
| `recovery_s` | `NUMERIC` | time to recover target speed |
| `entry_tws`, `entry_twa` | `NUMERIC` | conditions at entry |
| `valid` | `BOOLEAN` | include in trends? (mirrors Expedition's `isValidPerf`) |
| `source` | `TEXT` | `log-auto` (from Expedition tackJibe events) \| `manual` |
| `notes` | `TEXT` | |
| `created_by_user_id`, `created_at` | | |

---

## 4. Relationships (text ERD)

```
teams ─< boats ─< sessions ─< runs ─< configs (1:1)
                      │          ├─< datasets        >── analysis-engine (writes)
                      │          ├─< manoeuvre_events
                      │          └── backlog_item (the plan item that drove the run)
                      ├─< videos (clips) ─< clip_notes ──promotes──> backlog_items
                      ├─< photos
                      └─< mast_settings (1:1, rig baseline)

backlog_items ──owner──> users
              ──target_session──> sessions
              ──source_note/run/clip──> (provenance back into the spine)
```

The debrief chain end-to-end: `videos` → `clip_notes` (`t_offset_ms`, `body`) → **promote** → `backlog_items` (`kind='action'`, `owner`, `target_session`) → resolved in a future `run` (`run.backlog_item_id`) → measured by `datasets` / `manoeuvre_events` → distilled into the tuning guide (a *view* over `configs` + `datasets`, not a new table).

---

## 5. Key design decisions (please react to these)

- **D1 — One `backlog_items` table, not three.** Actions, FMEA, and department backlogs share status/owner/provenance; the brief explicitly says "FMEA is just another filtered view." Separate tables would triple the RLS/UI surface for no gain. FMEA's S/O/D/RPN go in `meta` JSONB. *Recommend: unified.*
- **D2 — Per-run `configs`; keep `mast_settings` as the day's rig baseline.** A run's setup can differ from the morning rig snapshot (ballast/cant/toe change run-to-run). Rather than overload the one-per-session `mast_settings`, add `configs` keyed per run. Open question: do you want `mast_settings` retired and folded into a "session baseline config", or kept as-is? *Recommend: keep both for now; revisit once the tuning guide view is built.*
- **D3 — `datasets` is the only analysis-engine surface.** The external engine authenticates with the shared auth layer and writes `kind='analysis-engine'` rows. SSA only reads them. Keeps heavy compute decoupled. Open question: engine writes via a service-role key directly to Supabase, or via an SSA API endpoint that enforces RLS? *Recommend: a dedicated `/api/datasets` endpoint so RLS + audit stay centralised.*
- **D4 — Runs slice, don't copy.** `runs.start_utc/end_utc` window into the existing `sessions.log_data`; we never duplicate log rows. Computed summaries land in `datasets.metrics`.
- **D5 — Single-boat programme keeps `boat_id NOT NULL` everywhere** (simplest RLS). Programme-wide milestones still attach to the one boat.
- **D6 — Manoeuvres auto-seed from the log.** Expedition `tackJibe` events are already parsed into `xmlData`; on import we can auto-create `manoeuvre_events` (`source='log-auto'`), then the coach edits/validates. Saves manual entry.

---

## 6. Build sequence → migrations

Matches the brief's "session object → debrief → plan/backlog → config/tuning":

1. **`0014_runs_configs_datasets.sql`** — `runs`, `configs`, `datasets`; `videos.run_id`; `sessions.conditions/objective`. (The session/run spine.)
2. **`0015_debrief_backlog.sql`** — `clip_notes`, `backlog_items`; the note→action promote link. (The core upgrade.)
3. **`0016_manoeuvre_events.sql`** — `manoeuvre_events` + log auto-seed. (Boathandling measurable.)
4. Tuning-guide *view* + per-department backlog filters: app-layer, no schema change.

Analysis engine runs as a parallel track against `datasets` once `0014` lands.

---

## 7. Open questions for you

1. **One boat only** for the foreseeable campaign, or should the model allow a second hull (affects whether programme/backlog items can be boat-agnostic)?
2. **`mast_settings` fate** — keep as session rig baseline, or migrate into `configs` as a session-level row? (D2)
3. **Analysis-engine write path** — service key vs API endpoint? (D3)
4. **Config trended params** — confirm the fixed typed set (`sail_config, keel_cant_deg, rudder_toe_deg, rake_mm, forestay_mm`) — anything else you chart every session that deserves a column rather than JSON?
5. **FMEA** — are S/O/D/RPN enough, or do you need the full failure-mode/effect/cause/control fields as typed columns (which would argue for splitting FMEA back out)?

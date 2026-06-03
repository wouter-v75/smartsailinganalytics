# SSA v3 — Campaign OS

## What v3 is
v3 turns SSA from a single-team video-analytics tool (v1.2 / v2 baseline)
into a **multi-team campaign operating system**. Workspaces are
genuinely isolated, the Campaign engine is available to every team out of
the box, and the planning side of the work-up — Plan / Regattas / Day /
Backlog — is feature-complete enough to run a multi-month, multi-regatta
season on.

Cut from `main` on **2026-06-XX** (replace with tag date).

---

## Headline features

### Multi-team & workspace isolation
- Admins can create teams from `/admin/teams`. The creator is **automatically granted team_manager** on the new team — no separate "add yourself" step.
- Memberships panel now has **inline role edit** + full role ladder (team_manager · coach · tl3 · tl2 · tl1 · consultant · guest).
- Team managers see only **their team's users** in the membership picker. Adding net-new people goes through Invitations.
- Local IndexedDB / localStorage sessions, videos, log/XML files are **tagged with team_id + boat_id at save time** and filtered on read. Switching workspace via UserPill resets in-memory state and re-loads scoped data.
- Bunny R2 admin-global session listing is now skipped when a workspace is active (was leaking across tenants).

### Campaign engine — generic
- `teams.features.campaign_engine` is now `true` for every team (was Northstar-only).
- Sub-tabs in the canonical order: **Plan · Regattas · Day · Backlog**.
- Boat selector in the Campaign header — Plan is always team-wide (boat chip per session); Day & Backlog scope to a single boat or both.
- Sub-teams: **team_manager, coach, tl3 are implicit members of every active sub-team** — they see all backlog items in the "My sub-teams" filter and can file into any sub-team. SubteamsPanel renders all chips ✓ for these roles automatically.

### Plan
- **Auto-derived "Next Event"** countdown from racing days with an event name set. No more manual target-date field.
- Three counters: **Days to go**, **Training days to go**, **Prep days to go**:
  - Training day = a session with at least one block of type `race-training`, `technical-testing`, or `speed-testing`.
  - Prep day = a session with at least one `dock`/`shed` block AND no on-water activity. Mutually exclusive with training days; no double counting.
- **Multi-select block types** on the "+ Add block" form — creates the day(s) and pre-populates each with one block per picked type.
- **"Day details →"** button on every DayCard jumps to the Day sub-tab on that date.
- Past days hidden in Plan (they live in Day / Videos / Photos history).

### Regattas (new sub-tab)
- **"+ Regatta"** form: date range + name + location (e.g. "Porto Cervo").
- Two-way binding with Plan: writes `sessions.event` + `sessions.location` for every day in the range, auto-creates a racing block if missing.
- **Upcoming regattas** sorted ascending (soonest first); **Past Regattas** in a separate greyed-out section below.
- **Multi-file PDF upload** for NOR / SI / course-notice docs, anchored to the regatta's first day (`session_attachments` with `kind='regatta'`).
- Per-day chips on each regatta card jump straight to the Day tab.

### Day
- View/edit pattern on every editable box (Plan card → Timings above Plan, Debrief notes, Speed-team notes). Content auto-expands; only an explicit Edit button enables editing.
- Speed-team notes gets its own **Documents** section, separate from debrief docs (scoped via `scope` field on each doc entry).
- **What can we test now?** restricted to `venue='on-water'` items, with sub-team filter chips and drag-to-Selected on tablet/desktop, **Plan for today** button on mobile.
- Per-session **Event** input on racing days (regatta name).

### Backlog
- **Me** filter chip (items owned by the current user), inserted before "My sub-teams".
- Boat chip on each item when scope='both boats'.
- "bow" sub-team renamed to **Boathandling**; "Shore" deactivated.
- Venue renamed to **Location** in the UI, **Office** added as an option (DB column stays `venue` for stability).

### Videos (renamed from Library)
- Sidebar folders show **🏁 <Event> Day N** below the date for regatta sessions.
- Workspace-scoped — no cross-team bleed.
- Past days only (future-dated sessions hidden).

### Northstar 7X rollover
- Migrations 0026 + 0027 re-pointed every session on or after 2026-06-01 from Northstar72 → Northstar7X.
- Sessions, videos, photos, all open backlog items, and tag_lists all moved with the boat.

---

## Schema (new migrations in this release)

| # | What it does |
|---|---|
| 0026 / 0027 | Northstar 7X rollover (≥ inclusive cutoff) |
| 0028 | `sessions.event` (regatta name) |
| 0029 | `venue` adds `'office'` |
| 0030 | `features.campaign_engine = true` for every team |
| 0031 | Northstar sub-team vocabulary fixes (bow → Boathandling, deactivate shore) |
| 0032 | `sessions.location` (regatta venue) |
| 0033 | `session_attachments.kind` adds `'regatta'` |

All migrations are idempotent and were applied via the Supabase SQL editor.

---

## Coming back to this version

### Git tag
A signed annotated tag pins v3 in history, separate from any future commits.

```
cd ~/Code/ssa
git tag -a v3.0 -m "SSA v3.0 — Campaign OS (Plan · Regattas · Day · Backlog, multi-team isolation, Northstar 7X rollover)"
git push origin v3.0
```

### Roll back to v3 later
Three paths, in order of safety:

**(a) Browse-only — see the v3 codebase without touching `main`:**
```
git checkout v3.0
# poke around, read, copy files
git switch main
```

**(b) Hot-swap deployment in Vercel** (when you want users to see v3 again immediately, without rewriting history):
1. Vercel dashboard → SSA project → Deployments tab.
2. Filter the list to the commit at `v3.0` (or find the deployment dated around the tag).
3. Click `…` on that deployment → **Promote to Production**. Vercel re-points the production alias to that immutable build in seconds. No rebuild needed.
4. Migrations on Supabase are NOT rolled back by this — if a later migration broke the v3 schema, you'll also need to undo that migration manually.

**(c) Branch from the tag to fork off** (when v3 is the new starting point for a different path):
```
git switch -c v3-recovery v3.0
git push origin v3-recovery
```
Then in Vercel: Project Settings → Git → change Production Branch (or add a Preview branch).

### What `git log v3.0..main` will show
Anything committed after this tag. Useful for spotting what's been added on top — paste that range into a code review prompt before promoting.

---

## Known caveats

- Local IDB / localStorage data created before v3 is **untagged** — it remains in IndexedDB but is hidden everywhere except in legacy "no membership" mode. You can hit "Wipe local cache" in admin to clear it, or re-claim it onto a workspace via a one-time backfill (not built yet).
- HTML5 drag-and-drop on iPad/Android tablets relies on long-press. The checkbox + "Plan for today" button remains the reliable touch path; drag is gated off on phones (`isMobile=true`).
- `regatta-docs-agent.vercel.app` integration is deferred — PDF upload + storage is in place; the agent hand-off button will be wired once the agent's API contract is shared.

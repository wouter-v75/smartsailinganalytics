# The SSA tagger — design philosophy, architecture and build plan

Companion to `docs/tagger-prior-art-2026-09.md`, which is the research this rests
on. That document says what the best teams do; this one says what we are
building and in what order.

Phase selection is explicitly **out of scope here**. KND's phase model is solid
and earns its own tab; it lands after tagging is in place (see *Milestone 7*).

---

# Part 1 — Design philosophy

## 1. Detection proposes, the crew disposes

A day should arrive **already tagged**. Every tack, gybe, start, mark rounding
and leg the data can infer is inferred before anyone opens the day. The crew's
job is to confirm, nudge, reject and add what the detector could not see — the
thing that made the moment matter.

This is the single principle everything else serves. It is also what mature
annotation platforms converged on independently: AI-assisted pre-annotation
"shifts the human task from creation to verification".

The product test: **can a coach review a whole day's tags in sixty seconds?**

## 2. A human edit is never lost

Derivation runs again every time the log, the event file or the detector
changes. It must be impossible for that to undo somebody's work. Concretely:

- a tag a human **moved** keeps its position when the detector re-runs;
- a tag a human **rejected** stays rejected — it does not come back;
- a tag a human **verified** survives even if the detector stops finding it;
- descriptors, notes and authorship are never touched by derivation at all.

SSA has already been bitten by the opposite. `src/lib/localStore.js` carries a
comment explaining that a prefix-matching auto-tag detector "quietly wiped"
manual video tags on every enrich pass, "so tag edits never persisted across
refreshes". That is the bug this principle exists to prevent structurally rather
than by vigilance.

## 3. Identity is ordinal, not temporal

A detection is "**the third tack of race 2**", not "the tack at 13:42:07.412".
Keyed ordinally, a detection survives the detector re-timing it by a second;
keyed temporally, re-timing mints a new row and orphans the old one, and the day
silently accumulates duplicates. (`src/lib/timeline/buildNodes.ts` currently
keys on the millisecond — tracked separately, outside this work.)

## 4. Two levels: category plus descriptors

What happened is a **category** (tack, start, mark rounding). How it went is a
set of **descriptors** (*slow*, *crew error*, *helm: X*, *J2*). This is the elite
standard — Nacsport calls descriptors "adjectives to categories" — and it is what
makes the archive queryable: *every slow tack above 18 knots with the J2 up* is a
question a flat tag list cannot answer.

## 5. Three scopes, one timeline

- **general** — the boat's shared vocabulary.
- **section** — owned by a crew department (afterguard, trim, pit, bow, nav).
  Visible to everyone, appliable by that section.
- **personal** — private to one user. Never exported, never visible to anyone
  else, enforced in the database rather than in the UI.

Gated twice: RLS is the authority, `gating.ts` is the UI's copy so the app never
offers a button the database will refuse.

## 6. Humans press late

Every affordance for placing a tag assumes the operator is behind the action.
Buttons carry **lead and lag time**; the snap searches **backwards** far and
forwards barely. Getting this direction wrong is the difference between a tool
that feels psychic and one that needs correcting after every press.

## 7. The output is a shortlist, not an archive

Coaching guidance for sailing debriefs is to "find a few interesting things from
the day and focus on them". An AC-generation boat produces hundreds of gigabytes a
session and the standing complaint is that no one person can process it in a
night. Nobody needs more data; they need an **index into it**, and a **shortlist
out of it**.

So tagging's deliverable is the **debrief reel** — a small ordered selection that
feeds the Debrief row in `DayPhases` and exports. A timeline with 140 tags and no
shortlist has moved the problem, not solved it.

## 8. A short button bar, and no forced exclusivity

Inter-coder reliability work is blunt about vocabulary design: rare codes are
"doubly disadvantaged" and depress agreement even when coders agree on nearly
every actual occurrence; ambiguity is a property of the behaviour, not a training
failure; and coding units that resist a single category lower agreement.

Therefore the **button bar is curated and short (~8 buttons)** and is a different
object from the full vocabulary behind the picker; multiple tags on one moment
carry no penalty; and two crew tagging the same moment differently is **signal,
not conflict** — the bowman's read and the trimmer's read sit in their own lanes
and both survive. Coder training in the literature is ~3 hours, which caps the
general vocabulary at the order of 20–30 tags.

## 9. Tagging decides what media gets pulled

The shortlist is not only a debrief agenda — it is the **extraction list**. A day
makes far more footage than anyone will upload, so tags decide what becomes a
clip:

- **Starts and mark roundings are always extracted.** They are what a debrief is
  built from every single time, so nobody should have to ask for them.
- **Manoeuvres are not.** A day has sixty tacks and fifty-eight are unremarkable.
  The two worth watching earn their clip by being *tagged*, not by being
  *detected*. `detect.ts:autoExtractable()` encodes exactly this.
- **Anything else is requested.** Any crew member can mark a moment and ask for
  video or a photo of it. A request for the shared debrief needs a coach or admin
  to approve it; a request for the person's own viewing does not, because it is
  their own eyes on footage they already have access to.

This is what keeps the archive from swallowing the signal, and it is why the
tagger is worth building rather than just improving detection.

## 10. Pure libraries, thin components

The existing codebase already works this way — `phaseStats.ts`, `manoeuvres.ts`,
`startAnalysis.ts` are pure, fixture-tested modules with thin React around them.
The merge and snap logic is where correctness lives, so it goes in pure functions
with heavy unit tests, and the components stay dumb.

## 11. Everything leaves the building

`.ssa.json` is canonical and re-importable. The tag half also exports as
**Sportscode XML**, the interchange format Catapult, Wyscout and Dartfish read,
so a visiting analyst can open SSA's tags in the tool they already own.

This is core rather than peripheral because the debrief widens to people who were
not on the boat. F1 sessions debrief trackside and then over video to the factory;
an America's Cup programme feeds telemetry ashore "with the designers and
sailmakers", and the coach's job includes coordinating design, shore and sailing
teams. Export is how that loop closes.

---

# Part 2 — Architecture

## 2.1 The layers

```
┌── UI ────────────────────────────────────────────────────────────┐
│  TagTrack (lanes)   TagButtonBar   TagInspector                  │
│  ReviewQueue        TagFilterBar   TagVocabularyEditor           │
└────────────────────────┬─────────────────────────────────────────┘
                         │  useTags() · useDetections()
┌── Pure libs — src/lib/tagging/ ──────────────────────────────────┐
│  detect.ts   merge.ts   snap.ts   filter.ts                      │
│  gating.ts   baseTags.ts   eventFile.ts   sportscode.ts          │
│  types.ts    sections.ts   (autoPhases.ts → Phases tab)          │
└────────────────────────┬─────────────────────────────────────────┘
                         │  fetch
┌── API — src/app/api/teams/[teamId]/tags/ ────────────────────────┐
│  defs/    events/    events/sync/    event-file/                 │
└────────────────────────┬─────────────────────────────────────────┘
┌── Supabase, RLS-gated ───────────────────────────────────────────┐
│  ssa_tag_defs      ssa_tag_events      memberships.section       │
└──────────────────────────────────────────────────────────────────┘
```

## 2.2 Detection sources

The detector wraps what SSA already has rather than replacing it:

| Detection | Source | Status |
| --- | --- | --- |
| Tacks, gybes | `manoeuvres.ts` — event file first, TWA sign flips above 6 kn as fallback | exists |
| Manoeuvre KPIs | `manoeuvres.ts` — BSP before/after, time-to-95 %, turn angle, distance lost | exists |
| Mark roundings | `xmlEventParse.js` `<markrounding>` | exists, **event file only** |
| Race starts | `xmlEventParse.js` `RaceStartGun` | exists, **event file only** |
| Start quality | `startAnalysis.ts` — distance to line, run-in, OCS bands | exists |
| Mark roundings from log | `detectLegs.ts` — a rounding IS a leg boundary: where the committed point of sail crosses between upwind and downwind | ✅ built |
| Legs | `detectLegs.ts` — point-of-sail run-length encoding with short runs merged away | ✅ built |
| Start from log | distance-to-line zero crossing against `startLines` | deferred — see below |
| On-water comments | Expedition event-file comments, logged one-handed while sailing | **to ingest** |

`detect.ts` exposes one entry point:

```ts
detectDay({ rows, xml, boatId, date }): Detection[]
```

Every `Detection` carries an **ordinal key** (`boat:date:r2:tack:3`), a category
slug, `t0`/`t1`, a `confidence`, and `metrics` from the existing analysers.

## 2.3 The merge model — one table, rules on upsert

Detections are **materialised** as rows in `ssa_tag_events` with
`source = 'auto'` and a `detection_key`; manual tags are rows in the same table
with `detection_key = NULL`. One table, one render path, no join at read time.

The merge is entirely in the upsert rules:

```
syncDetections(day, detections):

  for each detection d:
    row = existing row with detection_key = d.key
    if  no row            → INSERT   source=auto, t0 = auto_t0 = d.t0, verified=false
    elif row.rejected     → SKIP                         ← the tombstone
    else                  → UPDATE, field by field:
                              auto_t0  := d.t0                 (always)
                              t0, t1   := d.t0, d.t1           unless edited
                              slug     := d.slug               unless edited
                              metrics  := d.metrics            (always — derived)
                              confidence := d.confidence       (always)
                              labels, note, verified_*          (never touched)

  for each auto row with no matching detection:
    if verified or edited → KEEP, mark meta.orphaned = true    ← a human vouched for it
    else                  → DELETE                             ← the detector changed its mind
```

Three things make this work:

- **`edited_fields text[]`** on the row is the structured diff. A human moving a
  tag appends `'t0'`; a human relabelling appends `'slug'`. Derivation consults
  it before writing each field. Cheap, legible in `psql`, and exactly the
  "override artefact" idea from the research.
- **`rejected boolean`** is the tombstone, and it lives *on the row* rather than
  in a side table — so a rejected detection can still be listed, explained and
  un-rejected.
- **`auto_t0`** is kept alongside `t0` forever, so the UI can always show "the
  detector put this 4 s earlier" and offer to snap back.

## 2.4 The snap — how a manual tag meets the data

The nudge button the crew presses. Pure, in `snap.ts`:

```ts
snapTag(tag, detections, opts): SnapResult | null
```

```
candidates = detections
    .filter(kind compatible with tag.slug)
    .filter(t0 − backMs ≤ d.t0 ≤ t0 + fwdMs)     // ASYMMETRIC: back 30 s, fwd 5 s
if empty → return null WITH A REASON ("no tack found within 30 s")
score   = kindMatch·w1 + prefersBefore·w2 + d.confidence·w3
Δ       = anchor(best, tag.anchorPref) − tag.t0   // anchor: start | middle | end
apply Δ to t0; range tags move t1 by Δ too (duration preserved),
    unless both edges have their own candidates → snap each edge to a boundary
record  { auto_t0, detection_key, snapped_by, snapped_at }
```

Asymmetry is the load-bearing detail: people press **after** they see something,
so the tag belongs to a detection that already happened. Symmetric "nearest"
snapping pairs tags with events that had not occurred yet.

`snapAll(tags, detections)` does the sequence-wide case as a monotonic dynamic-
programming alignment rather than each tag grabbing its own nearest candidate —
greedy per-tag snapping produces crossings and double-bookings, global alignment
cannot.

Editor conventions carry over because people already know them: a snap radius,
a line showing what is being snapped to, hold-to-suspend, and `[` / `]` to jump
to the previous/next detection.

## 2.5 Schema changes

`ssa_tag_defs` gains:

| Column | Why |
| --- | --- |
| `lead_sec`, `lag_sec` | the window a button captures around the press |
| `label_groups jsonb` | controlled vocabulary for descriptors, `[{group, options[]}]` |
| `lane` | which timeline lane it renders in (defaults from scope/section) |

`ssa_tag_events` gains:

| Column | Why |
| --- | --- |
| `detection_key text` | ordinal identity; NULL for manual tags |
| `auto_t0 timestamptz` | where the detector put it |
| `edited_fields text[]` | the structured diff derivation must respect |
| `verified_by_user_id`, `verified_at` | who vouched for it |
| `rejected bool`, `rejected_reason` | the tombstone |
| `confidence numeric(3,2)` | drives the review queue's ordering |
| `labels jsonb` | applied descriptors, `[{group, text}]` |
| `reel_order int` | position in the day's debrief reel; NULL = not on the reel |

plus a unique index on `(boat_id, session_date, detection_key)`.

Two things about the indexes, both found by running the migration against a real
PostgreSQL rather than reading it (`supabase/tests/0062_tagger_merge.sql`):

- the detection index is **not partial**. `WHERE detection_key IS NOT NULL` reads
  natural — only auto rows have a key — but a partial index can only arbitrate
  `ON CONFLICT` if the statement repeats its predicate, which PostgREST cannot
  express. It is also unnecessary: PostgreSQL treats NULLs as distinct, so manual
  tags are unconstrained anyway.
- the vocabulary index is `NULLS NOT DISTINCT` (PG15+; Supabase runs 17) rather
  than the `COALESCE(...)` expression index it started as — same uniqueness, and
  nameable as a conflict target, which seeding needs.

`confidence` is `NUMERIC(3,2)`, not `REAL`: the review queue thresholds on it,
and float4 cannot hold 0.95 exactly.

A tag is **moved by shifting both endpoints** — writing `t0` alone trips the
`t1 >= t0` window CHECK on a point tag. `merge.ts` will expose `moveTag()` as the
one sanctioned way.

### Requests — `ssa_tag_requests` (migration 0063) ✅

Two kinds, and they behave differently enough that conflating them would be a
mistake:

| | **video** | **debrief** |
| --- | --- | --- |
| means | "pull me that clip" | "let's talk about this tonight" |
| approver | coach / manager / admin **or the media section** — the drone operator is holding the footage | **none** |
| how it closes | someone approves, then fulfils it with an asset | the coach puts the tag on the reel; selection IS the approval |
| who may ask | anyone who sails | anyone who sails |

One request per person per tag per kind, so **the nomination count means
something**: five people asking about the same gybe is the strongest signal a
shortlist has, and it only exists because everyone can nominate.

### Notes and comments — no new table

A personal note is a tag event with `scope='personal'` (0062's RLS already keeps
those private to their owner) and the text in `note`. A team comment is a
general-scoped one whose definition is gated at `min_role: 'tl2'`.

Modelling them as tags rather than their own table means they inherit the day's
segments, the track, the snap, filtering and the export rules for nothing — and a
note can be nominated for the debrief without moving between tables.

One column makes it work: **`ssa_tag_defs.private_by_default`**. "Personal note"
is *shared vocabulary* whose every application is private; without it, a personal
definition would need an owner (0062's scope-shape CHECK) and we would be seeding
one per user per team.

`src/lib/tagging/notes.ts` reads them back for Campaign → Day.

`ssa_phases` moves **out** of `0062` and ships with the Phases tab.

## 2.6 What the crew actually sees

**The day, in segments.** The view is cut into the parts a crew talks in —
**Pre-race · Race 1 · Between races · Race 2 · … · After racing** — with a race
beginning at the **warning signal (the 5-minute gun)**, not the start gun,
because the five minutes before the line is where a race is won. Segments also
supply the ordinal identity every detection is keyed by (§2.3). Expedition
records start guns but no finish, so an inferred finish is marked as inferred
rather than presented as fact. `segments.ts`.

**The track.** Lanes down the day, **detections first and crew tags beneath** —
the order an F1 debrief runs in, data before the subjective account. Race,
Manoeuvres, Sails and On-water comments, then one lane per crew section, then
Mine. Auto tags render hollow until verified, solid after.
Rejected ones are hidden behind a toggle. Drag to move, drag an edge to resize,
`[`/`]` to walk the detections.

**The button bar.** Seven curated buttons, and **not one of them is a racing
moment** — the detector already finds every start, rounding, tack and gybe, so a
button for them is a button nobody presses. The bar is for what the detector
cannot know:

> Personal note · Team comment · Review this · Incident · Gear damage ·
> Sail change · Line-up

Sail change is the one racing moment that earns a place, because a training day
has no event file to detect one from — and it is the trimmer's one press, just as
gear damage is the engineer's. Each carries its own lead/lag. Pressing two
buttons on one moment is normal and costs nothing.

**The inspector.** One tag: its descriptors, its note, *Snap to nearest tack*,
*Verify*, *Reject*, and the provenance line ("detected 13:42:07, moved −4 s by
Wouter").

**The review queue.** The day's unverified auto tags, **lowest confidence
first**. This is the sixty-second flow: the textbook 95° tack with a clean speed
trace needs nobody; the 40° wobble at 5 kn in a gap in the log is what a human
should look at. Semi-automated scoring in sleep medicine beats manual precisely
by letting the expert "focus on difficult or ambiguous segments".

**The debrief reel.** The shortlist. Any tag can be sent to the reel from the
track, the inspector or a button; the reel is ordered, annotated, and is what
feeds `DayPhases` → Debrief and what exports. This is the deliverable of a
tagging session — the five moments worth twenty minutes of the crew's evening,
not the hundred-and-forty the detector found.

**The filter bar.** Category plus descriptors, applied across data, videos and
photos — the payoff for the two-level model.

## 2.7 Where this lands against Njord and KND

Njord automates the timeline well — legs colour-coded, tacks and gybes marked,
races detected with no configuration — but its human layer is *comments*: "your
own on-water comments appear as markers". KND automates phases through
LogCleaner → RaceReplay and is the reference for phase reporting, as a desktop
analyst pipeline.

The step up is not better detection. It is that **a bowman's tag, a coach's tag
and the detector's tack end up on one reconciled timeline** — role- and
section-scoped, with private notes staying private, provenance on every edit, a
review queue that makes verification a minute's work, and an export that opens in
the tools an outside analyst already has.

---

# Part 3 — Build plan

Each milestone ends green: tests pass, `tsc --noEmit` clean, nothing half-wired.

### M0 · Schema — *revise `0062_ssa_tagger.sql`*
- Add the merge and descriptor columns of §2.5.
- Move `ssa_phases` out to the Phases-tab migration.
- Unique index on `detection_key` (plain, not partial — see §2.5).
- Seed endpoint for the base vocabulary (`baseTags.ts`, plus `tag_lists` migration).

**Done:** migration applies clean on a fresh database and is idempotent — both
verified by applying the whole 62-migration chain twice to a throwaway PostgreSQL,
plus `supabase/tests/0062_tagger_merge.sql` asserting the merge guarantees hold.

### M1 · Detection — `segments.ts`, `detect.ts`
- **`segments.ts`** — cut the day into pre-race / race N / between / post-race,
  a race running from the warning signal to its finish (recorded where known,
  inferred and flagged where not). Supplies the ordinal keys. ✅
- Wrap `manoeuvres.ts`, `xmlEventParse.js`, `startAnalysis.ts` behind one
  `detectDay()` returning ordinally-keyed detections with confidence. ✅
- **`detectLegs.ts`** — legs and mark roundings from the log alone, so a training
  day (or a regatta where the onboard assistant was not running) still gets the
  roundings a debrief is always built from. ✅
- Start from the line crossing: **deferred**. `startAnalyses()` is gun-driven and
  the start line itself only exists in the event file, so a log-only start
  detector would serve just the narrow case of a file with `startLines` but no
  `RaceStartGun`. Not worth it before the UI exists.
- Ingest Expedition on-water comments as detections in their own lane — they are
  late and approximate by construction, so they are the prime snap target.
- Fixture tests against the 2026-09-11 Northstar 76 day already used by
  `manoeuvres.fixture.test.ts` and `phaseStats.fixture.test.ts`.

**Done:** a day with no event file still produces tacks, gybes, marks and a
start; and re-running the detector after a timing shift yields the *same keys*,
so a sync updates rather than duplicates.

### M2 · Merge and snap — `merge.ts`, `snap.ts` ✅
The correctness core. Pure functions, exhaustive tests:
- re-derivation preserves a moved tag, a relabelled tag, descriptors and notes;
- a rejected detection stays rejected across three consecutive syncs;
- a verified detection that stops being detected is kept and flagged;
- an unverified one that stops being detected is removed;
- snapping is asymmetric, respects the radius, and reports why it declined;
- `snapAll` is monotonic — no crossings, no double-booking.

**Done:** the merge table in §2.3 is covered case by case (59 tests).

Two things the tests changed. `setTagWindow` normalises a window dragged inside
out rather than trusting the caller's order. And snap ELIGIBILITY is judged on
the detection's own start, not on the anchor — scoring the anchor made
`anchor: 'end'` reject every long detection, which is backwards, since a long
manoeuvre is exactly when you want to aim at its exit. A tag falling *inside* a
detection's window now belongs to it outright.

### M3 · API ✅
- `tags/defs` — GET/POST/PATCH/DELETE plus `POST /seed`. ✅
- `tags/events` — GET (day), POST (one-press apply). ✅
- `tags/events/[eventId]` — PATCH by named operation, DELETE. ✅
- `tags/events/sync` — reconcile posted detections, `dry_run` for a preview. ✅
- `tags/event-file` — `.ssa.json`, `?format=sportscode`, `?reel=1`. ✅
- Every route re-checks `min_role` and section server-side; RLS is the backstop. ✅

Three decisions worth recording:

- **Detection runs on the client, `planSync` runs on the server.** The client
  already holds the day's log and event file and `detectDay` is pure, so it posts
  what it SAW — the same division as `/api/teams/[teamId]/timeline`. But the merge
  rules are the tagger's central promise, and a promise enforced in the browser is
  one anyone can skip by posting their own rows, so the server decides what the
  detections MEAN for the rows that exist.
- **Edits are named operations, not column patches.** `PATCH { op: 'move', … }`
  rather than `PATCH { t0: … }`, because the merge helpers are what record
  `edited_fields` — and a field not claimed there is silently overwritten by the
  next sync.
- **DELETE on a detected tag tombstones it** rather than deleting, so the crew are
  not throwing away the same tack every evening. Hand-placed tags really delete.

**Done:** a day can be tagged, synced and exported entirely over HTTP;
`next build` registers all six routes.

### M4 · The track — `TagTrack`, `TagChip`, `TagInspector`, `TagButtonBar`
- Lanes, drag to move, drag to resize, snap with visual feedback and
  hold-to-suspend, `[`/`]` navigation.
- Buttons honour lead/lag; descriptors picked from `label_groups`.
- Optimistic updates with rollback, matching `cloud-tag-list.ts`'s pattern.

**Done:** a tag can be added, moved, described, snapped, verified and removed
without leaving the day.

### M5 · Review, reel and filter — `ReviewQueue`, `DebriefReel`, `TagFilterBar`
- Queue sorted by confidence, keyboard-driven, bulk verify.
- **Debrief reel**: send-to-reel from track, inspector and buttons; reorder;
  annotate; render into `DayPhases` → Debrief; export as a shareable set.
- Filter bar over category + descriptors, wired into Videos, Photos, Analytics.

**Done:** the sixty-second review is real, a coach can assemble the evening's five
moments in under a minute, and tags filter the media library.

### M6 · Wire in and export
- `DayTimeline` hosts the track; `DayPhases` "Sailing" row gains the tag summary.
- Export buttons; import of a `.ssa.json` from another workspace.
- Update `docs/auth/permissions.md` with the tag rows.

**Done:** the tagger is reachable from the app's main timeline, and a day round-trips.

### M7 · Phases tab — *separate project*
KND-style phase selection as its own tab: select part or all of the track, cut
fixed-length phases, filter out the unsteady ones, feed `computePhaseStats`.
`autoPhases.ts` is already written and tested as groundwork; the table and UI
come with this milestone.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| Detector churn re-timing every tag on each sync | ordinal identity (§2.3), `edited_fields`, and a sync diff preview before writing |
| Descriptors making tagging slow | descriptors optional, applied after the fact in a "label mode"; buttons alone stay one press |
| Lane sprawl on a phone | lanes collapse to a single row under 640 px, with the section colour as the only discriminator |
| Section gating hiding tags people need | sections gate *applying*, never *seeing* — only personal tags are hidden |
| `ssa_tag_events` growth | one row per detection per day, order 10²/day; indexed on (boat, date, t0) |
| Vocabulary sprawl over a season, depressing consistency | button bar capped and curated; the picker shows usage counts; archiving a rarely-used tag is one click for the curator tier |
| A tagged day nobody reviews | the reel is the deliverable, not the timeline; the day is "done" when a reel exists, and that is what the Debrief row shows |
| Media requests piling up unapproved | personal requests need no approval at all; the shared queue shows a count on the Debrief row so it is visible rather than buried |
| An inferred race finish quietly wrong | `endSource` records how each boundary was decided, the UI marks an inferred finish, and a coach can drag it |

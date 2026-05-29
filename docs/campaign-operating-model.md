# SSA Campaign Operating Model — Launch, Reliability & Speed in 2.5 Months

**Status:** draft for review · **Scope:** how SSA becomes the team's operating system for the new-boat work-up — campaign goals, daily planning, windspeed-adaptive test selection, and a single shared backlog filtered by sub-team. Companion to [`campaign-spine-schema.md`](./campaign-spine-schema.md), which defines the data model this rests on.

**The mission this serves:** launch the new boat and get it *tested, reliable, and fast* in roughly 2.5 months across 5 on-water testing sessions. That is a brutally short runway — about one usable test day every two weeks — so the tool's whole job is to make sure no session is wasted and no learning is lost between sessions.

---

## 1. What the best programmes actually do (and what we steal)

America's Cup and F1 teams run on a small number of disciplines that transfer directly to a short work-up. The ideas matter more than the budgets.

**The debrief is the engine, and it runs the *next day*.** America's Cup teams sail, then sit the design and sailing teams down together the following day to scrutinise the data and find gains — most of the data is deliberately held over so the *whole* team analyses selected information together rather than individuals turning it over alone overnight. The lesson for us: the offsite analysis (20:00–23:00) feeds the next morning's speed-team meeting; the loop is *sail → overnight analysis → speed meeting → today's plan*, and the tool has to carry information across that gap.

**Every day on the water exists to answer pre-set questions.** AC testing now centres on *validating the VPP and simulation* — going out to confirm whether the boat hits predicted speeds and angles, not just to sail around. F1 pre-season works the same way: jointly-agreed run plans built around explicit targets (mileage, reliability, aero mapping), with parts and time as hard constraints. Translation: every run we do should be tied to a backlog item / hypothesis, and "did we answer it?" is the unit of progress — not hours sailed.

**Reliability is tested deliberately and early, before speed.** AC programmes stress the structure and systems before chasing performance — "reliability is paramount," and a broken boat tests nothing. With only 5 sessions, an early bias toward shaking out failures (so later sessions are clean speed-testing days) is the highest-leverage sequencing decision we can make. This is where an FMEA-style reliability backlog earns its place.

**One source of truth, many filtered views.** Big teams run mission control with live monitoring and a shared data layer; everyone works the same data set, sliced to their role. We can't build mission control, but we *can* enforce the principle: one prioritised backlog for the whole campaign, filtered to each sub-team — never separate lists that drift apart.

**Condition-driven test plans.** Run plans are built against the conditions the day actually delivers; you don't burn a 20-knot day on a programme that needed 8 knots. So the daily plan must be a *prioritised list that re-sorts by observed wind* — the on-water call is "given it's blowing 14, what's the top unanswered question we *can* answer right now?"

> Sources for these practices are listed at the end.

---

## 2. The operating model in one picture

```
CAMPAIGN  ── goals, milestones, the 2.5-month countdown
   │         "boat reliable by session 3, fast by session 5"
   ▼
BACKLOG   ── ONE prioritised list of everything the boat needs:
   │         reliability (FMEA) items, speed questions, boathandling,
   │         systems/build tasks. Each item: priority, owner, sub-team,
   │         wind-band where it's testable, status.
   ▼
SESSION   ── a test day. Has an objective + a DAY PLAN: the backlog
   │         items chosen for today, ordered.
   ▼
PLAN ⇄ WIND ─ on the water, the plan re-prioritises by observed TWS.
   │          Coach picks the top testable item for current conditions.
   ▼
RUN       ── one test against one item. Produces clips + a data window
   │         (+ config used). "Did we answer the question?" → yes/no.
   ▼
DEBRIEF   ── clip notes → new/closed backlog items → tuning knowledge.
   │         Feeds tonight's offsite analysis → tomorrow's speed meeting.
   └──────────► back up to BACKLOG (the loop closes)
```

The spine doc already gives us `sessions`, `runs`, `configs`, `datasets`, `clip_notes`, `backlog_items`, `manoeuvre_events`. This operating model adds three things on top: a **campaign/goals layer**, a **day-plan + wind-adaptive selection** layer, and **sub-team tagging** so the one backlog filters cleanly. Section 6 lists the concrete schema deltas.

---

## 3. The three layers SSA must provide

### 3.1 Campaign layer — goals & the countdown

A lightweight `campaign` record (or just a typed set of `backlog_items` of `kind='milestone'`, per the spine doc's D1 decision) that holds the handful of programme-level objectives and dates: *first sail*, *reliability sign-off*, *target polars hit*, and the 5 scheduled sessions as milestones. Its only job is to give every backlog item and session a "why" and a deadline to sort against. On a 2.5-month clock, the home screen should always answer: *how many test days left, and which goals are still open?*

### 3.2 Planning layer — the prioritised backlog and the day plan

This is the heart of it and the part that most directly serves "don't waste a session."

**The backlog** is the single prioritised list (§4). Every item carries: priority, owner, **sub-team**, status, a **testable wind band** (e.g. 8–12 kt, or "any"), and item kind (reliability/FMEA, speed, boathandling, systems/build). Items link back to the clip note or run that spawned them (provenance is already in the spine schema).

**The day plan** is a `session`-scoped, ordered selection of backlog items chosen for that test day — built at the 08:00 speed meeting and confirmed at 09:00. It is *not* a copy of the items; it references them, so closing an item in the debrief updates the backlog directly. Each planned item becomes one or more `runs` on the water.

### 3.3 Wind-adaptive selection — the on-water call

The single most useful live feature: a **"what should we test now?" view** that takes the day plan (or the whole backlog) and **re-sorts by current observed TWS**, surfacing only items whose testable wind band includes the current wind, top priority first. SSA already ingests TWS from the Expedition log and overlays it; here we reuse it as the filter key.

Practically: coach opens SSA on the boat, it shows "TWS now ≈ 13 kt" and a ranked shortlist — *"#1: J2 vs J3 crossover (10–14 kt), #2: bear-away load case (any), #3: gybe set timing (12–18 kt)"* — tap one to start logging runs against it. When the breeze shifts to 18, the list re-sorts itself. This is the digital version of the condition-driven run plan, and it's cheap to build because the data (backlog priority + wind band + live TWS) already exists.

---

## 4. The sharing principle: one backlog, filtered by sub-team

This is a hard requirement and it shapes the schema. There is **one global prioritised backlog** for the campaign. Nobody keeps a private list. Every department sees the same items, sorted by the same campaign priority, but **filtered to their sub-team** so a trimmer sees trim/speed items and the boat-build lead sees systems/reliability items — without losing sight that they're all competing for the same scarce test time.

To make that work, two dimensions go onto `memberships` (today it only has an access `role`: coach/tl1/tl2/consultant/guest):

| Dimension | What it is | Example values | Used for |
|---|---|---|---|
| `role` (exists) | **Access level** — what you can see/edit | coach, tl1, tl2, consultant, guest, admin | RLS / permissions (unchanged) |
| `subteam` (NEW) | **Functional area** — which slice of the backlog is "yours" | `speed`, `boathandling`, `systems`, `build`, `design`, `afterguard` | Default backlog filter + ownership routing |

Keeping these orthogonal matters: a person's *access* (can they edit tags / run the AI tools) is a different question from *which work is theirs*. A consultant might sit in the `design` sub-team with read-only access; a coach spans all sub-teams. Backlog items also carry a `subteam` so filtering is a simple match, and items can be re-assigned between sub-teams as understanding sharpens.

Filtered views are app-layer (no schema cost beyond the two columns): "My sub-team's open items," "All P1s across the campaign," "Reliability items still open before session 3," etc.

---

## 5. Fitting the daily rhythm

The tool has to slot into the existing timetable, not replace it. Each block has a clear SSA touchpoint:

| Time | Block | What SSA does here |
|---|---|---|
| **08:00** | Speed team meeting | Review last night's offsite analysis (new `datasets` + clip notes). **Build today's day plan**: pick & order backlog items for the speed sub-team against the forecast. |
| **09:00** | Whole team meeting | Confirm the consolidated day plan across all sub-teams; everyone sees the same prioritised list and today's objective. Surface reliability/build items that gate testing. |
| **10:00–16:00** | Testing & training | **Wind-adaptive selection view** on the boat: pick top testable item for current TWS, log `runs` against it, tag clips live, mark items answered/not. |
| **16:00–19:00** | Post-race data analysis & debrief prep | Sync clips, review against log overlay, draft `clip_notes`, draft the debrief: which questions got answered, what broke, candidate new backlog items. |
| **19:00–20:00** | Debrief | Walk clip notes → promote to backlog items (actions / FMEA / speed questions) → close answered items → set provisional priorities for tomorrow. The note→action chain is first-class in the spine schema. |
| **20:00–23:00** | Offsite data analysis | The analysis engine writes `datasets` (VPP correlation, polars deltas). Output is queued for the 08:00 speed meeting — the loop closes. |

The critical handoffs the tool must not drop: **debrief → tomorrow's plan** (overnight analysis must be visible at 08:00) and **on-water answers → backlog status** (an item tested today shouldn't reappear unmarked tomorrow).

---

## 6. Schema deltas this implies (on top of the spine doc)

Small, additive, and sequenced to fit a 2.5-month build. Detail belongs in the spine doc / migrations; this is the shape:

1. **`memberships.subteam`** (`TEXT`, nullable, CHECK against the value set) + `backlog_items.subteam`. Enables the filtered-but-shared backlog. *Cheapest, highest-leverage — do first.*
2. **`backlog_items` planning fields** — confirm it carries `priority`, `owner_user_id`, `subteam`, `kind`, `status`, and a **`wind_band`** (e.g. `wind_min_kt` / `wind_max_kt`, both nullable = "any"). The wind band is what powers §3.3.
3. **Day plan** — either a `session_plan_items` join table (`session_id` × `backlog_item_id` × `seq`), or a `planned_for_session_id` + `plan_seq` on `backlog_items`. The join table is cleaner if an item can be planned across multiple days; recommend the join table.
4. **Campaign/milestones** — reuse `backlog_items kind='milestone'` (per spine D1) with target dates, rather than a new table, unless a richer `campaigns` row proves necessary.

Everything else (filtered views, the wind-adaptive shortlist, the home-screen countdown) is app-layer with no further schema.

---

## 7. What to build first (sequenced for the runway)

With ~5 sessions, build only what makes the next session less wasteful, in this order:

1. **`memberships.subteam` + `backlog_items` (priority, owner, subteam, kind, status, wind_band).** The shared prioritised backlog is the spine of everything and unblocks every other piece. *(Migration with spine `0015`.)*
2. **Day plan + the 08:00/09:00 planning view.** Lets a session be planned and shared before the boat leaves the dock.
3. **Wind-adaptive selection view on the boat.** Reuses existing TWS ingest; turns the plan into a live on-water call.
4. **Debrief → backlog promotion flow.** The note→action→close loop, so learnings survive between sessions. *(Spine `0015`.)*
5. **Campaign countdown / goals home screen.** Lightweight, motivational, keeps the 2.5-month clock visible.

Reliability/FMEA items live in the same backlog from day one (just `kind='fmea'`), so the early "shake it out before chasing speed" bias is expressed purely through priority, not a separate tool.

---

## 8. Open questions for you

1. **Sub-team value set** — is `speed / boathandling / systems / build / design / afterguard` the right list, or do you carve it differently? (Drives the `CHECK` constraint.)
2. **Day plan model** — join table (item plannable across days) vs. fields on the item (one plan at a time)? I lean join table.
3. **Wind band granularity** — simple min/max kt per item, or named bands (light/medium/fresh/heavy) mapped to ranges? Min/max is more flexible; named bands are faster to set.
4. **Campaign layer** — is `kind='milestone'` backlog items enough, or do you want a first-class `campaigns` record (with the 5 sessions and goal dates as structured children)?
5. **Who owns priority?** Is campaign priority set top-down (coach/afterguard) and sub-teams only filter, or can sub-teams re-rank within their slice? Affects whether priority is one global number or per-subteam.

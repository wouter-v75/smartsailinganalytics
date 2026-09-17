# SSA — Implementation Plan: Design System · One Front-End · Racing Workflows · Conditions→Outcome Moat

_July 2026. A sequenced, incremental engineering plan. No big-bang rewrite: the app stays shippable every week (strangler-fig migration)._

## Ground truth (verified against the repo)

- **Next 14.2.5, React 18, Tailwind 3.4** already installed — but Tailwind is barely used: **29** component files are inline-styled, only **8** use `className`.
- **Missing:** any `src/components/ui` primitive layer, Radix/shadcn, `clsx`/`cva`/`tailwind-merge`, `lucide-react`, a test runner (no Vitest/Jest/Testing-Library), Storybook.
- **Two front-ends:** `SmartSailingAnalytics_UI.jsx` (~7k lines) desktop shell + a separate `MobileShell`.
- Implication: the design-system foundation is close to greenfield **on top of Tailwind that's already wired** — low friction to start.

## Guiding principles

1. **Strangler-fig, never rewrite.** New primitives + screens grow alongside the old; delete old code only once replaced.
2. **One tab at a time, end-to-end**, so each migration is a shippable, reviewable unit.
3. **Tokens first, components second, screens third.** Don't restyle screens before the vocabulary exists.
4. **Every phase leaves the app better even if we stop there.**

---

# Phase 0 — Foundations (guardrails + vocabulary) · ~1 week

Goal: make it *possible* to build consistent, accessible, testable UI. Ship nothing user-visible yet except a component gallery.

**Steps**
1. Add deps: `class-variance-authority clsx tailwind-merge lucide-react @radix-ui/react-dialog @radix-ui/react-select @radix-ui/react-tabs @radix-ui/react-tooltip @radix-ui/react-dropdown-menu`.
2. **Design tokens.** Define CSS variables in `globals.css` (colours, surfaces, text, semantic states: light/standard/heavy/calm, wind/boat/design) and map them into `tailwind.config.js` `theme.extend` (colour, spacing scale, radius, font sizes with a 12px minimum body). Encode the current palette (`#06B6D4`, `#1E3A5A`, …) **once**, here.
3. **`cn()` helper** (`clsx` + `tailwind-merge`) in `src/lib/ui.ts`.
4. **Primitive layer** `src/components/ui/`: `Button`, `Input`, `Select`, `Card`, `Modal/Dialog` (Radix), `Tabs` (Radix), `Table`, `Badge`, `Tooltip`, `Chip`, `Skeleton`, `EmptyState`, `ErrorState`, `Field/Label`. Each with CVA variants, focus-visible rings, 44px min targets, AA contrast.
5. **`<ErrorBoundary>`** wrapper (class component) + a `<TabBoundary>` that shows `ErrorState` instead of white-screening.
6. **Testing harness:** add Vitest + Testing-Library; one smoke test per primitive.
7. **Component gallery:** either Storybook or a lightweight `/dev/ui` route rendering every primitive in all states (fast, no Storybook overhead — recommended to start).
8. **Lint guard:** ESLint rule warning on new `style={{…}}` in `src/components` (allowlist existing files so it only bites *new* code).

**Exit criteria:** `/dev/ui` shows the full kit; a new screen can be built with zero inline styles; tests + lint green.

---

# Phase 1 — One responsive front-end · ~2–3 weeks

Goal: kill the desktop/mobile fork; every screen responsive from a single source.

**Steps**
1. **Extract the shell.** Build `AppShell` = responsive `TopBar` + `SideNav`(desktop)/`BottomOrDrawerNav`(mobile) + content slot, using the Phase-0 primitives and Tailwind breakpoints (`md:`/`lg:`). This replaces the layout logic currently split between the desktop shell and `MobileShell`.
2. **Pick the smallest self-contained tab first — Boat Config** (already `.tsx`, moderate size). Rebuild it inside `AppShell` with primitives; make it responsive; delete its mobile-specific branch. Ship.
3. **Repeat, most-contained → least:** Photos → SailScan → Weather → Analytics → Library (the video library is the hairiest; do it last). Each PR: one tab migrated, its `MobileShell` branch removed.
4. **Retire `MobileShell`** once the last tab is off it. Delete the parallel tree.
5. **Standardise patterns while migrating:** one filter pattern (a `FilterBar` with `Select`/`Chip`), one modal pattern (`Dialog`), one table pattern. The recent sail-name dropdown / sail-tag chips inconsistency gets resolved here.

**De-risk:** feature-flag each migrated tab (`?ui=next`) so you can A/B against the old one before deleting.

**Exit criteria:** no `MobileShell`; every tab responsive; QA on phone + tablet + desktop.

---

# Phase 2 — Sequence around racing workflows · ~2–3 weeks

Goal: reorganise *around jobs-to-be-done* without throwing away the tabs (they become the "advanced/all tools" surface).

**Steps**
1. **Role-based Home.** Replace the default landing with a dashboard that differs by role (sailor / coach / analyst / manager) — "what matters now": next race countdown, latest forecast confidence, unresolved debrief items, sync status. Reuses existing data; new composition only.
2. **Briefing view.** One screen assembling the forecast deck + windweight table + targets + planned sail crossover for the next race day. Mostly a *composition* of existing components + a "Generate briefing" export (you already have the deck + PDF plumbing).
3. **On-water mode.** A stripped, high-contrast, offline-first live screen: big glanceable gauges (reuse the overlay gauge components), current targets, minimal chrome, huge tap targets. This is where accessibility work pays off directly.
4. **Debrief workspace (flagship).** A single **timeline scrubber** that links video + telemetry (log) + photos + mark roundings + conditions for a session. Scrub to a moment → everything syncs. You already have the pieces (video player w/ log sync, photo timestamps, event-file marks, scan conditions windows) — this phase is mostly *wiring them to one shared clock* + a scrubber UI.
5. **Develop view.** Between-events: SailScan trends over time, rig-tune history, target refinement. Reuses SailScan compare (now 6-sail) + rig parser data.
6. Keep the tab bar as "All tools" for power users; Home routes into workflows.

**Exit criteria:** a coach can run pre-race → on-water → debrief without touching the raw tab bar.

---

# Phase 3 — Double down on the conditions→outcome moat · ~3–4 weeks (parallelisable with Phase 2)

Goal: the differentiator no competitor has — *"we set the boat like X in conditions Y; here's whether it worked."*

**Steps**
1. **Canonical join model.** Define a `leg`/`segment` entity (DB + types) that binds, per time window: **conditions** (TWS/TWA/sea state/windweight/gradient) × **settings** (rig, sail, trim from the log + rig-tune) × **outcome** (VMG%, BSP vs target, heel vs target-heel, Δ to fleet if available). One row = one comparable racing moment. This is the schema spine.
2. **Outcome compute layer** (pure TS, testable): the metrics above, plus the two moat joins already scoped in memory — **windweight vs observed heel** (calibration) and **course-gradient (forecast) vs observed gradient (log)**.
3. **Ingest/producer:** on session save, segment the log into legs and populate the join table (extend the existing windweight_samples/MOS producer pattern — you already do hourly sampling).
4. **Analytics surface:** "What worked" views — settings × conditions → outcome, with filtering by sail (reuse the new sail filter), condition band, point of sail. Start descriptive (tables + small-multiples), not ML.
5. **Close the loop:** feed findings back as *recommendations* into Briefing/Targets ("in 12–15 kt with J2 you're fastest at rig setting X"), each carrying **provenance + confidence + sample size** (generalise the forecast-confidence pattern).

**Exit criteria:** a team can answer "were we fast, and why?" from data, per condition band — and that answer flows back into the next briefing.

---

## Cross-cutting (do throughout, not a phase)

- **Trust & provenance chrome:** every derived number gets source + "last updated" + confidence. Add as a primitive (`<MetricValue provenance… confidence…/>`) in Phase 0 so it's free to adopt later.
- **Collaboration primitives:** comments/annotations on video/photos/scans + @mentions + a per-event "learnings" log. Slot into Phase 2 screens.
- **Reliability:** typed data contracts at every fetch boundary; the TDZ-class bugs die with the shell rewrite + tests.
- **Accessibility:** baked into Phase-0 primitives, verified in Phase-2 On-water mode.

---

## Suggested sequencing & parallelisation

```
Wk 1        2   3   4     5   6   7     8   9   10   11
Phase 0 ██
Phase 1     ████████████
Phase 2                   ████████████
Phase 3         ░░░░░░(schema+compute can start early)░░░░░░████████
Cross-cutting ─────────────────── ongoing ───────────────────────
```
- Phase 0 blocks everything visual — do it first, fully.
- Phase 3's **schema + compute layer is pure backend/logic** — a second person can start it during Phase 1/2 since it doesn't depend on the UI system.

## "Start this week" (concrete first 5 PRs)

1. Add deps + tokens in `tailwind.config.js` + `globals.css` + `cn()` helper.
2. `Button`, `Card`, `Dialog`, `Badge`, `Skeleton` primitives + `/dev/ui` gallery.
3. `ErrorBoundary` + `TabBoundary`; wrap each tab mount.
4. Vitest + one test per primitive; ESLint no-new-inline-style guard.
5. Migrate **Boat Config** to `AppShell` + primitives behind `?ui=next` as the reference implementation.

## How we'll know it worked

- Zero inline styles in new code; primitives cover >90% of UI.
- One codebase renders correctly phone→desktop; `MobileShell` deleted.
- A coach completes briefing→on-water→debrief without the raw tab bar.
- The team can query "fast/slow by condition band" and see it feed the next briefing — with confidence + sample size on every claim.

# SSA — Critical UX Review & Path to a Top-Tier Racing App

_July 2026. A candid design/product critique of Shared Sailing Analytics, benchmarked against modern app best practice and the tools elite sailing programs actually use (Sailmon/Vakaros dashboards, North Sails' analysis tooling, RaceQs/Metasail replays, plus general best-in-class product design — Linear, Strava, Whoop, TrainingPeaks)._

---

## The honest headline

SSA is doing something genuinely rare: it fuses **weather modelling, on-water telemetry, video, photos, and sail-shape science** into one place, gated by team role. That breadth is a real moat — most commercial tools own one slice. The risk is the opposite of most apps: not "too thin," but **too much, presented too flatly.** The work now is less about adding features and more about **editing, systematising, and sequencing** what's already there so a busy sailor or coach can move fast and trust the output.

Grade today: **strong engine, first-generation cockpit.**

---

## What's already strong (keep and protect)

- **Depth of real signal.** Windweight, polar %, targets, sea-breeze diagnostics, sail-shape vs design — this is the substance elite teams pay for. Few apps go here.
- **Role-based access** is the right backbone for a squad (sailor / coach / analyst / manager).
- **Sync status pill + offline-aware sync** shows you understand the on-the-water reality (flaky wifi, RIB debriefs).
- **Shareable outputs** (forecast deck, SailScan PDFs) — reports are how analysis becomes influence. This instinct is correct; lean into it.
- **AI search** over the video library is a modern, best-practice pattern (command-driven retrieval).

---

## Where it falls short of best practice

### 1. No design system — the app is hand-styled
Colours (`#06B6D4`, `#1E3A5A`, `#334155`…), spacing, radii, and font sizes are inlined literally across thousands of lines. Consequences: visual drift (two "cards" rarely match), slow iteration, no theming, and accessibility gaps baked in. **Best-in-class teams never do this** — they use design tokens + a component library (shadcn/Radix + Tailwind) so every button, input, modal, and table is consistent and accessible by default. This single change would raise perceived quality more than any feature.

### 2. Two front-ends (desktop shell + MobileShell) drift apart
Maintaining separate mobile/desktop trees means duplicated logic, divergent behaviour, and the class of bugs we hit this week (buttons hidden behind the user pill; a filter added to the desktop sidebar but not mobile). For a racing team, **the tablet/phone IS the primary device** — coach on the RIB, sailor at the dock. A responsive single source of truth is table stakes.

### 3. Density without hierarchy
Screens present everything at once — 8–10px fonts, dense gauge grids, low-contrast greys on dark. Elite dashboards (Whoop, Sailmon) are just as data-rich but use **glanceable hierarchy**: one hero number, supporting metrics, then detail on demand. Right now the eye has no landing point. On the water, with spray and gloves and sunlight, this is the difference between usable and not.

### 4. Inconsistent interaction patterns
Filters are sometimes toggle-chips, sometimes dropdowns; modals differ; the new sail filter is a `<select>` while sail tags are chips. Every inconsistency is a small tax on learning. Pick **one pattern per job** and apply it everywhere.

### 5. Reliability is visible to users
Two runtime crashes this week traced to the same root (referencing state before declaration — TDZ). When analysis tools crash, teams stop trusting the numbers, not just the UI. Guardrails matter: error boundaries per tab, typed data contracts, and skeleton/empty/error states so a failure degrades gracefully instead of white-screening.

### 6. Accessibility & on-water ergonomics
Tiny type, colour-only encoding of class (Light/Heavy/Calm), sub-44px tap targets, unclear focus states. This isn't box-ticking — it's **direct racing performance**: bigger targets and higher contrast mean faster reads in bad conditions.

### 7. Organised by feature, not by job
Nine tabs named after capabilities ("Photos," "Weather," "Library"). But teams think in **moments**: pre-race briefing, on-water, debrief, between-event development. The user has to assemble the workflow in their head every time.

---

## Highest-leverage improvements (in order)

1. **Adopt a design system.** Tokens (colour/space/type/radius) + shadcn/Radix components. Migrate incrementally, starting with buttons, inputs, modals, cards, tables. Biggest quality-per-effort win available.
2. **Collapse to one responsive front-end.** Retire the parallel MobileShell; build breakpoints into shared components. Kills a whole bug class and halves UI maintenance.
3. **Introduce hierarchy + progressive disclosure.** Every screen: hero → supporting → detail-on-demand. Generous whitespace even in dense tools.
4. **Ship robust empty / loading / error states + per-tab error boundaries.** Trust is a feature.
5. **Role-based home dashboards.** A sailor, a coach, and a team manager should land on different "what matters now" views, not the same tab bar.
6. **Standardise one filter/search pattern** and one modal pattern across the app.
7. **Accessibility pass:** min 12px body, 44px targets, WCAG-AA contrast, icon+text (not colour alone), visible focus.

---

## What would make this a top-level app for racing teams

- **A Debrief workspace** — the killer view. One timeline scrubber that links **video + telemetry + photos + marks + conditions**, so you scrub to a moment and see everything at once. This is what RaceQs/Metasail hint at but nobody nails with a team's own boat data + sail shapes.
- **Own the conditions → outcome loop.** You already flagged the moat (windweight vs heel, course-gradient vs observed). The differentiator no competitor has: *"we set the boat like X in conditions Y and here's whether it worked."* Make that the spine of Analytics.
- **Trust & provenance everywhere.** Every derived number carries source + "last updated" + confidence (you started this with forecast confidence — generalise it). Version targets/polars/models so a team knows which truth they're looking at.
- **Collaboration, not just consumption.** Comments, annotations on video/photos/scans, @teammate, a shared "learnings" log per event. Racing is a team sport; the app is currently single-player.
- **Beautiful, effortless reports.** The deck + PDF are the seed. Templated, branded, one-click briefings and debriefs the whole squad actually reads.
- **Ruthless defaults & onboarding.** Sensible defaults, guided first-run per role, contextual tooltips. The person who wins isn't the one with the most features — it's the one whose crew actually uses them by race day.

---

## One-line summary

The science is already elite; the cockpit isn't yet. Invest the next cycle in **systematising the UI (design system + one responsive front-end), sequencing it around real racing workflows (briefing / on-water / debrief), and doubling down on the conditions→outcome moat** — and SSA moves from "impressive internal tool" to "the app a top program can't race without."

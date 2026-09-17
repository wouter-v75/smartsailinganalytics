# Regatta OS — Master spec & build plan

_July 2026. The consolidated spec + sequenced plan to make SSA the world's best shared sailing-analytics app. Supersedes and folds in `ux-review-2026-07.md`, `ux-implementation-plan-2026-07.md`, and `research-debrief-ux-and-ai-2026-07.md`._

---

## 0. North star

> **The whole season is one living, shared timeline.** A team zooms from the season → a regatta → a day → a race → a single moment, where video, telemetry, photos, sail scans, forecast and comments all hang off that moment — and can be asked questions in plain language.

One data spine, three projections (season zoom / vertical day-feed / race scrubber), a collaboration layer, and an AI query layer on top. The moat is not the AI — it's the **proprietary, tri-modally-joined, forecast-integrated corpus** SSA already produces (ICON-Race, windweight, SailScan, rig tunes, logs, event files, video, photos), which no competitor (SailSync, kTool) owns.

---

## 1. The core architecture — the Timeline Tree (the spine)

Everything is a **node** on one time-indexed tree. Structural nodes give the zoom hierarchy; event nodes are what hangs off it.

```ts
type NodeKind =
  // structural (the semantic-zoom hierarchy)
  | 'season' | 'regatta' | 'day' | 'race' | 'leg'
  // events (hang off a day/race)
  | 'plan' | 'weather' | 'meeting' | 'sail_choice' | 'warmup'
  | 'break' | 'post_race' | 'debrief' | 'analysis' | 'note' | 'media'

type Source = 'auto' | 'human' | 'ai'

interface TimelineNode {
  id: string
  boat_id: string
  team_id: string
  parent_id: string | null       // tree edge → children hang off it
  kind: NodeKind
  t0: string; t1: string          // canonical UTC window (structural nodes span children)
  title: string
  subtitle?: string
  source: Source                  // auto = machine, human = crew, ai = generated
  producer: string                // 'icon' | 'eventfile' | 'log' | 'sailscan' | 'riginfo' | 'user' | 'ai'
  refs: {                         // what hangs off this node (all optional)
    videoIds?: string[]; photoIds?: string[]; scanIds?: string[]
    logSegmentId?: string; windweightHour?: string; forecastId?: string
    targetsId?: string; rigTuneId?: string; legId?: string
  }
  metrics?: Record<string, number>  // denormalised for fast query/painting (vmgPct, dHeel, ww, twsAvg…)
  status?: 'live' | 'final'
}
```

**Producers (who creates nodes):**
| Node | Source | Producer (existing SSA plumbing) |
|---|---|---|
| season / regatta / day | auto | from event calendar + session dates |
| weather | auto | ICON-Race forecast + windweight |
| race / leg | auto | event file (SailsUp, marks, start/finish) + log segmentation |
| sail_choice | auto | sail inventory + event-file saillist reconcile |
| warmup / post_race / break | auto | log gaps + geofence + timing |
| meeting / note / debrief | human | crew input |
| analysis | ai | overnight conditions→outcome pass |
| media | human/auto | photo/video upload, auto-timestamped |

Key property: **every node is typed, timestamped, and carries its media + metrics** — which is exactly what makes it (a) navigable by zoom, (b) shareable/commentable, and (c) queryable by AI. The incident-management model (incident.io / PagerDuty) is the proven analog: auto-ingested machine signals + human pins + AI-drafted retrospective, on one timeline.

**Storage:** one `timeline_nodes` table (Supabase/Postgres) + `node_comments`, `node_pins`; media stays in Bunny keyed by node; metrics denormalised onto the node for fast painting and text-to-SQL.

---

## 2. Three projections of the same tree

Same nodes, three renderings — no separate screens, no duplicated logic.

**A. Season semantic-zoom timeline (desktop-first).** One horizontal time axis; a single `d3-zoom` transform. **Semantic zoom** (representation changes with scale, not just size): regatta blocks → days → races → moments. **Container-transform** drill (Motion `layoutId` / FLIP) so the clicked box *expands into* the next level. Persistent focus+context overview strip. Cross-fade at LOD thresholds; springs; virtualize; adaptive axis. (Refs: `research-debrief-ux-and-ai-2026-07.md`; Apple/Google Photos years→months→days; MoTeC i2 comparison lane.)

**B. Vertical day-feed (mobile-first).** The day as a continuous vertical spine (incident.io / Huckleberry / Sunsama pattern): typed nodes top-to-bottom, media/data/comments expand inline (container transform), auto-nodes vs human-nodes visually distinct. This is just the tree filtered to one `day` and laid out vertically. Mobile "zoom" = scroll + tap-to-expand.

**C. Race scrubber (the leaf).** Drilling to a `race`/`leg` opens the **shared-clock scrubber**: one `T` drives video re-framing + gauges + boat-speed trace + photo markers + mark flags + wind-weight band. Every lane reads the race node's canonical UTC window; media auto-sync by timestamp (Njord's model — sub-second align + one-tap offset) so there's no manual scrubbing.

**The composition (the wow):** season → zoom → race → scrubber is **one continuous gesture**; the vertical feed is the same tree projected for mobile. Build once.

---

## 3. Collaboration layer (make review a team activity)

Sailing tools are weak here (mostly file-handoff); this is a differentiator.
- **Comments/threads + @mentions on any node** (post-race "informal chat" is just a node's thread). Feedback lives *on the moment*, not a side channel — Hudl's rule.
- **Pins** — promote a node/moment into the debrief.
- **Playlists** — per-role cuts (bow/trim/helm) auto-assembled from tagged events; the shareable deliverable (Hudl/Catapult model).
- **Real-time** via Supabase Realtime (presence + live comment/pin updates); permissioned by existing RLS roles.
- **Between-race push** of 2–3 annotated clips to crew tablets (Catapult "half-time to the changing room").

---

## 4. Conditions → outcome moat

Bind, per `leg`/`segment` node: **conditions** (TWS/TWA/sea-state/windweight/gradient) × **settings** (rig/sail/trim from log + rig-tune) × **outcome** (VMG%, BSP-vs-target, Δheel, Δ-to-fleet). One row = one comparable racing moment.
- Pure-TS compute layer (testable): outcome metrics + the two joins already scoped — windweight-vs-observed-heel (calibration) and forecast-gradient-vs-observed-gradient.
- Producer runs on session save (extends the windweight/MOS sampling pattern), writes `legs` + denormalises metrics onto race/leg nodes.
- Surfaces as "what worked" views (settings × conditions → outcome), and feeds recommendations back into the plan/briefing node — each with **provenance + confidence + sample size** (generalise the forecast-confidence pattern).

---

## 5. AI query layer (tri-modal, grounded on the tree)

The defensible corner nobody has closed for sailing: **one conversational query grounded jointly in telemetry + semantically-searchable video + sail-photo metrics**, over the team's own sessions, with forecast context. e.g. _"every leg where we were high-and-slow AND the jib looked over-trimmed AND TWS > 12 kt — play the footage."_

Architecture (proven pattern — Bundesliga "Captain" router; F1/AWS NL-over-telemetry; Twelve Labs video RAG):
- **Router** → decomposes the question across three resolvers:
  1. **Text-to-SQL over `timeline_nodes.metrics` + `legs`** (numeric telemetry/conditions/outcome).
  2. **Semantic video search** within the matched nodes' UTC windows (Twelve Labs API or Gemini video; index keyed to node time).
  3. **SailScan photo metrics** (already structured: draft/camber/twist per stripe).
- **Fusion + grounding:** answer cites specific nodes and deep-links to the moment — the AI answer *navigates the tree*. Embeddings (pgvector) over node text + metrics for retrieval.
- **Lead with the JOIN, not the chatbot.** Ship the corpus (§1, §4) first; the chat is the last, thin layer.

Honest caveat (from research): SailSync ships "AI chat" over telemetry+video and kTool fuses telemetry+video+sail-photo. Trial SailSync's FLO before assuming the lane is wide open. Our edge = richer joined substrate + forecast integration + photos as a first-class queryable modality (least-contested corner).

---

## 6. Tech choices

- **App:** keep Next 14 / React 18 / Tailwind / Supabase / Bunny.
- **Design system:** tokens + `src/components/ui` (Radix + CVA + `clsx`/`tailwind-merge` + lucide) — Tailwind is installed but unused (29 inline-styled files vs 8 className); near-greenfield.
- **Timeline:** `d3-zoom` (or `@use-gesture`) driving one time scale; **Motion** (`layout`/`layoutId`) for container-transform expansion; virtualize node lists; canvas fallback only if a level gets dense.
- **Realtime:** Supabase Realtime (presence + comments/pins).
- **Conditions/outcome:** pure-TS compute lib + a `legs` table + producer (extends windweight sampler).
- **AI:** router service; text-to-SQL over Postgres; pgvector for node embeddings; Twelve Labs (or Gemini) for video semantic search keyed to node windows; SailScan metrics already in `sail_scans`.
- **Testing:** Vitest + Testing-Library (currently none) — add in Phase 0.

---

## 7. The build plan (sequenced, strangler-fig, ships weekly)

Revises the earlier plan: the **Timeline Spine subsumes the "workflows" phase** (briefing/on-water/debrief become views on the spine).

**Phase 0 — Design-system foundation (~1 wk).** Deps + tokens + `cn()`; `ui/` primitives (Button/Card/Dialog/Tabs/Table/Badge/Skeleton/EmptyState); `ErrorBoundary`/`TabBoundary`; Vitest; `/dev/ui` gallery; ESLint no-new-inline-style. _Blocks all visual work — do fully first._

**Phase 1 — One responsive front-end (~2–3 wk).** Responsive `AppShell`; migrate tabs one-by-one behind `?ui=next` (Boat Config first, Video Library last); delete each `MobileShell` branch; retire `MobileShell`. Standardise one filter/modal/table pattern.

**Phase 2 — The Timeline Spine (flagship, ~3–4 wk).**
1. `timeline_nodes` schema + RLS + the producers (map existing sources → nodes: event file → race/leg/sail_choice; ICON → weather; log → warmup/segments; SailScan/rig/photos/video → media refs).
2. One shared time-scale + LOD engine.
3. **Projection A** — season semantic-zoom timeline (d3-zoom + Motion container transform + overview strip + virtualization).
4. **Projection C** — race scrubber (the earlier prototype, wired to a race node's window + Njord-style auto-sync).
5. **Projection B** — vertical day-feed (mobile) off the same tree.
6. Compose: zoom → race → scrubber is one gesture.

**Phase 3 — Collaboration (~2 wk).** Comments/@mentions/pins on nodes (Supabase Realtime), per-role playlists, between-race push. Makes the spine a shared object.

**Phase 4 — Conditions→outcome corpus (~3 wk, can start in parallel with 2 — it's backend/logic).** `legs` join + pure-TS compute (incl. windweight-vs-heel, forecast-vs-observed-gradient) + producer + "what worked" views + recommendations into the plan node, all with provenance/confidence.

**Phase 5 — AI query (~3–4 wk).** Node embeddings (pgvector) → router (text-to-SQL + video semantic search + SailScan metrics) → grounded answers that deep-link to nodes. Ship narrow first ("query your metrics + jump to the clip"), widen to full tri-modal.

**Cross-cutting (throughout):** provenance/confidence chrome on every derived number; offline-first on-water mode + a11y (baked into Phase-0 primitives, proven in the mobile feed); reliability (typed data contracts + error boundaries kill the TDZ-class bugs).

```
Wk 1    2   3   4   5   6   7   8   9  10  11  12  13  14  15
P0 ██
P1     ████████████
P2                 ████████████████
P3                                 ████████
P4         ░░░(backend can start early)░░░░░░░░░████████
P5                                                 ████████████
Cross-cutting ───────────────────── ongoing ─────────────────────
```

---

## 8. The "world's best" bar (success criteria)

- **Effortless capture → debrief:** boat's off the water, and the day's spine is already built (weather, races, sail choices, media auto-placed); crew tag/comment, AI drafts the debrief. No manual sync, no format wrangling.
- **One gesture, season → moment:** zoom smoothly from the whole season to a single tack and back; same tree on phone as a vertical feed.
- **Genuinely shared:** multiple crew on one live timeline, feedback on the moment, per-role playlists — not file-handoff.
- **Answers, not dashboards:** "were we fast, and why?" answered per condition band from the team's own joined video+telemetry+sail-shape corpus, feeding the next briefing — with confidence + sample size.
- **The moat is the data, not the demo:** the ICON-forecast-integrated, tri-modally-joined, own-boat corpus that SailSync/kTool can't replicate.

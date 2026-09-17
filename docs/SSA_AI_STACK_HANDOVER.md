# SSA → Best-in-Class Mistral Setup for Yacht Racing Optimisation

*Conversation handover brief. Self-contained — paste into a new Cowork chat to pick up where we left off.*

---

## The goal

Two things, one stack:

1. **Improve summarisation of transcribed audio recordings of yacht racing debriefs.**
2. **Build the world's best AI-query-based yacht racing performance optimisation tool** over the SSA database — expanding beyond the jargon/glossary database, eventually adding an IRC rating database, and deciding how much naval-architecture physics to wire in.

## Hard constraint

**All inference stays inside the Scaleway (EU) account. Nothing to a third-party vendor.** Confirmed as binding. Any recommendation must be satisfiable by Scaleway Generative APIs, or self-hosted on the Mac Studio (M3 Max, 64 GB).

Note: `src/app/api/ai/forecast-summary/route.ts` currently uses Anthropic — the one exception already in the codebase. Flag it if it ever touches debrief content.

## Priorities set for the next ~2 months

1. Debrief summarisation quality
2. NL query over SSA data
3. Physics / VPP grounding

IRC rating database is wanted but explicitly deprioritised.

---

## Current state of the code (as read from `~/Code/ssa`)

| File | What it does |
|---|---|
| `src/lib/debriefAudio.js` | Browser pipeline: lamejs → 16 kHz mono MP3, 300 s chunks, 200-char text tail carried across chunk boundaries |
| `src/app/api/ai/transcribe/route.ts` | Scaleway `whisper-large-v3`, glossary string as prompt bias (~224-token budget), language auto-detect |
| `src/app/api/ai/debrief-summary/route.ts` | `mistral-small-3.2-24b-instruct-2506`, temp 0.2, `response_format: json_object`, `max_tokens: 4000`, three modes (speedteam / debrief / planning) |
| `src/lib/debriefGlossary.ts` | One glossary, two renderings — Whisper bias string + Mistral system block. Includes Dutch→English mappings and a hand-maintained ASR `fixups` list |

**There is no query/RAG layer yet.** No pgvector, no embeddings, no semantic layer. ~40 tables in Supabase (`sessions`, `runs`, `polars`, `mast_settings`, `rig_settings_versions`, `rig_tunes`, `sails`, `sail_scans`, `debriefs`, `manoeuvre_events`, `windweight_*`, `events`, …) across 55 migrations.

**Tell-tale in the code:** `extractJson()` in the debrief-summary route contains truncated-JSON repair logic. That is not a parser edge case — it is the 4000-token ceiling saying the single-shot summary architecture is wrong.

---

## What best-in-class actually does in 2026

**1. Nobody ships naked text-to-SQL.** The dbt 2026 benchmark: raw text-to-SQL 84–90%, semantic layer 98–100% on covered queries. But on multi-hop questions outside the modelled scope, the semantic layer scored **0%** while text-to-SQL got 100%. The winning pattern is a **router** — curated deterministic tools first, sandboxed read-only SQL as the escape hatch, and the system tells you which path it took.

**2. Expose typed tools, not a schema.** The biggest accuracy lever with a 24B model is that the LLM never writes the analysis. It picks a function and fills arguments; Postgres does the maths. The model's job is filling the filter and narrating the result.

**3. Hybrid retrieval, reranked.** tsvector/BM25 over debrief text *plus* pgvector, with structured filters (date, wind band, boat, sail combo) applied as SQL predicates **before** the semantic search, not after.

**4. Evals are a first-class artefact.** A golden set of ~50 real questions with known answers, re-run on every prompt change. This is the whole difference between a demo and something a coach trusts.

**5. Small model + heavy scaffolding beats big model + naive prompt.** Convenient, because Scaleway constrains the model choice anyway.

---

## Part 1 — Debrief pipeline, ranked by leverage

### a) Split the single-shot summary into map → reduce *(do this first)*

Per chunk → extract **atomic structured observations** (claim, topic, conditions, crew, confidence, timestamp). Then reduce those into the written note.

This kills the truncation **and** every observation becomes a queryable row — it is the bridge between goal 1 and goal 2. Highest-leverage change in the whole brief.

### b) Stop fixing ASR at ASR time

Whisper's prompt budget is ~224 tokens and it is already being rationed against the previous chunk's tail. Instead: transcribe raw → run a dedicated **correction pass** with the *full* glossary in Mistral's context (24B handles this trivially) → then summarise. The hand-maintained `fixups` list becomes an eval-derived artefact instead of a manual chore.

### c) Speaker labels

`"Don't guess who said what"` in the current prompt is a workaround for a solvable problem. Voxtral has no integrated diarization and is not GA on Scaleway (still an open feature request), so the sovereign route is **WhisperX + pyannote running locally on the Mac Studio**. Attribution turns "Marc to focus on tactics" from a lucky catch into a reliable field.

### d) One prompt is currently doing four jobs

Translate Dutch→English, repair jargon, structure into sections, and judge relevance. Split them. Code-switched Dutch-with-English-sail-names is the hardest ASR case there is; don't ask one pass to solve it while also writing the note.

### e) Two cheap fixes

- Move `response_format: json_object` → `json_schema` strict mode if the Scaleway endpoint supports it. Deletes `coerce()` and half of `extractJson()`.
- Give the 300 s chunks ~10 s of **audio overlap** with text-level dedup. Hard cuts currently drop words mid-sentence.

### f) Build the eval set before any of the above

10 debriefs, hand-corrected transcripts + ideal notes. Score WER on the transcript and fact-recall / hallucination-rate on the summary. Without it, prompt changes are vibes.

---

## Part 2 — The query layer

The schema is already there. What is missing is a **grain and a normaliser**.

- **The unit of performance is the `run`** (steady-state segment), not the session. Everything joins run → conditions → sail combo → `mast_settings` / `rig_settings_versions` → polar target.
- **Express every metric as polar %.** Without it, wind strength dominates every comparison and the tool learns nothing.
- The questions actually wanted — *"what rig settings were fast in 12–16 kt with chop on the A2?"* — are **not text-to-SQL questions**. They are parameterised similarity search plus a stats aggregation. Build that as one tool:
  `compare(conditions_filter, group_by=setting, metric=polar_pct, min_n=…)` → effect size, confidence interval, n.
- **Never let the model report a difference without n and uncertainty.** The confound warning from `SSA_ML_RESEARCH_REPORT.md` (helm skill / sea state / crew execution / the 2025 winter refit) belongs in the **tool output**, enforced — not in the prompt where the model can ignore it.
- Guardrails: read-only role, statement timeout, row cap, and always surface the filter that was applied.

### Model choice

`mistral-small-3.2-24b` is fine for the mechanical passes but likely underpowered for tool selection and narration over a 40-table schema. Hit `GET {SCALEWAY_AI_BASE_URL}/models` to see what is actually provisioned. If a Mistral Large 3 endpoint is available, use the big model for the **orchestration path only** and keep Small for the mechanical passes.

---

## Part 3 — Physics: yes, in three specific roles

1. **Normaliser (mandatory, do it first).** polar % *is* the VPP already doing work.
2. **Plausibility bounds.** Physics lets the tool flag *"this implies 12% speed from 2 mm of rake — outside physical plausibility, likely a confound."* A guardrail unavailable any other way.
3. **Causal vocabulary as retrieval context.** A short structured doc — forestay sag → jib entry → pointing; rake → helm balance → rudder drag; heel → twin-rudder toe loading. Cheap, and it is what stops a 24B model narrating correlations as physics.

**Do not** run a real VPP inside the query loop. Precompute the polar surface, store it, interpolate.

---

## Part 4 — IRC: real value, wrong order

A different problem with a different value proposition:

- **Rating optimisation** — marginal TCC cost of a bigger A2. Clean optimisation problem, genuinely valuable.
- **Competitor benchmarking** — corrected-time analysis against the fleet.
- **Transfer priors** — boats with similar measurement ratios are a reasonable prior source for 7X settings where 72 data won't carry.

None of it improves the settings model directly. Do it after the query layer works, unless a rating decision is live this season. **Check licensing (RORC / UNCL-owned) before bulk-ingesting certificate data.**

---

## Data-architecture rule that applies to everything

**Store raw channels plus a versioned calibration record; derive computed quantities at query time.**

If any calibration constant changed across the three years of Northstar 72 data — a recalibration, the winter refit, a new navigator — then the archive is not on a consistent basis and every cross-year settings comparison is comparing different metrics. Verify calibration versioning before trusting any cross-year analysis. Anything fitted under an old calibration (polars included) needs refitting.

---

## Recommended order of work

1. **Eval set** (~1 week) — 10 debriefs, hand-corrected transcripts + ideal notes
2. **Split the debrief pipeline** → atomic structured observations
3. **`runs` grain + polar % normalisation + the `compare()` tool**
4. **Physics context doc + plausibility bounds**
5. **IRC**

---

## Sources

- [Semantic Layer vs. Text-to-SQL: 2026 Benchmark Update — dbt](https://docs.getdbt.com/blog/semantic-layer-vs-text-to-sql-2026)
- [Semantic Layer for AI Agents (2026) — Cube](https://cube.dev/articles/semantic-layer-for-ai-agents-2026)
- [Semantic Layer + MCP: The Architecture Behind Trustworthy AI Analytics — Polar](https://www.polaranalytics.com/post/mcp-semantic-layer-ai-analytics)
- [Voxtral — Mistral's Speech-to-Text Model Explained + Whisper Comparison](https://vexascribe.com/voxtral)
- [Voxtral Small/Mini in Generative APIs — Scaleway Feature Requests](https://feature-request.scaleway.com/posts/1140/voxtral-small-and-or-mini-in-generative-apis)
- [Scaleway Generative APIs — supported models](https://www.scaleway.com/en/docs/generative-apis/reference-content/supported-models/)
- [Mistral AI Models 2026: Small 4, Large 3, Voxtral](https://serenitiesai.com/articles/mistral-ai-models-2026-complete-guide)

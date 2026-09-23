# SSA → Best-in-Class Sovereign Sailing Performance Analyst — Architecture & Roadmap

*Unified plan. Reconciles the debrief pipeline on `main`, the query/eval work on branch `ai-sovereign-mistral`, the earlier Cowork handover (`SSA_AI_STACK_HANDOVER.md`), and 2026 best-in-class research. Date: 2026-07-18.*

---

## 0. Where we actually are (reconciliation)

Two complementary workstreams exist, on two branches:

| Workstream | Branch | Files | State |
|---|---|---|---|
| **Debrief transcription + summary** | `main` | `api/ai/transcribe` (whisper-large-v3), `api/ai/debrief-summary` (mistral-small, single-shot), `lib/debriefAudio.js`, `lib/debriefGlossary.ts` | Working; single-shot summary is the weak point |
| **NL query + feedback/eval loop** | `ai-sovereign-mistral` (pushed, **not merged**) | `api/ai/analyze`, `api/ai/feedback`, `api/ai/library-search`, `lib/ai/mistral.ts`, `scripts/ai-eval.mjs`, `evals/`, `ai_query_log` | Working but **naive** (no router/tools/RAG) |

**Two immediate hazards:**
1. **Migration collision** — both branches ship `0055_*`. `main` = `0055_windweight_forecast.sql`, branch = `0055_ai_query_log.sql`. Renumber the branch's to `0056_ai_query_log.sql` before merge.
2. **`forecast-summary` uses Anthropic** — the one non-sovereign exception. Leave it, but it must **never** be fed debrief content. Flagged.

**Hard constraint (binding):** all inference stays inside the **Scaleway EU** account or **self-hosted on the Mac Studio** (M3 Max, 64 GB). No third-party vendor.

**Priorities (next ~2 months):** (1) debrief summarisation quality, (2) NL query over SSA data, (3) physics/VPP grounding. IRC deprioritised.

---

## 1. What "best-in-class" means in 2026 (research synthesis)

From how SailGP/Oracle, Njord/SailLab, SailSync.ai and Kinetix operate, plus the dbt/Cube semantic-layer benchmarks:

1. **A performance analyst sits in every debrief** and *simplifies* the data firehose into a few decisions ([SailGP](https://yachtracing.life/sailgp-teams-crunch-the-numbers-in-search-of-performance-gains/)). Our AI plays that role.
2. **Nobody ships naked text-to-SQL.** Semantic-layer/typed-tool approaches hit 98–100% on covered queries vs 84–90% raw; but the semantic layer scores **0%** off-scope where raw SQL gets 100%. → **Router**: deterministic typed tools first, sandboxed read-only SQL as the escape hatch, and *tell the user which path it took* ([dbt 2026](https://docs.getdbt.com/blog/semantic-layer-vs-text-to-sql-2026)).
3. **Expose typed tools, not a schema.** The 24B model never writes the analysis — it picks a function and fills arguments; Postgres does the maths.
4. **Hybrid retrieval, reranked, with structured pre-filters** (date/wind-band/boat/sail applied as SQL *before* semantic search) ([Supabase pgvector](https://supabase.com/docs/guides/ai/rag-with-permissions)).
5. **Evals are a first-class artefact** — a golden set re-run on every prompt change. The difference between a demo and a tool a coach trusts.
6. **Small model + heavy scaffolding beats big model + naive prompt** — convenient, since Scaleway constrains model choice anyway.
7. **Debriefs follow a structure** — a PEARLS-like arc (react → describe situation → analyse decisions → summarise learnings/actions), moderated, blame-free ([elite-sailing debrief study](https://www.sciencedirect.com/science/article/pii/S1469029225001098)). This is the schema our summariser should target.

---

## 2. Sovereign model inventory (provisioned on the `ssa-ai` project, verified live)

| Role | Model (Scaleway) | Notes |
|---|---|---|
| **Orchestration / router / narration** | `mistral-medium-3.5-128b` | Frontier reasoning+vision; use for the *orchestration path only* |
| **Mechanical passes** (correction, map-extract, summarise) | `mistral-small-3.2-24b-instruct-2506` | Current default; cheap |
| **SQL escape-hatch generation** | `qwen3-coder-30b-a3b-instruct` | Code model, for the read-only SQL fallback |
| **Embeddings (RAG)** | `bge-multilingual-gemma2` | **Multilingual** → handles Dutch+English debriefs |
| **Transcription** | `whisper-large-v3` | Already wired in `transcribe/route.ts` |
| **Vision** (sail scans, invoices) | `mistral-small-3.2-24b` / `pixtral-12b-2409` | — |

**Not available on Scaleway:** no reranker (→ do LLM-rerank or skip), **no Voxtral** (→ diarization must be **WhisperX + pyannote on the Mac Studio**, the sovereign route). Also available if needed: `qwen3-235b`, `qwen3.5-397b`, `llama-3.3-70b`, `glm-5.2`.

---

## 3. Target architecture (two goals, one stack)

```
                          ┌──────────────────────────────────────────┐
  Debrief audio  ──▶ Bunny (EU) ──▶ transcribe (whisper-large-v3, Scaleway)
                          │                    │
                          │        Mac Studio: WhisperX+pyannote (diarization)
                          ▼                    ▼
                   correction pass (mistral-small, full glossary)
                          ▼
              MAP: per-chunk atomic observations ──▶ debrief_observations (rows)
                          ▼                                    │ embed (bge)
              REDUCE: structured debrief note                  ▼
                          │                          ┌── pgvector (HNSW) ──┐
                          ▼                          │  observations       │
                    debriefs / sessions             │  glossary           │
                                                     │  regatta docs       │
  Numeric spine: runs → configs → datasets          │  physics/causal doc │
  → mast_settings/rig_settings_versions → polars    └─────────┬───────────┘
        │  (normalise every metric to polar %)                 │
        ▼                                                       ▼
   ┌─────────────────────── ROUTER (mistral-medium) ──────────────────────┐
   │ typed tools (deterministic)          │  escape hatch (read-only SQL)  │
   │  compare(conditions, group_by, …)    │  qwen3-coder → sandboxed pg    │
   │  get_run_summary / get_polar_targets │  (timeout, row cap, RO role)   │
   │  search_observations (hybrid RAG)    │                                │
   └──────────────────────────┬───────────────────────────────────────────┘
                     answer + figuresUsed + n/CI + confound flags + PATH USED
                                          ▼
                          ai_query_log  ◀── 👍/👎 + coach correction
                                          ▼
                          eval harness (golden sets) — CI gate
```

**Everything downstream of RLS** (per-team/boat), synchronous Scaleway calls (zero-retention), Mac Studio for diarization only.

---

## 4. Data-model additions

| Table | Purpose |
|---|---|
| `debrief_observations` | Atomic, queryable rows from the map step: `{claim, topic, conditions, crew, confidence, ts, session_id, run_id?, embedding}`. **The bridge between goal 1 and goal 2.** |
| `doc_embeddings` | pgvector chunks for glossary + regatta docs + physics/causal doc (hybrid: `tsvector` + `vector`). |
| `calibration_versions` | Versioned calibration record per boat/date — see the data rule below. |
| `ai_query_log` | From the branch (renumber to `0056`). Unifies feedback across all AI surfaces. |

**Grain — CORRECTED 2026-09-23:** this said the unit of performance was the **`run`** (steady-state segment). It is not, and never was: `runs`, `configs`, `datasets` and `manoeuvre_events` were created by `0015`–`0017`, never held a single row, and `0089` drops them. The real grain is the **30 s phase** — `src/lib/phaseStats.ts`, stored per boat and date in `session_phase_stats` (`0060`/`0061`) and validated against the KND SailingPerf report. Everything joins `phase → mode/tack/sailCombo/race → TWS/TWA/heel band → polar target`, with `groupPhases()` as the aggregation. Read `run` as `phase` wherever it appears below. See `docs/ai-query-analysis-2026-09.md` §1.2.

**Normaliser (mandatory, first):** express **every metric as polar %**. Without it, wind strength dominates every comparison and the tool learns nothing.

**Data-architecture rule (applies to everything):** *store raw channels + a versioned calibration record; derive computed quantities at query time.* If any calibration constant changed across the 3 years of Northstar 72 data (recalibration, winter refit, new navigator), the archive is on an inconsistent basis — every cross-year comparison is comparing different metrics, and anything fitted under an old calibration (polars included) needs refitting. **Audit this before trusting cross-year analysis.**

---

## 5. Systemised roadmap (step by step)

Each phase: **Goal · Build · Done-when (eval)**. Order follows the handover, interleaved with the merge + RAG + router dependencies.

### Phase 0 — Reconcile & unify the foundation
- **Build:** Renumber branch migration → `0056_ai_query_log.sql`; merge `ai-sovereign-mistral` into `main`. Collapse `transcribe`, `debrief-summary`, `analyze` onto the **one** client `lib/ai/mistral.ts` (single model-config, one `json_schema`/`mistralJSON` helper, GET `/models` health). Keep `forecast-summary` (Anthropic) isolated.
- **Done-when:** both workstreams on `main`; one AI client; `npm run eval:ai` runs; no dup migration numbers.

### Phase 1 — Eval sets *(do before touching prompts)*
- **Build:** (a) **Debrief eval** — 10 debriefs, hand-corrected transcripts + ideal notes; score **WER** on transcript, **fact-recall + hallucination-rate** on summary. (b) **Query eval** — ~50 real Q→A, extending `evals/ai-analyze/gold.jsonl`.
- **Done-when:** both baselines recorded; every later change is measured, not vibes.

### Phase 2 — Debrief pipeline v2 *(highest leverage)*
- **2a Map→reduce** — per-chunk **atomic structured observations** → reduce into the note. Kills the 4000-token truncation (delete most of `extractJson`) **and** makes each observation a queryable/embeddable row (`debrief_observations`).
- **2b Correction pass** — transcribe raw → dedicated glossary-correction pass with the *full* glossary in `mistral-small` context → then summarise. `fixups` becomes eval-derived, not hand-maintained.
- **2c Split the one-prompt-four-jobs** — translate (NL→EN) / repair jargon / structure / judge relevance become separate passes.
- **2d `json_schema` strict** (if the Scaleway endpoint supports it) → delete `coerce()` + half of `extractJson()`.
- **2e Audio overlap** — ~10 s overlap on the 300 s chunks in `debriefAudio.js` + text-level dedup (stop dropping words at hard cuts).
- **2f Diarization** — WhisperX + pyannote on the **Mac Studio** → speaker labels; retire the "don't guess who said what" workaround.
- **Done-when:** eval shows ↑fact-recall, ↓hallucination, zero truncation; observation rows populate.

### Phase 3 — RAG foundation
- **Build:** enable `pgvector`; embed `debrief_observations` + glossary + regatta docs + physics doc with `bge-multilingual-gemma2`; **HNSW** index; **hybrid** search (`tsvector` + vector) with **structured SQL pre-filters** (date/wind-band/boat/sail) applied *before* semantic search.
- **Done-when:** retrieval eval (recall@k) passes on the golden set.

### Phase 4 — The analyst: router + typed tools
- **Build:** a **router** (mistral-medium) that prefers deterministic **typed tools**, falls back to **sandboxed read-only SQL** (qwen3-coder), and **discloses the path taken**. First tool = `compare(conditions_filter, group_by=setting, metric=polar_pct, min_n)` → **effect size + confidence interval + n**. Others: `get_run_summary`, `get_polar_targets`, `search_observations` (Phase-3 RAG), `query_datasets`. **Guardrails enforced in tool output** (not the prompt): never report a difference without n + uncertainty; always surface the applied filter; read-only role + statement timeout + row cap. Replace the naive `analyze` route with the router; wire `ai_query_log` + 👍/👎 across.
- **Done-when:** query golden-set pass-rate ≥ baseline+; every comparison carries n/CI; path always disclosed.

### Phase 5 — Physics grounding
- **Build:** (1) polar-% normaliser (done in P4) — *the VPP already doing work*. (2) **Plausibility bounds** — flag e.g. "12% speed from 2 mm rake → outside physical plausibility, likely a confound." (3) **Causal-vocabulary doc** as retrieval context (forestay sag → jib entry → pointing; rake → helm balance → rudder drag; heel → twin-rudder toe loading). Precompute the polar surface and interpolate — **do not run a VPP in the query loop**. (4) Execute the **calibration-versioning audit** (§4).
- **Done-when:** plausibility guard catches synthetic implausible claims; calibration basis documented; anything under old calibration flagged for refit.

### Phase 6 — Unify & productionise
- **Build:** one conversational analyst surface (replaces the interim panel) grounded over numeric + observations + docs + fleet; **proactive auto-debrief** per session (transcript + numbers → draft note). CI eval gate; few-shot curation from 👍 rows. **Fine-tune only if the eval plateaus** (it breaks zero-retention — see [[sovereign-ai-scaleway-mistral]]).
- **Done-when:** KPIs move (below); coach trusts it unprompted.

### Phase 7 — IRC *(later; deprioritised)*
Rating optimisation (marginal TCC of a bigger A2), competitor corrected-time benchmarking, transfer priors from similar-ratio boats. **Check RORC/UNCL licensing before bulk-ingesting certificate data.**

---

## 6. Sovereignty, privacy & guardrails
- **Inference:** Scaleway EU (synchronous → zero-retention) or Mac Studio. `forecast-summary` (Anthropic) is the lone exception — keep debrief content out of it.
- **GDPR — voice is personal data.** Recording team debriefs captures identifiable voices → needs **explicit consent + a retention policy + access control**. Store audio in Bunny (EU); define how long transcripts/recordings live. Decide before scaling Phase 2f.
- **Isolation:** every tool RLS-scoped by team/boat; read-only DB role for the SQL escape hatch.

## 7. Cost (indicative, per team/month — trivial)
Transcription `whisper-large-v3` on Scaleway + embeddings (`bge`) + chat (small/medium) all pay-per-use in the single-digit-euro range at team volume; diarization on the Mac Studio is free compute. Well inside the ~€100/mo envelope.

## 8. Success metrics
Coach 👍-rate on debrief notes and query answers; eval pass-rate trend; hallucination-rate ↓; time-to-debrief ↓; % answers via deterministic tool vs SQL fallback; adoption per campaign.

## 9. Open decisions (need your call)
1. **Orchestration model:** `mistral-medium-3.5-128b` (recommended) vs `qwen3-235b`/`qwen3.5-397b`.
2. **Mac Studio for diarization** (WhisperX+pyannote) — confirm it's the sovereign home for that.
3. **Merge branch now** (with the `0056` renumber) or keep query work isolated until the router lands?
4. **Calibration-versioning audit** — is there a versioned calibration record across the 3 years, or is cross-year analysis currently unsafe?
5. **Debrief recording consent/retention policy** — needed before Phase 2 scales.

## 10. Sources
SailGP analyst workflow ([Yacht Racing Life](https://yachtracing.life/sailgp-teams-crunch-the-numbers-in-search-of-performance-gains/)) · elite-sailing debrief structure ([ScienceDirect](https://www.sciencedirect.com/science/article/pii/S1469029225001098)) · SailLab/Njord ([sailnjord](https://www.sailnjord.com/analytics/)) · SailSync.ai · Kinetix ([Sailing World](https://www.sailingworld.com/racing/sailing-performance-analysis-with-kinetix/)) · dbt semantic-layer-vs-text-to-SQL 2026 ([dbt](https://docs.getdbt.com/blog/semantic-layer-vs-text-to-sql-2026)) · Supabase pgvector RAG ([Supabase](https://supabase.com/docs/guides/ai/rag-with-permissions)) · Scaleway supported models ([Scaleway](https://www.scaleway.com/en/docs/generative-apis/reference-content/supported-models/)) · plus the earlier `SSA_AI_STACK_HANDOVER.md` and `SSA_ML_RESEARCH_REPORT.md`.

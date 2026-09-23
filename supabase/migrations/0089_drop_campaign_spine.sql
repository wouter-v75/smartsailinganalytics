-- ============================================================================
-- SSA — 0089  drop the campaign spine: runs, configs, datasets, manoeuvre_events
--
-- 0015 laid down a spine where the unit of performance was the RUN — a named
-- line-up or test — with configs and datasets hanging off it and manoeuvre_events
-- beside it. Nothing was ever written to any of them.
--
-- What actually got built instead is the 30 s PHASE: src/lib/phaseStats.ts,
-- stored per boat and date in session_phase_stats (0060/0061), validated against
-- the KND SailingPerf report. That is the grain the Analytics tab, the report
-- tables, the season curves and the Ask box all work on. Two competing answers to
-- "what is the unit of performance" is one too many, and only one of them has
-- ever held a row.
--
-- Verified empty and unreferenced before dropping (2026-09-23):
--   runs 0 rows · configs 0 · datasets 0 · manoeuvre_events 0
--   zero references in src/ — the only mention anywhere was `run_id` inside one
--   SELECT string in api/teams/[teamId]/sail-scans/route.ts, consumed by nobody,
--   removed in the same commit.
--   backlog_items, backlog_subtasks and session_plan_items — the other holders of
--   a run FK — were already gone; an earlier clean-up took them.
--
-- The two run_id columns on tables that ARE alive (videos, sail_scans) can only
-- ever be NULL: runs is empty and the foreign key is enforced, so no value could
-- exist. Dropping them loses nothing.
--
-- NOT `CASCADE`, deliberately. If something still depends on one of these, this
-- migration should fail and say so rather than quietly taking that something
-- with it.
--
-- Docs updated alongside: docs/campaign-spine-schema.md,
-- docs/ai-analyst-roadmap-2026-07.md (§4 named the run as the grain).
--
-- IRREVERSIBLE, and that is the point. Idempotent. Run after 0088.
-- ============================================================================

-- ── Let go of runs from the tables that outlived it ─────────────────────────
ALTER TABLE public.videos     DROP COLUMN IF EXISTS run_id;
ALTER TABLE public.sail_scans DROP COLUMN IF EXISTS run_id;

-- ── Then the spine itself, dependants first ─────────────────────────────────
DROP TABLE IF EXISTS public.manoeuvre_events;
DROP TABLE IF EXISTS public.datasets;
DROP TABLE IF EXISTS public.configs;
DROP TABLE IF EXISTS public.runs;

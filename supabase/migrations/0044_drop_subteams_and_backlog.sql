-- ============================================================================
-- SSA — retire the sub-teams and backlog features.
--
-- The backlog/plan task surfaces were pruned from the app (the Campaign tab now
-- exposes only Regattas + Day). Sub-teams existed only to organise the backlog,
-- so with the backlog gone they are redundant. This migration drops the whole
-- lot. CASCADE also removes their RLS policies, indexes, triggers, and any
-- foreign-key constraints pointing at them from surviving tables (e.g.
-- clip_notes.backlog_item_id, debriefs.promoted_to_id) — those columns remain
-- but simply hold no references anymore.
--
-- Order: drop children before parents so CASCADE has less to do (harmless
-- either way — IF EXISTS + CASCADE make this idempotent and re-runnable).
-- ============================================================================

DROP TABLE IF EXISTS public.backlog_subtasks   CASCADE;
DROP TABLE IF EXISTS public.session_plan_items CASCADE;
DROP TABLE IF EXISTS public.backlog_items      CASCADE;
DROP TABLE IF EXISTS public.membership_subteams CASCADE;
DROP TABLE IF EXISTS public.subteams            CASCADE;

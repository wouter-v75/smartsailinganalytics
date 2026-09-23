-- ============================================================================
-- SSA — 0087  ai_query_log: every question asked of an AI surface
--
-- ONE log for all of them, which is what docs/ai-analyst-roadmap-2026-07.md asks
-- for. `route` says which surface produced the row ('ask' for the Analysis tab's
-- Ask box, 'analyze' for the older branch route).
--
-- ⚠ THIS TABLE MAY ALREADY EXIST. The unmerged branch `ai-sovereign-mistral`
-- ships 0055_ai_query_log.sql, and its table is live on the remote database even
-- though that migration was never recorded as applied — a first attempt at this
-- migration failed on exactly that (relation already exists, then "column
-- session_date does not exist"). So this migration ADOPTS what is there and adds
-- what is missing, rather than assuming a clean slate. Both paths — a fresh
-- database and one already carrying the 0055 table — converge on the same shape.
--
-- It deliberately keeps 0055's vocabulary where the two overlap: `rating` /
-- `correction` / `rated_by` / `rated_at` for the thumbs, `latency_ms` for the
-- timing. Two names for one thing across two AI surfaces is the mess this is
-- avoiding, and it means the branch's own feedback route still works if it
-- merges (its CREATE TABLE IF NOT EXISTS then no-ops).
--
-- What the log is FOR, in order of how much it matters:
--   1. The eval set. The golden set should be the questions people REALLY ask,
--      not the ones we imagined — so log first and write the eval from what
--      turns up.
--   2. Curating few-shot examples from the 👍 rows, which is how this improves
--      without fine-tuning and without breaking Scaleway's zero-retention.
--   3. Telling a bad tool call apart from a bad sentence after the fact:
--      `steps` holds the resolved arguments, separately from the prose.
--
-- Privacy: the question, the answer and the RESOLVED ARGUMENTS — never the rows
-- the tools read. Those already live in session_phase_stats and sessions.
--
-- Derived/append-only. Dropping it costs the eval history and nothing else.
--
-- Additive, idempotent. Run after 0086.
-- ============================================================================

-- ── The table, in 0055's shape, for a database that does not have it ─────────
CREATE TABLE IF NOT EXISTS public.ai_query_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id         UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id         UUID REFERENCES public.boats(id) ON DELETE SET NULL,
    user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

    route           TEXT NOT NULL DEFAULT 'analyze',
    model           TEXT NOT NULL,
    question        TEXT NOT NULL,
    answer          JSONB,
    context_summary JSONB,

    input_tokens    INTEGER,
    output_tokens   INTEGER,
    latency_ms      INTEGER,

    rating          SMALLINT CHECK (rating IN (-1, 1)),
    correction      TEXT,
    rated_by        UUID REFERENCES public.users(id) ON DELETE SET NULL,
    rated_at        TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── What the Ask box adds ────────────────────────────────────────────────────
ALTER TABLE public.ai_query_log
    -- The day that was open when the question was asked. The question may range
    -- wider (a season comparison); this is the day it was asked FROM, and it is
    -- what the read policy is checked against.
    ADD COLUMN IF NOT EXISTS session_date DATE,
    -- [{ tool, args, tokens, rows, media }] — the resolved calls, not the prose.
    ADD COLUMN IF NOT EXISTS steps        JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- { level, before: [...], after: [...] } from lib/ai/askRisk.
    ADD COLUMN IF NOT EXISTS risk         JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- False means the answer was written without reading the boat's data at all.
    ADD COLUMN IF NOT EXISTS used_tools   BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT now();

-- session_date carries the read policy, so it must not be null — but only the
-- 'ask' route writes it, and NOT NULL cannot be asserted over rows that predate
-- it. Set it when the table can take it, and say so plainly when it cannot,
-- rather than failing the migration or silently leaving the column optional.
DO $$
DECLARE missing BIGINT;
BEGIN
    SELECT count(*) INTO missing FROM public.ai_query_log WHERE session_date IS NULL;
    IF missing = 0 THEN
        ALTER TABLE public.ai_query_log ALTER COLUMN session_date SET NOT NULL;
    ELSE
        RAISE NOTICE 'ai_query_log: % row(s) have no session_date, leaving the column nullable; those rows are readable by their author only', missing;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_query_log_boat_day_idx
    ON public.ai_query_log(team_id, boat_id, session_date DESC);
CREATE INDEX IF NOT EXISTS ai_query_log_team_created_idx
    ON public.ai_query_log(team_id, created_at DESC);
-- The curation query: the rows somebody blessed, newest first.
CREATE INDEX IF NOT EXISTS ai_query_log_rating_idx
    ON public.ai_query_log(team_id, rating, created_at DESC)
    WHERE rating IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_query_log_user_idx
    ON public.ai_query_log(user_id);

DROP TRIGGER IF EXISTS ai_query_log_touch ON public.ai_query_log;
CREATE TRIGGER ai_query_log_touch BEFORE UPDATE ON public.ai_query_log
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.ai_query_log ENABLE ROW LEVEL SECURITY;

-- ── Read follows the DAY, as it does for every other derived table ───────────
-- 0055 let any coach or team manager read the whole team's log, for curation.
-- This narrows that to the day: a question is about a day, and somebody who may
-- not see that day should not read a question that quotes its numbers back. You
-- always see your own questions, whatever happens to your access to the day
-- afterwards. Curation across a team is a service-key job in a script, not
-- something that needs to be reachable from a browser.
DROP POLICY IF EXISTS ai_query_log_select ON public.ai_query_log;
CREATE POLICY ai_query_log_select ON public.ai_query_log
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR user_id = auth.uid()
        OR (session_date IS NOT NULL AND boat_id IS NOT NULL
            AND public.has_boat_access_dated(team_id, boat_id, session_date))
    );

-- Only your own questions, and only for a day you can read: the row records who
-- asked, so writing one as somebody else would put words in their mouth.
DROP POLICY IF EXISTS ai_query_log_insert ON public.ai_query_log;
CREATE POLICY ai_query_log_insert ON public.ai_query_log
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND (
            public.is_admin()
            OR (session_date IS NOT NULL AND boat_id IS NOT NULL
                AND public.has_boat_access_dated(team_id, boat_id, session_date))
            OR public.is_team_member(team_id)
        )
    );

-- The thumbs. Your own row only — one person's verdict is not another's.
DROP POLICY IF EXISTS ai_query_log_update ON public.ai_query_log;
CREATE POLICY ai_query_log_update ON public.ai_query_log
    FOR UPDATE TO authenticated
    USING (public.is_admin() OR user_id = auth.uid())
    WITH CHECK (public.is_admin() OR user_id = auth.uid());

DROP POLICY IF EXISTS ai_query_log_delete ON public.ai_query_log;
CREATE POLICY ai_query_log_delete ON public.ai_query_log
    FOR DELETE TO authenticated
    USING (public.is_admin() OR user_id = auth.uid()
           OR public.has_team_role(team_id, ARRAY['team_manager']));

-- ============================================================================
-- SSA — 0087  ai_query_log: every question asked of the Analysis tab's Ask box
--
-- One row per question, with the tool calls it resolved to, the answer that
-- survived the number check, the risk findings, and the crew's 👍/👎.
--
-- It exists for three jobs, in order of how much they matter:
--   1. The eval set. The golden set for this feature should be the questions
--      people REALLY ask, not the ones we imagined — which means logging first
--      and writing the eval from what turns up.
--   2. Curating few-shot examples from 👍 rows (see docs/ai-analyst-roadmap-2026-07.md
--      §6), which is how this improves without fine-tuning and without breaking
--      Scaleway's zero-retention.
--   3. Telling whether a bad answer was a bad tool call or a bad sentence —
--      `steps` holds the resolved arguments, so the two are separable after the fact.
--
-- Read access follows the day, like session_phase_stats: a question about a day
-- is only visible to people who may see that day. A person may always update
-- their OWN row, which is how the thumbs get recorded.
--
-- Derived/append-only. Nothing here is a source of truth; dropping the table
-- costs the eval history and nothing else.
--
-- Additive, idempotent. Run after 0086.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_query_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id       UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    boat_id       UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,
    -- The day that was open when the question was asked. The question may range
    -- wider (a season comparison); this is the day it was asked FROM, and it is
    -- what the read policy is checked against.
    session_date  DATE NOT NULL,
    user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

    question      TEXT NOT NULL,
    -- { lines: [], bottomLine: [], dropped: [], suggestions: [] }
    answer        JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- [{ tool, args, tokens, rows, media }] — the resolved calls, not the prose.
    steps         JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- { level, before: [...], after: [...] } from lib/ai/askRisk.
    risk          JSONB NOT NULL DEFAULT '{}'::jsonb,
    model         TEXT,
    ms            INTEGER,
    used_tools    BOOLEAN NOT NULL DEFAULT FALSE,

    -- 1 = useful, -1 = not. NULL = nobody said.
    verdict       SMALLINT CHECK (verdict IS NULL OR verdict IN (-1, 1)),
    verdict_note  TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_query_log_boat_day_idx
    ON public.ai_query_log(team_id, boat_id, session_date DESC);
-- The curation query: the rows somebody blessed, newest first.
CREATE INDEX IF NOT EXISTS ai_query_log_verdict_idx
    ON public.ai_query_log(team_id, verdict, created_at DESC)
    WHERE verdict IS NOT NULL;

DROP TRIGGER IF EXISTS ai_query_log_touch ON public.ai_query_log;
CREATE TRIGGER ai_query_log_touch BEFORE UPDATE ON public.ai_query_log
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.ai_query_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_query_log_select ON public.ai_query_log;
CREATE POLICY ai_query_log_select ON public.ai_query_log
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access_dated(team_id, boat_id, session_date));

-- Only your own questions, and only for a day you can read: the row records who
-- asked, so writing one as somebody else would put words in their mouth.
DROP POLICY IF EXISTS ai_query_log_insert ON public.ai_query_log;
CREATE POLICY ai_query_log_insert ON public.ai_query_log
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND (public.is_admin() OR public.has_boat_access_dated(team_id, boat_id, session_date))
    );

-- The thumbs. Your own row only — one person's verdict is not another's.
DROP POLICY IF EXISTS ai_query_log_update ON public.ai_query_log;
CREATE POLICY ai_query_log_update ON public.ai_query_log
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS ai_query_log_delete ON public.ai_query_log;
CREATE POLICY ai_query_log_delete ON public.ai_query_log
    FOR DELETE TO authenticated
    USING (public.is_admin() OR user_id = auth.uid());

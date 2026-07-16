-- ============================================================================
-- SSA — AI query log (the feedback + eval loop).
--
-- One row per answered /api/ai/analyze question. This is the substrate for
-- "getting better over time" WITHOUT fine-tuning:
--   • thumbs up/down + a coach's ideal correction turn the log into a curated
--     dataset of (question → good answer) pairs.
--   • the best thumbs-up rows are hand-promoted into ANALYZE_FEWSHOT.
--   • `npm run eval:ai` measures whether prompt/few-shot changes actually help.
--   • if a real plateau appears, the same rows become fine-tuning data.
--
-- Privacy by design: we store the QUESTION and the ANSWER, but NOT the raw team
-- rows the model saw — only a lean `context_summary` (counts + row ids). The
-- source rows already live in datasets/configs; we don't duplicate them. This
-- keeps the log small and stores the minimum, in line with the zero-retention
-- posture at the inference layer. All rows live in OUR Supabase under RLS —
-- nothing about the feedback loop leaves the app.
--
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_query_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  boat_id         UUID REFERENCES public.boats(id) ON DELETE SET NULL,
  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  route           TEXT NOT NULL DEFAULT 'analyze',   -- which AI feature produced it
  model           TEXT NOT NULL,                     -- e.g. mistral-small-3.2-24b-instruct-2506
  question        TEXT NOT NULL,
  answer          JSONB,                             -- { answer, figuresUsed, caveats }
  context_summary JSONB,                             -- { datasets:n, configs:n, dataset_ids:[…], … } — NOT the rows

  input_tokens    INTEGER,
  output_tokens   INTEGER,
  latency_ms      INTEGER,

  -- feedback, filled later via POST /api/ai/feedback ---------------------------
  rating          SMALLINT CHECK (rating IN (-1, 1)),  -- +1 up, -1 down, NULL = unrated
  correction      TEXT,                                -- a coach's ideal/corrected answer
  rated_by        UUID REFERENCES public.users(id) ON DELETE SET NULL,
  rated_at        TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Review newest-first per team; curate few-shot from rated rows.
CREATE INDEX IF NOT EXISTS ai_query_log_team_created_idx
  ON public.ai_query_log (team_id, created_at DESC);
-- Fast pull of the training/few-shot candidates (only the rated rows).
CREATE INDEX IF NOT EXISTS ai_query_log_rating_idx
  ON public.ai_query_log (team_id, rating)
  WHERE rating IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_query_log_user_idx
  ON public.ai_query_log (user_id);

ALTER TABLE public.ai_query_log ENABLE ROW LEVEL SECURITY;

-- SELECT: the author sees their own queries; coaches/managers see the whole
-- team's log so they can curate. Admin sees all.
DROP POLICY IF EXISTS ai_query_log_select ON public.ai_query_log;
CREATE POLICY ai_query_log_select ON public.ai_query_log
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR user_id = auth.uid()
    OR public.has_team_role(team_id, ARRAY['coach','team_manager'])
  );

-- INSERT: the route writes as the calling user — a user may only log their own
-- query, and only for a team they belong to. (Best-effort in the route.)
DROP POLICY IF EXISTS ai_query_log_insert ON public.ai_query_log;
CREATE POLICY ai_query_log_insert ON public.ai_query_log
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR (user_id = auth.uid() AND public.is_team_member(team_id))
  );

-- UPDATE (rate / correct): the author can rate their own; coaches/managers can
-- rate or correct any of the team's rows.
DROP POLICY IF EXISTS ai_query_log_update ON public.ai_query_log;
CREATE POLICY ai_query_log_update ON public.ai_query_log
  FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR user_id = auth.uid()
    OR public.has_team_role(team_id, ARRAY['coach','team_manager'])
  )
  WITH CHECK (
    public.is_admin()
    OR user_id = auth.uid()
    OR public.has_team_role(team_id, ARRAY['coach','team_manager'])
  );

-- DELETE: managers/admin only (housekeeping).
DROP POLICY IF EXISTS ai_query_log_delete ON public.ai_query_log;
CREATE POLICY ai_query_log_delete ON public.ai_query_log
  FOR DELETE TO authenticated
  USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager']));

-- ============================================================================
-- SSA Campaign Engine — 0018 day blocks + completion / loop-closing
--
--   • session_blocks    — multiple typed blocks per day (technical-testing /
--                         speed-testing / race-training / other), each with its
--                         own time window + objective. The calendar colours by
--                         these; the day plan groups items under them.
--   • session_plan_items.block_id, runs.block_id — attach plan items + runs to
--                         a block (nullable = day-level / unassigned).
--   • backlog_items completion model:
--        completion       'binary' | 'progress'
--        answer_state     'unanswered' | 'partial' | 'answered'  (binary loop)
--        answered_*       provenance: the run / clip-note / session that settled it
--        progress_pct     0..100 manual confidence gauge (progress goals)
--   • backlog_subtasks  — checklist rows for goals (gauge can later derive % from
--                         these or from evidence; manual confidence for now).
--
-- RLS matches 0003. Idempotent. Run after 0017.
-- ============================================================================

-- ── session_blocks — intra-day typed blocks ──────────────────────────────────
-- start_min / end_min are minutes from local midnight (avoids TZ ambiguity for
-- a planning grid; the session already carries tz_offset_minutes for display).
CREATE TABLE IF NOT EXISTS public.session_blocks (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id         UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm
    block_type         TEXT NOT NULL
                       CHECK (block_type IN
                              ('technical-testing','speed-testing','race-training','other')),
    label              TEXT,
    seq                INTEGER NOT NULL DEFAULT 0,
    start_min          INTEGER,   -- minutes from local midnight (nullable)
    end_min            INTEGER,
    objective          TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_blocks_session_idx   ON public.session_blocks(session_id, seq);
CREATE INDEX IF NOT EXISTS session_blocks_team_boat_idx ON public.session_blocks(team_id, boat_id);

-- ── attach plan items + runs to a block ──────────────────────────────────────
ALTER TABLE public.session_plan_items
    ADD COLUMN IF NOT EXISTS block_id UUID REFERENCES public.session_blocks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS plan_items_block_idx ON public.session_plan_items(block_id);

ALTER TABLE public.runs
    ADD COLUMN IF NOT EXISTS block_id UUID REFERENCES public.session_blocks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS runs_block_idx ON public.runs(block_id);

-- ── backlog_items — completion / loop-closing model ──────────────────────────
ALTER TABLE public.backlog_items
    ADD COLUMN IF NOT EXISTS completion          TEXT NOT NULL DEFAULT 'binary',
    ADD COLUMN IF NOT EXISTS answer_state        TEXT NOT NULL DEFAULT 'unanswered',
    ADD COLUMN IF NOT EXISTS answered_run_id     UUID,
    ADD COLUMN IF NOT EXISTS answered_note_id    UUID,
    ADD COLUMN IF NOT EXISTS answered_session_id UUID,
    ADD COLUMN IF NOT EXISTS answered_at         TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS progress_pct        SMALLINT;

-- Constraints added separately so the migration is safe to re-run.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backlog_completion_chk') THEN
        ALTER TABLE public.backlog_items
            ADD CONSTRAINT backlog_completion_chk
            CHECK (completion IN ('binary','progress'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backlog_answer_state_chk') THEN
        ALTER TABLE public.backlog_items
            ADD CONSTRAINT backlog_answer_state_chk
            CHECK (answer_state IN ('unanswered','partial','answered'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backlog_progress_pct_chk') THEN
        ALTER TABLE public.backlog_items
            ADD CONSTRAINT backlog_progress_pct_chk
            CHECK (progress_pct IS NULL OR (progress_pct BETWEEN 0 AND 100));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backlog_answered_run_fk') THEN
        ALTER TABLE public.backlog_items
            ADD CONSTRAINT backlog_answered_run_fk
            FOREIGN KEY (answered_run_id) REFERENCES public.runs(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backlog_answered_note_fk') THEN
        ALTER TABLE public.backlog_items
            ADD CONSTRAINT backlog_answered_note_fk
            FOREIGN KEY (answered_note_id) REFERENCES public.clip_notes(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'backlog_answered_session_fk') THEN
        ALTER TABLE public.backlog_items
            ADD CONSTRAINT backlog_answered_session_fk
            FOREIGN KEY (answered_session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS backlog_completion_idx ON public.backlog_items(team_id, completion, answer_state);

-- ── backlog_subtasks — checklist rows (for goals) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.backlog_subtasks (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    backlog_item_id    UUID NOT NULL REFERENCES public.backlog_items(id) ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm
    title              TEXT NOT NULL,
    done               BOOLEAN NOT NULL DEFAULT false,
    seq                INTEGER NOT NULL DEFAULT 0,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backlog_subtasks_item_idx ON public.backlog_subtasks(backlog_item_id, seq);
CREATE INDEX IF NOT EXISTS backlog_subtasks_team_boat_idx ON public.backlog_subtasks(team_id, boat_id);

-- ── updated_at triggers ──────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS session_blocks_touch ON public.session_blocks;
CREATE TRIGGER session_blocks_touch BEFORE UPDATE ON public.session_blocks
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS backlog_subtasks_touch ON public.backlog_subtasks;
CREATE TRIGGER backlog_subtasks_touch BEFORE UPDATE ON public.backlog_subtasks
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.session_blocks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backlog_subtasks ENABLE ROW LEVEL SECURITY;

-- session_blocks
DROP POLICY IF EXISTS session_blocks_select ON public.session_blocks;
DROP POLICY IF EXISTS session_blocks_insert ON public.session_blocks;
DROP POLICY IF EXISTS session_blocks_update ON public.session_blocks;
DROP POLICY IF EXISTS session_blocks_delete ON public.session_blocks;
CREATE POLICY session_blocks_select ON public.session_blocks FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));
CREATE POLICY session_blocks_insert ON public.session_blocks FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY session_blocks_update ON public.session_blocks FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY session_blocks_delete ON public.session_blocks FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach']));

-- backlog_subtasks
DROP POLICY IF EXISTS backlog_subtasks_select ON public.backlog_subtasks;
DROP POLICY IF EXISTS backlog_subtasks_insert ON public.backlog_subtasks;
DROP POLICY IF EXISTS backlog_subtasks_update ON public.backlog_subtasks;
DROP POLICY IF EXISTS backlog_subtasks_delete ON public.backlog_subtasks;
CREATE POLICY backlog_subtasks_select ON public.backlog_subtasks FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));
CREATE POLICY backlog_subtasks_insert ON public.backlog_subtasks FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY backlog_subtasks_update ON public.backlog_subtasks FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY backlog_subtasks_delete ON public.backlog_subtasks FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));

-- ── Grants ───────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.session_blocks   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backlog_subtasks TO authenticated;
REVOKE ALL ON public.session_blocks   FROM anon;
REVOKE ALL ON public.backlog_subtasks FROM anon;

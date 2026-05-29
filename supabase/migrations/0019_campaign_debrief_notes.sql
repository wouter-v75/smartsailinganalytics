-- ============================================================================
-- SSA Campaign Engine — 0019 debrief notes (day-level)
--
-- A per-session debrief record: free-text "Learnings" and "Next focus points",
-- plus a list of uploaded documents (stored in Bunny Storage; the JSONB holds
-- {key, name, bytes, content_type, uploaded_at, uploaded_by}).
--
-- Distinct from clip_notes (which pin to a video timestamp). A debrief is the
-- day's written wrap-up; clip_notes feed into it and promote to backlog_items.
--
-- RLS matches 0003. Idempotent. Run after 0018.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.debriefs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id         UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm
    learnings          TEXT,
    next_focus         TEXT,
    documents          JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS debriefs_team_boat_idx ON public.debriefs(team_id, boat_id);

DROP TRIGGER IF EXISTS debriefs_touch ON public.debriefs;
CREATE TRIGGER debriefs_touch BEFORE UPDATE ON public.debriefs
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.debriefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS debriefs_select ON public.debriefs;
DROP POLICY IF EXISTS debriefs_insert ON public.debriefs;
DROP POLICY IF EXISTS debriefs_update ON public.debriefs;
DROP POLICY IF EXISTS debriefs_delete ON public.debriefs;
CREATE POLICY debriefs_select ON public.debriefs FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, boat_id));
CREATE POLICY debriefs_insert ON public.debriefs FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY debriefs_update ON public.debriefs FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl1','tl2']));
CREATE POLICY debriefs_delete ON public.debriefs FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach']));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.debriefs TO authenticated;
REVOKE ALL ON public.debriefs FROM anon;

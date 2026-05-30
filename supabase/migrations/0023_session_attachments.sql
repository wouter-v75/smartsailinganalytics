-- ============================================================================
-- SSA Campaign Engine — 0023 session attachments
--
-- Generic per-session file attachments stored in Bunny Storage. Used first for
-- weather-forecast decks (uploaded as PDF, viewed inline / in a new window),
-- but kind-discriminated so debrief docs etc. can move here later.
--
--   kind ∈ weather | debrief | other
--   key  = Bunny Storage key; the app signs a short-lived URL to view it.
--
-- RLS matches 0003. Idempotent. Run after 0022.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.session_attachments (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id         UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
    team_id            UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,  -- denorm
    boat_id            UUID NOT NULL REFERENCES public.boats(id) ON DELETE CASCADE,  -- denorm
    kind               TEXT NOT NULL DEFAULT 'other'
                       CHECK (kind IN ('weather', 'debrief', 'other')),
    name               TEXT NOT NULL,
    key                TEXT NOT NULL,          -- Bunny Storage path
    bytes              BIGINT,
    content_type       TEXT,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_attachments_session_idx
    ON public.session_attachments(session_id, kind);
CREATE INDEX IF NOT EXISTS session_attachments_team_boat_idx
    ON public.session_attachments(team_id, boat_id);

ALTER TABLE public.session_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS session_attachments_select ON public.session_attachments;
DROP POLICY IF EXISTS session_attachments_insert ON public.session_attachments;
DROP POLICY IF EXISTS session_attachments_delete ON public.session_attachments;
-- Visible to TL1 and above (NOT guests). Consultants are additionally limited
-- to their authorised window because has_boat_access honours valid_from/_to.
CREATE POLICY session_attachments_select ON public.session_attachments FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR (
            public.has_boat_access(team_id, boat_id)
            AND public.has_team_role(team_id, ARRAY['coach','tl1','tl2','team_manager','consultant'])
        )
    );
-- Insert restricted to TL2 and above (coach / tl2 / team_manager); admin bypasses.
-- TL1 cannot upload attachments (e.g. weather forecasts).
CREATE POLICY session_attachments_insert ON public.session_attachments FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['coach','tl2','team_manager']));
CREATE POLICY session_attachments_delete ON public.session_attachments FOR DELETE TO authenticated
    USING (public.is_admin() OR public.own_or_coach(team_id, created_by_user_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.session_attachments TO authenticated;
REVOKE ALL ON public.session_attachments FROM anon;

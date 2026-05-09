-- ============================================================================
-- SSA — let consultants upload (within their time window).
--
-- Originally consultants were read-only. Real-world use shows that a
-- consultant (rigger, sailmaker, hired analyst) often takes photos /
-- videos themselves and contributes them to the team archive during their
-- engagement.
--
-- Behaviour:
--   - Consultants can INSERT sessions / videos / photos / mast_settings
--     while their valid_from..valid_to window is open. has_team_role()
--     already enforces the window, so we just add 'consultant' to the role
--     array — no extra time-check needed.
--   - Editing / deleting follows the existing rules: own rows + coach;
--     consultants automatically get to edit their own uploads via the
--     own_or_coach() helper since auth.uid() = created_by_user_id.
--   - After their window expires, RLS denies SELECT, so they can no longer
--     see (or edit) anything they uploaded — but the data persists in the
--     team archive.
--
-- Run after 0006. Idempotent.
-- ============================================================================

-- ── sessions ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS sessions_insert ON public.sessions;
CREATE POLICY sessions_insert ON public.sessions
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'consultant'])
    );

-- ── videos ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS videos_insert ON public.videos;
CREATE POLICY videos_insert ON public.videos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'consultant'])
    );

-- ── photos ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS photos_insert ON public.photos;
CREATE POLICY photos_insert ON public.photos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'consultant'])
    );

-- ── mast_settings ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS mast_settings_insert ON public.mast_settings;
CREATE POLICY mast_settings_insert ON public.mast_settings
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'consultant'])
    );

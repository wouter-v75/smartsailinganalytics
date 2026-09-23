-- Uploads are tl3 and up. tl1 and tl2 lose them.
--
-- 0079 fixed an omission — tl3 could not upload at all, while tl1 could — by
-- adding tl3 to the list. This decides the shape of the list instead of
-- inheriting it: putting a day into the archive is a senior job, so the roles
-- that may do it are tl3, coach and admin.
--
-- THIS IS A NARROWING. tl1 and tl2 could upload photos, videos, logs and event
-- files since 0003, and can no longer. Anyone currently doing it on a tl1 or tl2
-- membership needs moving to tl3 — which is the right answer anyway: a squad
-- sailor who uploads their own track is exactly who tl3 is for.
--
-- WHAT COUNTS AS AN UPLOAD. `sessions` carries BOTH the log file (log_data) and
-- the event file (xml_data), so gating that one insert covers both. Videos and
-- photos are their own tables. mast_settings rides along because it is written
-- by the same import.
--
-- STILL DELIBERATELY UNCHANGED:
--   team_manager  — excluded since 0007. A team_manager who also sails holds a
--                   second membership (typically coach or tl3) for that.
--   consultant    — granted in 0007 on purpose and bounded by valid_from /
--                   valid_to, so access ends by itself. A sailmaker who cannot
--                   upload the scan they came to take is no use, and the date
--                   window is the control, not the role.
--   update/delete — sessions_update et al. name no roles; they use
--                   own_or_coach(team_id, created_by_user_id), so the person who
--                   created a row may still fix it and a coach may fix anyone's.

-- ── sessions (log file + event file) ────────────────────────────────────────
DROP POLICY IF EXISTS sessions_insert ON public.sessions;
CREATE POLICY sessions_insert ON public.sessions
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'consultant'])
    );

-- ── videos ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS videos_insert ON public.videos;
CREATE POLICY videos_insert ON public.videos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'consultant'])
    );

-- ── photos ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS photos_insert ON public.photos;
CREATE POLICY photos_insert ON public.photos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'consultant'])
    );

-- ── mast_settings ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS mast_settings_insert ON public.mast_settings;
CREATE POLICY mast_settings_insert ON public.mast_settings
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'consultant'])
    );

COMMENT ON POLICY sessions_insert ON public.sessions IS
    'Upload roles: admin, coach, tl3, consultant (date-bounded). tl1/tl2 removed in 0080; team_manager excluded since 0007.';

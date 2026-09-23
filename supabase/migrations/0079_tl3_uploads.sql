-- tl3 can upload. It always should have been able to.
--
-- THE BUG. `tl3` was added in migration 0025 as the SENIOR sailing role — it got
-- campaign write, session edits and Boat Config alongside coach and
-- team_manager. What 0025 did not do was revisit the upload policies from 0003
-- and 0007, which name their roles explicitly:
--
--     has_team_role(team_id, ARRAY['coach', 'tl1', 'tl2', 'consultant'])
--
-- So a tl3 — who may rewrite the campaign plan and edit the boat's rig — could
-- not add a photo, while a tl1 could. Nobody noticed because the Upload tab's
-- UI gate reads a legacy dev role-switcher that defaults to "coach" rather than
-- the real membership, so the control was offered and the failure only happened
-- at the database.
--
-- WHY IT MATTERS NOW. On the dinghy side a coach does not hold every sailor's
-- Vakaros; the sailors do. Getting a squad's day into SSA means each sailor
-- uploading their own track to their own boat, so the roles a squad actually
-- hands out have to include upload. tl3 is the role a squad gives its senior
-- sailors, and it was the one role that could not.
--
-- WHAT THIS DOES NOT DO. team_manager stays out, deliberately and unchanged:
-- docs/auth/permissions.md records that a team_manager who also sails holds a
-- second membership (typically tl2 or coach) for that. Widening it here would
-- quietly reverse a decision someone made on purpose. Nothing else about tl3's
-- permissions elsewhere in the schema is touched — see the note at the bottom.

-- ── sessions ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS sessions_insert ON public.sessions;
CREATE POLICY sessions_insert ON public.sessions
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'tl1', 'tl2', 'consultant'])
    );

-- ── videos ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS videos_insert ON public.videos;
CREATE POLICY videos_insert ON public.videos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'tl1', 'tl2', 'consultant'])
    );

-- ── photos ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS photos_insert ON public.photos;
CREATE POLICY photos_insert ON public.photos
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'tl1', 'tl2', 'consultant'])
    );

-- ── mast_settings ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS mast_settings_insert ON public.mast_settings;
CREATE POLICY mast_settings_insert ON public.mast_settings
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach', 'tl3', 'tl1', 'tl2', 'consultant'])
    );

-- ── editing what you uploaded: already correct, left alone ─────────────────
-- sessions_update / videos_update / photos_update do NOT name roles. They use
-- own_or_coach(team_id, created_by_user_id), which is
--     auth.uid() = creator  OR  has_team_role(team_id, ARRAY['coach'])
-- so whoever created a row may already fix it, whatever their role. Nothing to
-- widen here, and adding a role list would have narrowed it.

COMMENT ON POLICY sessions_insert ON public.sessions IS
    'Upload roles: coach, tl3, tl1, tl2, consultant (window-bounded), admin. team_manager is deliberately excluded — see docs/auth/permissions.md.';

-- ── STILL OUTSTANDING, ON PURPOSE ───────────────────────────────────────────
-- tl3 is missing from role lists in 0015, 0016, 0017 and 0019 too (campaign
-- spine, debrief backlog, debrief notes, manoeuvre events), which all name
-- ARRAY['coach','tl1','tl2']. That is the same omission with a wider blast
-- radius, and widening write access across the campaign tables is a decision to
-- take deliberately rather than as a side effect of fixing uploads. Left for a
-- separate, reviewed change.

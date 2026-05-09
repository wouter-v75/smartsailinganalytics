-- ============================================================================
-- SSA — add `team_manager` role.
--
-- team_manager is the per-team operations role: manages boats, memberships,
-- and team rename. They do NOT write data (sessions/photos/videos) — for
-- that they need a separate sailing-side membership (coach / tl2 / tl1).
--
-- This migration:
--   1. Extends memberships.role CHECK to allow 'team_manager'.
--   2. Shifts boats CRUD from coach → team_manager.
--   3. Shifts memberships CRUD from admin-only → admin or team_manager.
--   4. Lets team_manager rename their team (not delete).
--   5. Lets team_manager curate tag_lists.
--
-- Run after 0003. Idempotent.
-- ============================================================================

-- ── 1. Extend the role CHECK on memberships ─────────────────────────────────
ALTER TABLE public.memberships
    DROP CONSTRAINT IF EXISTS memberships_role_check;

ALTER TABLE public.memberships
    ADD CONSTRAINT memberships_role_check
    CHECK (role IN ('team_manager', 'coach', 'tl1', 'tl2', 'consultant'));

-- ── 2. boats — shift management from coach to team_manager ─────────────────
DROP POLICY IF EXISTS boats_insert ON public.boats;
DROP POLICY IF EXISTS boats_update ON public.boats;
DROP POLICY IF EXISTS boats_delete ON public.boats;

CREATE POLICY boats_insert ON public.boats
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager'])
    );

CREATE POLICY boats_update ON public.boats
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager'])
    )
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager'])
    );

CREATE POLICY boats_delete ON public.boats
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager'])
    );

-- ── 3. memberships — let team_manager manage their team's memberships ──────
DROP POLICY IF EXISTS memberships_select_self  ON public.memberships;
DROP POLICY IF EXISTS memberships_select_admin ON public.memberships;
DROP POLICY IF EXISTS memberships_select_coach ON public.memberships;
DROP POLICY IF EXISTS memberships_select_manager ON public.memberships;
DROP POLICY IF EXISTS memberships_insert_admin ON public.memberships;
DROP POLICY IF EXISTS memberships_insert ON public.memberships;
DROP POLICY IF EXISTS memberships_update_admin ON public.memberships;
DROP POLICY IF EXISTS memberships_update ON public.memberships;
DROP POLICY IF EXISTS memberships_delete_admin ON public.memberships;
DROP POLICY IF EXISTS memberships_delete ON public.memberships;

-- SELECT: own + admin + team_manager sees their team's memberships.
-- (Coach loses team-wide membership visibility — they don't need it
-- operationally, so removing the policy here closes a small leak.)
CREATE POLICY memberships_select_self ON public.memberships
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY memberships_select_admin ON public.memberships
    FOR SELECT TO authenticated
    USING (public.is_admin());

CREATE POLICY memberships_select_manager ON public.memberships
    FOR SELECT TO authenticated
    USING (public.has_team_role(team_id, ARRAY['team_manager']));

-- INSERT / UPDATE / DELETE — admin OR team_manager.
-- We deliberately allow team_manager to manage team_manager memberships
-- too: this matches "an owner can hire a co-manager and step back" while
-- keeping admin as the global escape hatch.
CREATE POLICY memberships_insert ON public.memberships
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager'])
    );

CREATE POLICY memberships_update ON public.memberships
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager'])
    )
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager'])
    );

CREATE POLICY memberships_delete ON public.memberships
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager'])
    );

-- ── 4. teams — let team_manager rename (not delete) ────────────────────────
DROP POLICY IF EXISTS teams_update ON public.teams;

CREATE POLICY teams_update ON public.teams
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(id, ARRAY['team_manager'])
    )
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(id, ARRAY['team_manager'])
    );

-- (teams_delete unchanged — admin only, intentionally.)

-- ── 5. tag_lists — let team_manager curate as well ─────────────────────────
DROP POLICY IF EXISTS tag_lists_insert ON public.tag_lists;
DROP POLICY IF EXISTS tag_lists_update ON public.tag_lists;
DROP POLICY IF EXISTS tag_lists_delete ON public.tag_lists;

CREATE POLICY tag_lists_insert ON public.tag_lists
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager', 'coach', 'tl2'])
    );

CREATE POLICY tag_lists_update ON public.tag_lists
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager', 'coach', 'tl2'])
    )
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager', 'coach', 'tl2'])
    );

CREATE POLICY tag_lists_delete ON public.tag_lists
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['team_manager', 'coach'])
    );

-- ── 6. set_quota_for_role — extend with team_manager ───────────────────────
-- 0001 defined this for the original five roles. Re-create with the new
-- role added (idempotent — CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION public.set_quota_for_role(p_user_id UUID, p_role TEXT)
RETURNS BIGINT AS $$
DECLARE
    new_limit BIGINT;
BEGIN
    new_limit := CASE p_role
        WHEN 'admin'        THEN NULL
        WHEN 'team_manager' THEN  5::BIGINT * 1024 * 1024 * 1024
        WHEN 'coach'        THEN 50::BIGINT * 1024 * 1024 * 1024
        WHEN 'tl2'          THEN 10::BIGINT * 1024 * 1024 * 1024
        WHEN 'tl1'          THEN  5::BIGINT * 1024 * 1024 * 1024
        WHEN 'consultant'   THEN  5::BIGINT * 1024 * 1024 * 1024
        ELSE 5::BIGINT * 1024 * 1024 * 1024
    END;
    UPDATE public.user_quota
       SET bytes_limit = new_limit,
           warned_80   = FALSE,
           warned_100  = FALSE,
           updated_at  = now()
     WHERE user_id = p_user_id;
    RETURN new_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

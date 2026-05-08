-- ============================================================================
-- SSA L1.0 — Row-Level Security policies
--
-- All public.* tables are RLS-protected. The Supabase service-role key (used
-- only by server-side admin RPCs / migration scripts) bypasses RLS; the
-- anon/authed clients always go through these policies.
--
-- Conventions
--   auth.uid()          → the calling user's UUID
--   is_admin()          → helper, true if users.global_role = 'admin'
--   is_team_member()    → helper, true if user has any membership for team
--   is_team_role()      → helper, true if user has a specific role on a team
--   is_active_membership() → helper, false for consultants whose window has
--                            elapsed (or hasn't started yet)
--
-- Policy style: separate SELECT / INSERT / UPDATE / DELETE policies per
-- table for clarity; combine where the predicate is identical.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- Helper functions. SECURITY DEFINER so they can read public.users and
-- memberships without recursive RLS evaluation. STABLE so the planner can
-- cache results within a single statement.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.users
         WHERE id = auth.uid()
           AND status = 'active'
           AND global_role = 'admin'
    );
$$;

CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.users
         WHERE id = auth.uid() AND status = 'active'
    );
$$;

-- True if the current user has *any* membership in the given team where the
-- valid_from/valid_to window is currently open. Consultants outside their
-- window return false.
CREATE OR REPLACE FUNCTION public.is_team_member(p_team_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.memberships m
         WHERE m.user_id = auth.uid()
           AND m.team_id = p_team_id
           AND (m.valid_from IS NULL OR m.valid_from <= now())
           AND (m.valid_to   IS NULL OR m.valid_to   >= now())
    );
$$;

-- True if the current user has membership in the given team with any of the
-- specified roles, with the validity window currently open.
CREATE OR REPLACE FUNCTION public.has_team_role(p_team_id UUID, p_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.memberships m
         WHERE m.user_id = auth.uid()
           AND m.team_id = p_team_id
           AND m.role = ANY (p_roles)
           AND (m.valid_from IS NULL OR m.valid_from <= now())
           AND (m.valid_to   IS NULL OR m.valid_to   >= now())
    );
$$;

-- True if the current user can access (team_id, boat_id) — either via a
-- membership scoped to that boat, or a team-wide membership (boat_id NULL).
CREATE OR REPLACE FUNCTION public.has_boat_access(p_team_id UUID, p_boat_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.memberships m
         WHERE m.user_id = auth.uid()
           AND m.team_id = p_team_id
           AND (m.boat_id IS NULL OR m.boat_id = p_boat_id)
           AND (m.valid_from IS NULL OR m.valid_from <= now())
           AND (m.valid_to   IS NULL OR m.valid_to   >= now())
    );
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- Enable RLS on every public table.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.boats        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_quota   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events       ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────────────────────
-- public.users
--   - Each user can SELECT and UPDATE their own row (limited columns; we
--     don't lock columns at the policy level, but the client only exposes
--     name/last_seen_at edits).
--   - Admin can SELECT/UPDATE every row (used for the approval queue).
--   - INSERT is performed by the on_auth_user_created trigger which runs as
--     SECURITY DEFINER, so it bypasses RLS — no user-level INSERT policy.
--   - DELETE is admin-only.
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS users_select_self    ON public.users;
DROP POLICY IF EXISTS users_select_admin   ON public.users;
DROP POLICY IF EXISTS users_select_teammate ON public.users;
DROP POLICY IF EXISTS users_update_self    ON public.users;
DROP POLICY IF EXISTS users_update_admin   ON public.users;
DROP POLICY IF EXISTS users_delete_admin   ON public.users;

CREATE POLICY users_select_self ON public.users
    FOR SELECT TO authenticated
    USING (id = auth.uid());

CREATE POLICY users_select_admin ON public.users
    FOR SELECT TO authenticated
    USING (public.is_admin());

-- Teammates see each other's basic profile (name + email) so a coach can see
-- who's on the team. Predicate: exists a membership row pairing me with this
-- user via the same team.
CREATE POLICY users_select_teammate ON public.users
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1
              FROM public.memberships ma
              JOIN public.memberships mb USING (team_id)
             WHERE ma.user_id = auth.uid()
               AND mb.user_id = public.users.id
               AND (ma.valid_from IS NULL OR ma.valid_from <= now())
               AND (ma.valid_to   IS NULL OR ma.valid_to   >= now())
        )
    );

CREATE POLICY users_update_self ON public.users
    FOR UPDATE TO authenticated
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());

CREATE POLICY users_update_admin ON public.users
    FOR UPDATE TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

CREATE POLICY users_delete_admin ON public.users
    FOR DELETE TO authenticated
    USING (public.is_admin());

-- ────────────────────────────────────────────────────────────────────────────
-- public.teams
--   - SELECT: members of the team OR admin.
--   - INSERT: admin only.
--   - UPDATE: admin only.
--   - DELETE: admin only.
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS teams_select ON public.teams;
DROP POLICY IF EXISTS teams_insert ON public.teams;
DROP POLICY IF EXISTS teams_update ON public.teams;
DROP POLICY IF EXISTS teams_delete ON public.teams;

CREATE POLICY teams_select ON public.teams
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.is_team_member(id));

CREATE POLICY teams_insert ON public.teams
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin());

CREATE POLICY teams_update ON public.teams
    FOR UPDATE TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

CREATE POLICY teams_delete ON public.teams
    FOR DELETE TO authenticated
    USING (public.is_admin());

-- ────────────────────────────────────────────────────────────────────────────
-- public.boats
--   - SELECT: anyone with access to the team (membership window applies).
--   - INSERT/UPDATE/DELETE: admin OR team coach.
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS boats_select  ON public.boats;
DROP POLICY IF EXISTS boats_insert  ON public.boats;
DROP POLICY IF EXISTS boats_update  ON public.boats;
DROP POLICY IF EXISTS boats_delete  ON public.boats;

CREATE POLICY boats_select ON public.boats
    FOR SELECT TO authenticated
    USING (public.is_admin() OR public.has_boat_access(team_id, id));

CREATE POLICY boats_insert ON public.boats
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach'])
    );

CREATE POLICY boats_update ON public.boats
    FOR UPDATE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach'])
    )
    WITH CHECK (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach'])
    );

CREATE POLICY boats_delete ON public.boats
    FOR DELETE TO authenticated
    USING (
        public.is_admin()
        OR public.has_team_role(team_id, ARRAY['coach'])
    );

-- ────────────────────────────────────────────────────────────────────────────
-- public.memberships
--   - SELECT: own memberships + admin sees all + coach sees their team's.
--   - INSERT/UPDATE/DELETE: admin only. Coaches do NOT manage memberships
--     directly; they request changes via admin. Keeps approval flow tight.
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS memberships_select_self  ON public.memberships;
DROP POLICY IF EXISTS memberships_select_admin ON public.memberships;
DROP POLICY IF EXISTS memberships_select_coach ON public.memberships;
DROP POLICY IF EXISTS memberships_insert_admin ON public.memberships;
DROP POLICY IF EXISTS memberships_update_admin ON public.memberships;
DROP POLICY IF EXISTS memberships_delete_admin ON public.memberships;

CREATE POLICY memberships_select_self ON public.memberships
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY memberships_select_admin ON public.memberships
    FOR SELECT TO authenticated
    USING (public.is_admin());

CREATE POLICY memberships_select_coach ON public.memberships
    FOR SELECT TO authenticated
    USING (public.has_team_role(team_id, ARRAY['coach']));

CREATE POLICY memberships_insert_admin ON public.memberships
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin());

CREATE POLICY memberships_update_admin ON public.memberships
    FOR UPDATE TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

CREATE POLICY memberships_delete_admin ON public.memberships
    FOR DELETE TO authenticated
    USING (public.is_admin());

-- ────────────────────────────────────────────────────────────────────────────
-- public.user_quota
--   - SELECT: own row + admin.
--   - UPDATE: admin only. (App reads via RPC and the server-side upload
--     handler increments via SECURITY DEFINER function — TBD in L4.)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS user_quota_select_self  ON public.user_quota;
DROP POLICY IF EXISTS user_quota_select_admin ON public.user_quota;
DROP POLICY IF EXISTS user_quota_update_admin ON public.user_quota;

CREATE POLICY user_quota_select_self ON public.user_quota
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY user_quota_select_admin ON public.user_quota
    FOR SELECT TO authenticated
    USING (public.is_admin());

CREATE POLICY user_quota_update_admin ON public.user_quota
    FOR UPDATE TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- ────────────────────────────────────────────────────────────────────────────
-- public.events
--   - SELECT: own events + admin sees all.
--   - INSERT: any active user can append events for themselves (used by
--     client-side audit trail). admin can insert for anyone.
--   - UPDATE/DELETE: admin only (audit log is append-only otherwise).
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS events_select_self  ON public.events;
DROP POLICY IF EXISTS events_select_admin ON public.events;
DROP POLICY IF EXISTS events_insert_self  ON public.events;
DROP POLICY IF EXISTS events_insert_admin ON public.events;
DROP POLICY IF EXISTS events_update_admin ON public.events;
DROP POLICY IF EXISTS events_delete_admin ON public.events;

CREATE POLICY events_select_self ON public.events
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY events_select_admin ON public.events
    FOR SELECT TO authenticated
    USING (public.is_admin());

CREATE POLICY events_insert_self ON public.events
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid() AND public.is_active_user()
    );

CREATE POLICY events_insert_admin ON public.events
    FOR INSERT TO authenticated
    WITH CHECK (public.is_admin());

CREATE POLICY events_update_admin ON public.events
    FOR UPDATE TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

CREATE POLICY events_delete_admin ON public.events
    FOR DELETE TO authenticated
    USING (public.is_admin());

-- ────────────────────────────────────────────────────────────────────────────
-- Grants. authenticated role gets table-level USAGE; RLS policies above are
-- the actual access gate. anon role gets NOTHING — the app forces login.
-- ────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.teams        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.boats        TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memberships  TO authenticated;
GRANT SELECT, UPDATE                 ON public.user_quota   TO authenticated;
GRANT SELECT, INSERT                 ON public.events       TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.events_id_seq        TO authenticated;

REVOKE ALL ON public.users        FROM anon;
REVOKE ALL ON public.teams        FROM anon;
REVOKE ALL ON public.boats        FROM anon;
REVOKE ALL ON public.memberships  FROM anon;
REVOKE ALL ON public.user_quota   FROM anon;
REVOKE ALL ON public.events       FROM anon;

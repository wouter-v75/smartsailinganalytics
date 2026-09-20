-- 0073_squad_policy_recursion.sql
-- ---------------------------------------------------------------------------
-- Fix: "infinite recursion detected in policy for relation squad_members".
--
-- 0071 gave squad_members a SELECT policy that reads squad_members:
--
--     USING (... EXISTS (SELECT 1 FROM squad_members mine
--                         WHERE mine.squad_id = squad_members.squad_id ...))
--
-- Evaluating that policy requires evaluating it again, and Postgres refuses.
-- squads_select has the same shape one table over: it reads squad_members,
-- which triggers the recursive policy. So BOTH failed, and GET /api/squads
-- returned 500 every time.
--
-- WHAT THIS BROKE, which is more than it looks. squadsForTeam() treats a
-- non-ok response as "this team is in no squad" — correct behaviour for a
-- team that genuinely is not, and indistinguishable from this. So the upload
-- tick-box, the Analytics share toggle and the squad panel all silently
-- rendered NOTHING, for everybody, since 0071. The feature looked absent
-- rather than broken, which is why it survived a manual test.
--
-- It went unnoticed because every check I ran against the squad tables used
-- the SERVICE KEY, which bypasses RLS entirely. A policy bug is invisible to
-- the one credential that never evaluates policies.
--
-- THE FIX is the pattern the rest of this schema already uses: a SECURITY
-- DEFINER helper reads the table as its owner, so no policy is evaluated and
-- there is nothing to recurse into. has_boat_access, has_team_role and
-- shares_squad_with all work this way.
-- ---------------------------------------------------------------------------

-- Squads the caller can see, by virtue of a role in one of their member teams.
-- SETOF rather than a boolean so both policies can use it as an IN-list, and
-- so it costs one scan instead of one per row.
CREATE OR REPLACE FUNCTION public.my_squad_ids()
RETURNS SETOF UUID
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT sm.squad_id
      FROM public.squad_members sm
     WHERE public.has_team_role(sm.team_id,
             ARRAY['coach','tl1','tl2','tl3','team_manager','owner','consultant']);
$$;

-- Any status, deliberately: a team that has been INVITED must be able to see
-- the squad it is being asked to join, and who is already in it. That was the
-- intent of 0071's policies and is preserved here.
DROP POLICY IF EXISTS squad_members_select ON public.squad_members;
CREATE POLICY squad_members_select ON public.squad_members
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR squad_id IN (SELECT public.my_squad_ids())
    );

DROP POLICY IF EXISTS squads_select ON public.squads;
CREATE POLICY squads_select ON public.squads
    FOR SELECT TO authenticated
    USING (
        public.is_admin()
        OR id IN (SELECT public.my_squad_ids())
    );

-- squad_members_write is untouched: it tests has_team_role(team_id, …), which
-- reads memberships and not squad_members, so it never recursed.

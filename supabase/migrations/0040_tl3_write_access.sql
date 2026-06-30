-- ============================================================================
-- SSA — give TL3 the same write access as TL1/TL2.
--
-- TL3 is the most SENIOR of the team-lead roles (ordering: team_manager →
-- coach → tl3 → tl2 → tl1), so anywhere a tl1/tl2 may write, a tl3 must be
-- able to write too. Rather than DROP/CREATE the ~30 write policies scattered
-- across many migrations (sessions/videos/photos/mast_settings, sail_scans,
-- campaign spine/backlog/debrief/manoeuvres/plan, session_attachments, …), we
-- extend the single shared gate `has_team_role()`: a tl3 membership now passes
-- ANY role check whose role list includes 'tl1' or 'tl2'. This grants tl3
-- exactly the union of tl1/tl2 write access and nothing more (it does NOT pass
-- coach-/team_manager-only checks).
--
-- Idempotent — CREATE OR REPLACE. Run after the latest migration.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.has_team_role(p_team_id UUID, p_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.memberships m
         WHERE m.user_id = auth.uid()
           AND m.team_id = p_team_id
           AND (
                 m.role = ANY (p_roles)
                 -- tl3 ≥ tl2 ≥ tl1: a tl3 passes any gate that admits tl1/tl2.
                 OR (m.role = 'tl3' AND (p_roles && ARRAY['tl1', 'tl2']))
               )
           AND (m.valid_from IS NULL OR m.valid_from <= now())
           AND (m.valid_to   IS NULL OR m.valid_to   >= now())
    );
$$;

-- Note on quota: the set-quota CASE has no explicit tl3 branch, so tl3 falls
-- through to the 5 GB ELSE default — uploads are NOT blocked. (Bump it later if
-- a tl3 needs more headroom.)

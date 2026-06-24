-- ============================================================================
-- SSA Boat Config — 0037 align sail_scans write access with the TL3+ gate
--
-- The North-scan import lives in the Boat Config tab (TL3+). 0035 gave
-- sail_scans write to coach/tl1/tl2, which blocks tl3 + team_manager. Realign
-- the write policies to the same leadership set used for sails (0036).
-- Additive, idempotent. Run after 0036.
-- ============================================================================

DROP POLICY IF EXISTS sail_scans_insert ON public.sail_scans;
DROP POLICY IF EXISTS sail_scans_update ON public.sail_scans;
DROP POLICY IF EXISTS sail_scans_delete ON public.sail_scans;

CREATE POLICY sail_scans_insert ON public.sail_scans FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));
CREATE POLICY sail_scans_update ON public.sail_scans FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));
CREATE POLICY sail_scans_delete ON public.sail_scans FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));

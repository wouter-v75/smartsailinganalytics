-- ============================================================================
-- SSA Boat Config — 0038 align polars write access with the TL3+ gate
--
-- Polars (target/VPP reference) are imported + activated from the Boat Config
-- tab (TL3+). 0035 gave polars write to coach/tl1/tl2, which blocks tl3 +
-- team_manager and (via own_or_coach on UPDATE) stops a leader from
-- deactivating a polar someone else created. Realign all writes to the same
-- leadership set used for sails/sail_scans (0036/0037).
--
-- Additive, idempotent. Run after 0037.
-- ============================================================================

DROP POLICY IF EXISTS polars_insert ON public.polars;
DROP POLICY IF EXISTS polars_update ON public.polars;
DROP POLICY IF EXISTS polars_delete ON public.polars;

CREATE POLICY polars_insert ON public.polars FOR INSERT TO authenticated
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));
CREATE POLICY polars_update ON public.polars FOR UPDATE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']))
    WITH CHECK (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));
CREATE POLICY polars_delete ON public.polars FOR DELETE TO authenticated
    USING (public.is_admin() OR public.has_team_role(team_id, ARRAY['team_manager','coach','tl3']));
